import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createAdaptorServer } from '@hono/node-server';
import { createApp } from './app.ts';
import type { Review } from './review.ts';
import type { RunLog } from './run-log.ts';

export type { CostRecord } from '@docent/core';
export type { CorrectionView } from './answer-check.ts';
export type { AppType } from './app.ts';
export type { PrInfo, ReviewEvent } from './github.ts';
export type {
  AnswerView,
  AuthorView,
  PostedReview,
  QuestionView,
  ReviewSnapshot,
  Step,
  TourState,
} from './review.ts';
export type { DraftComment } from './review-comments.ts';
export type { AnchorView, SkipView, StopView, TourOutcome, TourView } from './tour.ts';

// Resolves from both src/ and dist/, which sit at the same depth.
const packageJson = new URL('../package.json', import.meta.url);
export const { version } = JSON.parse(readFileSync(packageJson, 'utf8')) as { version: string };

export type StartOptions = {
  /** Folder holding the built web app. Leave it out in dev, where Vite serves the app. */
  webRoot?: string;
  /** The review to serve, when started by `docent review`. */
  review?: Review;
  /** This run's log. The per-launch token is scrubbed from it. */
  log?: RunLog;
};

export type RunningServer = {
  /** The server's origin, like http://127.0.0.1:4123. */
  origin: string;
  token: string;
  close: () => Promise<void>;
};

/**
 * Starts the local server on 127.0.0.1 and a free port picked by the OS,
 * so parallel worktrees never fight over a port.
 */
export async function startServer({ webRoot, review, log }: StartOptions): Promise<RunningServer> {
  const token = randomBytes(32).toString('base64url');
  log?.addSecret(token);

  // The app needs the origin, and the origin needs the port, which we only
  // know after listening. Requests can't arrive before `app` is set below.
  let app: ReturnType<typeof createApp> | undefined;
  const server = createAdaptorServer({
    fetch: (request) => app?.fetch(request) ?? new Response('Starting', { status: 503 }),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  app = createApp({
    token,
    origin,
    version,
    ...(webRoot ? { webRoot } : {}),
    ...(review ? { review } : {}),
    ...(log ? { log } : {}),
  });

  return {
    origin,
    token,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
