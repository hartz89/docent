import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { createMiddleware } from 'hono/factory';

export type AppOptions = {
  /** Per-launch secret. Every /api request must send it as a bearer token. */
  token: string;
  /** The server's own origin, like http://127.0.0.1:4123. No other origin may call us. */
  origin: string;
  version: string;
  /** Folder holding the built web app. Leave it out in dev, where Vite serves the app. */
  webRoot?: string;
};

export function createApp({ token, origin, version, webRoot }: AppOptions) {
  const app = new Hono()
    .use(ownOriginOnly(origin))
    .use('/api/*', bearerAuth({ token }))
    .get('/api/health', (c) => c.json({ ok: true, version }));

  if (webRoot) {
    app.use('/*', serveStatic({ root: webRoot }));
  }
  return app;
}

/** The app's route types, for Hono's typed client: `hc<AppType>(url)`. */
export type AppType = ReturnType<typeof createApp>;

/**
 * Rejects requests that don't come from the server's own localhost origin.
 * - Host check: stops DNS rebinding, where evil.example resolves to 127.0.0.1.
 * - Origin check: stops other websites (and other local dev servers) from calling us.
 *   Browsers leave Origin off same-origin GETs, so a missing Origin is fine.
 */
function ownOriginOnly(origin: string) {
  const ownHost = new URL(origin).host;
  return createMiddleware(async (c, next) => {
    const host = new URL(c.req.url).host;
    const requestOrigin = c.req.header('origin');
    if (host !== ownHost || (requestOrigin !== undefined && requestOrigin !== origin)) {
      return c.json({ error: `Forbidden: only ${origin} may call this server` }, 403);
    }
    await next();
  });
}
