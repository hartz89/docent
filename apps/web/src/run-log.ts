// Reports to the run log on the server: the page's own errors, failed API requests, and a few
// screen events (which stop is open, the window width bucket, the theme). Never keystrokes, mouse
// movement, or the page URL. Reporting is best effort: if it fails, nothing else notices.

type ClientEvent =
  | {
      kind: 'client.error';
      source: 'window' | 'promise' | 'api';
      message: string;
      stack?: string;
      method?: string;
      path?: string;
      status?: number;
    }
  | { kind: 'ui.stop'; stop: number; stopId: string }
  | { kind: 'ui.viewport'; width: '<640' | '640-1023' | '1024-1439' | '1440+' }
  | { kind: 'ui.theme'; theme: 'light' | 'dark'; choice: 'light' | 'dark' | 'system' };

let token: string | null = null;
/** Events reported before the token is known, like the theme at load. Sent once it is. */
const early: ClientEvent[] = [];
/** At most this many reports per page load, well under the server's own limit. */
let budget = 200;

/** Sends one event. Uses plain fetch, so a failed report is never itself reported. */
export function report(event: ClientEvent) {
  if (token === null) {
    if (early.length < 20) early.push(event);
    return;
  }
  if (!token || budget <= 0) return;
  budget--;
  void fetch('/api/client-log', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
    keepalive: true,
  }).catch(() => {});
}

const line = (text: string, max: number) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
  text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, max);

function reportError(source: 'window' | 'promise', error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : error ? String(error) : fallback;
  report({
    kind: 'client.error',
    source,
    message: line(message || fallback, 1000),
    ...(error instanceof Error && error.stack ? { stack: error.stack.slice(0, 4000) } : {}),
  });
}

/** Starts reporting: errors, unhandled rejections, and the window width bucket as it changes. */
export function startReporting(apiToken: string) {
  token = apiToken;
  for (const event of early.splice(0)) report(event);
  window.addEventListener('error', (event) => reportError('window', event.error, event.message));
  window.addEventListener('unhandledrejection', (event) =>
    reportError('promise', event.reason, 'Unhandled promise rejection'),
  );
  let last: string | null = null;
  const viewport = () => {
    const width = widthBucket(window.innerWidth);
    if (width === last) return;
    last = width;
    report({ kind: 'ui.viewport', width });
  };
  viewport();
  let timer: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(viewport, 500);
  });
}

function widthBucket(px: number) {
  if (px < 640) return '<640' as const;
  if (px < 1024) return '640-1023' as const;
  if (px < 1440) return '1024-1439' as const;
  return '1440+' as const;
}

/**
 * A fetch for the API client that reports failed requests: network errors and 5xx answers, plus
 * 4xx answers other than the expected 404 when no review is open. Only the method, the path
 * (never the query) and the status are sent, with the server's error message if it gave one.
 */
export const reportingFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const { pathname } = new URL(request.url);
  const where = { method: request.method, path: line(pathname, 300) };
  try {
    const res = await fetch(request);
    const expected = res.status === 404 && pathname === '/api/review';
    if (!res.ok && !expected) {
      const body = (await res
        .clone()
        .json()
        .catch(() => null)) as { error?: unknown } | null;
      const message = typeof body?.error === 'string' ? body.error : res.statusText;
      report({
        kind: 'client.error',
        source: 'api',
        message: line(message || `HTTP ${res.status}`, 1000),
        ...where,
        status: res.status,
      });
    }
    return res;
  } catch (error) {
    if (!request.signal.aborted) {
      report({ kind: 'client.error', source: 'api', message: line(String(error), 1000), ...where });
    }
    throw error;
  }
};
