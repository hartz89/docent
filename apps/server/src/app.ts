import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { validator } from 'hono/validator';
import type { Place } from './author-session.ts';
import { Busy } from './author-session.ts';
import { type ClientEvent, clientEvent, RateLimit } from './client-log.ts';
import { isSafeRepoPath } from './github.ts';
import { type Review, SubmitRefused, type TourState, verdict } from './review.ts';
import { describeError, RunLog } from './run-log.ts';

/** One identifier, in any of the indexed languages. */
const SYMBOL = /^[\p{L}\p{Nl}_$][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}$]{0,199}$/u;
/** An import specifier: printable, no control characters. */
const SPECIFIER = /^[^\p{Cc}]{1,1000}$/u;

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
  /** This run's log. Server errors and the web app's reports land here. Default: nowhere. */
  log?: RunLog;
  /** Client reports allowed per minute, and per launch. */
  clientLogLimits?: { perMinute: number; total: number };
};

export function createApp({
  token,
  origin,
  version,
  webRoot,
  review,
  log = RunLog.off(),
  clientLogLimits = { perMinute: 60, total: 2000 },
}: AppOptions) {
  const noReview = { error: 'No review is open. Start Docent with: docent review <pr-url>' };
  const stillLoading = { error: 'The pull request is still loading.' };
  const indexFailed = { error: "Docent couldn't index the repository." };
  // Errors and screen events have separate limits, so a fast reader can't crowd out an error.
  const clientLimits = {
    error: new RateLimit(clientLogLimits.perMinute, clientLogLimits.total),
    ui: new RateLimit(clientLogLimits.perMinute, clientLogLimits.total),
  };

  // Each question's place in line, taken as its request arrives: the token check and reading the
  // body are async and can finish out of order, and questions reach the author in arrival order.
  const places = new WeakMap<Request, Place>();

  const app = new Hono()
    .use(ownOriginOnly(origin))
    .use('/api/questions', async (c, next) => {
      const place = review?.placeInLine();
      if (place) places.set(c.req.raw, place);
      try {
        await next();
      } finally {
        place?.leave();
      }
    })
    .use('/api/*', bearerAuth({ token }))
    .get('/api/health', (c) => c.json({ ok: true, version }))
    // The web app's own errors and a few screen events, for the run log. The client picks from
    // a fixed set of fields; anything else is dropped. Small, and rate-limited.
    .post(
      '/api/client-log',
      bodyLimit({
        maxSize: 16 * 1024,
        onError: (c) => c.json({ error: 'A client report is limited to 16 KB' }, 413),
      }),
      validator('json', (body: unknown, c) => {
        const event = clientEvent(body);
        return typeof event === 'string' ? c.json({ error: event }, 400) : event;
      }),
      (c) => {
        const { kind, ...fields }: ClientEvent = c.req.valid('json');
        const limit = kind === 'client.error' ? clientLimits.error : clientLimits.ui;
        if (!limit.take(Date.now())) return c.json({ error: 'Too many client reports' }, 429);
        log.event(kind, fields);
        return c.body(null, 204);
      },
    )
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
    // Jump to definition: every place a symbol may be defined at the PR's head, best first.
    .get(
      '/api/definition',
      validator('query', (query, c) => {
        const { symbol, from, line } = query;
        if (typeof symbol !== 'string' || !SYMBOL.test(symbol)) {
          return c.json({ error: 'Send a symbol: one identifier, up to 200 characters' }, 400);
        }
        if (from !== undefined && (typeof from !== 'string' || !isSafeRepoPath(from))) {
          return c.json({ error: 'Send from as a path inside the repository' }, 400);
        }
        if (line !== undefined && (typeof line !== 'string' || !/^[1-9]\d{0,6}$/.test(line))) {
          return c.json({ error: 'Send line as a line number' }, 400);
        }
        const valid: { symbol: string; from?: string; line?: string } = { symbol };
        if (from !== undefined) valid.from = from;
        if (line !== undefined) valid.line = line;
        return valid;
      }),
      async (c) => {
        if (!review) return c.json(noReview, 404);
        const { symbol, from, line } = c.req.valid('query');
        const at =
          from === undefined
            ? undefined
            : line
              ? { path: from, line: Number(line) }
              : { path: from };
        try {
          const found = await review.definitions(symbol, at);
          if (!found) return c.json(stillLoading, 503);
          return c.json({ symbol, ...found }, 200);
        } catch {
          return c.json(indexFailed, 500);
        }
      },
    )
    // Jump to an import: the repo file an import specifier names, if it names one.
    .get(
      '/api/import',
      validator('query', (query, c) => {
        const { from, spec } = query;
        if (typeof from !== 'string' || !isSafeRepoPath(from)) {
          return c.json({ error: 'Send from as a path inside the repository' }, 400);
        }
        if (typeof spec !== 'string' || !SPECIFIER.test(spec)) {
          return c.json({ error: 'Send spec: an import specifier, up to 1000 characters' }, 400);
        }
        return { from, spec };
      }),
      async (c) => {
        if (!review) return c.json(noReview, 404);
        const { from, spec } = c.req.valid('query');
        try {
          const found = await review.resolveImport(from, spec);
          if (!found) return c.json(stillLoading, 503);
          return c.json({ from, spec, ...found }, 200);
        } catch {
          return c.json(indexFailed, 500);
        }
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
        // Review.ask logs the question and its outcome.
        try {
          // The request's signal aborts when the reviewer goes away, so a dropped question stops.
          const place = places.get(c.req.raw);
          if (!place) throw new Error('The question has no place in line.');
          const answer = await review.ask(stopId, question, place, c.req.raw.signal);
          return c.json({ answer }, 200);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (error instanceof Busy) return c.json({ error: message }, 429);
          return c.json({ error: message }, 502);
        }
      },
    )
    // The guide's check of an author answer. Waits until the check is done, then sends a
    // correction, or null when the guide has nothing to say, and what the check cost either way.
    .get('/api/answer-checks/:id', async (c) => {
      if (!review) return c.json(noReview, 404);
      const check = review.answerCheck(c.req.param('id'));
      if (!check) return c.json({ error: 'No such answer check' }, 404);
      const { correction, costs } = await check;
      return c.json({ correction, costs }, 200);
    })
    // Posts the reviewer's verdict to GitHub as them. The PR, repo and commit come from the
    // review this server holds; the client chooses only the event, the summary, and which lines
    // of the PR's files its comments are on.
    .post(
      '/api/review/submit',
      validator(
        'json',
        (
          body: {
            event?: unknown;
            body?: unknown;
            comments?: { path: string; side: 'old' | 'new'; line: number; body: string }[];
          } | null,
          c,
        ) => {
          const result = verdict(body?.event, body?.body, body?.comments);
          return typeof result === 'string' ? c.json({ error: result }, 400) : result;
        },
      ),
      async (c) => {
        if (!review) return c.json(noReview, 404);
        try {
          const posted = await review.submit(c.req.valid('json'));
          return c.json({ posted }, 200);
        } catch (error) {
          if (!(error instanceof SubmitRefused)) throw error;
          const status = error.reason === 'github' ? 502 : error.reason === 'invalid' ? 400 : 409;
          return c.json({ error: error.message }, status);
        }
      },
    );

  // Anything a route didn't handle: logged with its stack, answered with no detail.
  app.onError((error, c) => {
    // Middleware answers like the token check's 401 arrive here too, and aren't errors.
    if (error instanceof HTTPException) return error.getResponse();
    log.event('error', {
      where: 'server',
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      ...describeError(error),
    });
    console.error(error);
    return c.json({ error: 'Something went wrong in Docent. The run log has the details.' }, 500);
  });

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
