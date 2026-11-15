import type { AppType, TourState } from '@docent/server';
import { hc } from 'hono/client';
import { reportingFetch, startReporting } from './run-log.ts';

/**
 * How the browser gets the API token: the server prints a startup URL like
 * http://127.0.0.1:4123/#token=abc. The token lives in the URL fragment, which
 * browsers never send to servers, so it stays out of request logs and Referer
 * headers. It works the same in dev (Vite serves the page) and in production
 * (our server serves it), with no HTML templating. On load we move it into
 * sessionStorage, so a reload keeps working, and wipe it from the address bar.
 */
function takeToken(): string {
  const fromUrl = new URLSearchParams(window.location.hash.slice(1)).get('token');
  if (fromUrl) {
    sessionStorage.setItem('docent-token', fromUrl);
    history.replaceState(null, '', window.location.pathname + window.location.search);
    return fromUrl;
  }
  return sessionStorage.getItem('docent-token') ?? '';
}

type Client = ReturnType<typeof hc<AppType>>;

const token = takeToken();
startReporting(token);

export const api: Client['api'] = hc<AppType>(window.location.origin, {
  headers: { Authorization: `Bearer ${token}` },
  fetch: reportingFetch,
}).api;

/**
 * A file's text at head (`new`) or base (`old`). Shared, so the code view and the definition
 * popover's previews read one cached copy.
 */
export const fileTextQuery = (path: string, side: 'old' | 'new') => ({
  queryKey: ['file', side, path],
  queryFn: async (): Promise<string> => {
    const res = await api.file.$get({ query: { path, side } });
    if (res.status !== 200) {
      const body = (await res.json()) as { error?: string };
      throw new Error(body.error ?? `The server answered ${res.status}`);
    }
    return (await res.json()).text;
  },
  staleTime: Number.POSITIVE_INFINITY,
});

/**
 * Follows the tour's progress over server-sent events. EventSource can't send the bearer token,
 * so this reads the stream through fetch instead. Resolves when the server closes the stream.
 */
export async function followTour(
  onState: (state: TourState) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await api.review.events.$get(undefined, { init: { signal } });
  if (!res.ok || !res.body) throw new Error(`Progress stream answered ${res.status}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let end = buffer.indexOf('\n\n');
    while (end !== -1) {
      const data = buffer
        .slice(0, end)
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      buffer = buffer.slice(end + 2);
      if (data) onState(JSON.parse(data) as TourState);
      end = buffer.indexOf('\n\n');
    }
  }
}
