import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { createMiddleware } from 'hono/factory';
import { streamSSE } from 'hono/streaming';
import { validator } from 'hono/validator';
import { Busy } from './author-session.ts';
import { isSafeRepoPath } from './github.ts';
import { type Review, SubmitRefused, type TourState, verdict } from './review.ts';

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
        // Wake the loop on abort too, or it would wait forever for a state that never comes.
        stream.onAbort(() => {
          unsubscribe();
          wake?.();
        });
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
        const file = await review.open(side, path);
        switch (file.kind) {
          case 'text':
            return c.json({ path, side, text: file.text }, 200);
          case 'missing':
            return c.json(
              { error: `${path} isn't a file at ${side === 'new' ? 'head' : 'base'}` },
              404,
            );
          case 'too_large':
            return c.json({ error: 'Too large to show (over 2 MB).' }, 413);
          case 'binary':
            return c.json({ error: 'A binary file, not shown.' }, 415);
          case 'symlink':
            return c.json(
              { error: `A symbolic link to ${file.target}. Docent doesn't follow links.` },
              415,
            );
        }
      },
    )
    // Every path in the repo at the PR's head, read from git, for the file browser.
    .get('/api/tree', async (c) => {
      if (!review) return c.json(noReview, 404);
      const tree = await review.tree();
      if (!tree) return c.json({ error: 'The pull request is still loading.' }, 503);
      return c.json({ head: tree.head, ...tree.tree }, 200);
    })
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
          // The request's signal aborts when the reviewer goes away, so a dropped question stops.
          const answer = await review.ask(stopId, question, c.req.raw.signal);
          return c.json({ answer }, 200);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (error instanceof Busy) return c.json({ error: message }, 429);
          return c.json({ error: message }, 502);
        }
      },
    )
    // Posts the reviewer's verdict to GitHub as them. The PR, repo and commit come from the
    // review this server holds; the client chooses only the event and the summary.
    .post(
      '/api/review/submit',
      validator('json', (body: { event?: unknown; body?: unknown } | null, c) => {
        const result = verdict(body?.event, body?.body);
        return typeof result === 'string' ? c.json({ error: result }, 400) : result;
      }),
      async (c) => {
        if (!review) return c.json(noReview, 404);
        try {
          const posted = await review.submit(c.req.valid('json'));
          return c.json({ posted }, 200);
        } catch (error) {
          if (!(error instanceof SubmitRefused)) throw error;
          return c.json({ error: error.message }, error.reason === 'github' ? 502 : 409);
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
