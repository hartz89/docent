import type { AppType } from '@docent/server';
import { hc } from 'hono/client';

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

export const api = hc<AppType>(window.location.origin, {
  headers: { Authorization: `Bearer ${takeToken()}` },
}).api;
