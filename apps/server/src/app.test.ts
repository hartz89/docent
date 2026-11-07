import { hc } from 'hono/client';
import { describe, expect, test } from 'vitest';
import { type AppType, createApp } from './app.ts';

const origin = 'http://127.0.0.1:4123';
const token = 'test-token';
const app = createApp({ origin, token, version: '1.2.3' });

/** The same typed client the web app uses, wired straight to the app with no real port. */
const client = (headers: Record<string, string> = {}) =>
  hc<AppType>(origin, { fetch: app.request, headers });

const signedIn = { Authorization: `Bearer ${token}` };

describe('GET /api/health', () => {
  test('answers a signed-in request from our own page', async () => {
    const res = await client({ ...signedIn, Origin: origin }).api.health.$get();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: '1.2.3' });
  });

  test('rejects a request with no token', async () => {
    const res = await client().api.health.$get();

    expect(res.status).toBe(401);
  });

  test('rejects a request with the wrong token', async () => {
    const res = await client({ Authorization: 'Bearer not-the-token' }).api.health.$get();

    expect(res.status).toBe(401);
  });
});

describe('only our own localhost origin may call the server', () => {
  test('rejects a request sent from another website', async () => {
    const res = await client({ ...signedIn, Origin: 'https://evil.example' }).api.health.$get();

    expect(res.status).toBe(403);
  });

  test('rejects another local dev server on a different port', async () => {
    const res = await client({ ...signedIn, Origin: 'http://127.0.0.1:5173' }).api.health.$get();

    expect(res.status).toBe(403);
  });

  test('rejects a DNS-rebound request, where an outside name points at 127.0.0.1', async () => {
    const res = await app.request('http://evil.example:4123/api/health', { headers: signedIn });

    expect(res.status).toBe(403);
  });
});
