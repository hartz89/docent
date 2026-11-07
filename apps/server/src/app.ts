import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { createMiddleware } from 'hono/factory';
import { streamSSE } from 'hono/streaming';
import { validator } from 'hono/validator';
import { isSafeRepoPath } from './github.ts';
import type { Review, TourState } from './review.ts';

export type AppOptions = {
  /** Per-launch secret. Every /api request must send it as a bearer token. */
  token: string;
  /** The server's own origin, like http://127.0.0.1:4123. No other origin may call us. */
  origin: string;
  version: string;
  /** Folder holding the built web app. Leave it out in dev, where Vite serves the app. */
  webRoot?: string;
  /** The review this launch serves. Without one, the review routes answer 404. */
  review?: Review;
};

export function createApp({ token, origin, version, webRoot, review }: AppOptions) {
  const noReview = { error: 'No review is open. Start Docent with: docent review <pr-url>' };

  const app = new Hono()
    .use(ownOriginOnly(origin))
    .use('/api/*', bearerAuth({ token }))
    .get('/api/health', (c) => c.json({ ok: true, version }))
    .get('/api/review', (c) => (review ? c.json(review.snapshot(), 200) : c.json(noReview, 404)))
    // Tour progress as server-sent events: the current state first, then every change.
    .get('/api/review/events', (c) => {
      if (!review) return c.json(noReview, 404);
      return streamSSE(c, async (stream) => {
        const queue: TourState[] = [];
        let wake: (() => void) | null = null;
        const unsubscribe = review.subscribe((tour) => {
          queue.push(tour);
          wake?.();
        });
        stream.onAbort(unsubscribe);
        while (!stream.aborted) {
          const next = queue.shift();
          if (!next) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = null;
            continue;
          }
          await stream.writeSSE({ event: 'tour', data: JSON.stringify(next) });
          if (next.state !== 'working') break;
        }
        unsubscribe();
      });
    })
    .get(
      '/api/file',
      validator('query', (query, c) => {
        const { path, side } = query;
        if (
          typeof path !== 'string' ||
          !isSafeRepoPath(path) ||
          (side !== 'old' && side !== 'new')
        ) {
          return c.json({ error: 'Send side=old|new and a path inside the repository' }, 400);
        }
        return { path, side: side as 'old' | 'new' };
      }),
      async (c) => {
        if (!review) return c.json(noReview, 404);
        const { path, side } = c.req.valid('query');
        const text = await review.readFile(side, path);
        if (text === null) return c.json({ error: `${path} doesn't exist at ${side}` }, 404);
        return c.json({ path, side, text }, 200);
      },
    )
    .post(
      '/api/questions',
      validator('json', (body: { stopId?: unknown; question?: unknown } | null, c) => {
        const question = typeof body?.question === 'string' ? body.question.trim() : '';
        const stopId = typeof body?.stopId === 'string' ? body.stopId : '';
        if (!question || question.length > 4000 || !stopId) {
          return c.json({ error: 'Send a stopId and a question of up to 4000 characters' }, 400);
        }
        return { stopId, question };
      }),
      async (c) => {
        if (!review) return c.json(noReview, 404);
        const { stopId, question } = c.req.valid('json');
        try {
          const answer = await review.ask(stopId, question);
          return c.json({ answer }, 200);
        } catch (error) {
          return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
        }
      },
    );

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
