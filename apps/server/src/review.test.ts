import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CostRecord, commitSha, type Job, type MicroUsd } from '@docent/core';
import { hc } from 'hono/client';
import { describe, expect, test } from 'vitest';
import { AgentError, type AgentReply, type AgentRequest, type AgentRunner } from './agent.ts';
import { type AppType, createApp } from './app.ts';
import type { PrSource } from './github.ts';
import { Review, type TourState, tourCacheName } from './review.ts';

// A small PR: one behavior change in src/cors.ts, plus a lockfile bump.
const head: Record<string, string> = {
  'src/cors.ts': 'export function cors() {\n  const origin = reflect();\n  return origin;\n}\n',
  'pnpm-lock.yaml': 'lockfileVersion: 9\n',
  'logo.png': 'PNG\0binary',
  'huge.txt': 'x'.repeat(2_000_001),
};
const base: Record<string, string> = {
  'src/cors.ts': "export function cors() {\n  const origin = '*';\n  return origin;\n}\n",
  'pnpm-lock.yaml': 'lockfileVersion: 8\n',
};
const diffText = `diff --git a/src/cors.ts b/src/cors.ts
--- a/src/cors.ts
+++ b/src/cors.ts
@@ -1,3 +1,3 @@
 export function cors() {
-  const origin = '*';
+  const origin = reflect();
   return origin;
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -1 +1 @@
-lockfileVersion: 8
+lockfileVersion: 9
`;

const source: PrSource = async (onStep) => {
  onStep('Fetching the pull request');
  return {
    pr: {
      url: 'https://github.com/acme/web/pull/7',
      repo: 'acme/web',
      number: 7,
      title: 'Reflect the request origin',
      body: 'Reflects the origin instead of the wildcard.',
      author: 'someone',
      base: commitSha('b'.repeat(40)),
      head: commitSha('h'.repeat(40)),
      baseRef: 'main',
      headRef: 'fix',
    },
    diffText,
    dir: '/nowhere',
    readFile: async (side, path) => (side === 'new' ? head : base)[path] ?? null,
  };
};

const cite = (side: 'new' | 'old', startLine: number, endLine = startLine) => ({
  path: 'src/cors.ts',
  side,
  startLine,
  endLine,
});
const stops = (core: object[]) => [
  { kind: 'intent', title: 'Why', body: 'Reflects the origin.', citations: [] },
  ...core,
  { kind: 'verdict_prompt', title: 'Your call', body: 'Does it do what it says?', citations: [] },
];
const goodTour = {
  stops: stops([
    {
      kind: 'core_change',
      title: 'The origin is reflected',
      body: 'The wildcard is replaced.',
      flags: [{ kind: 'mismatch', note: 'The description does not mention Vary.' }],
      citations: [cite('new', 2), cite('old', 2)],
    },
  ]),
  skips: [{ target: 'pnpm-lock.yaml', reason: 'Lockfile bump' }],
};
// Forgets the removed line, so the checker has something to send back.
const gappyTour = {
  ...goodTour,
  stops: stops([{ kind: 'core_change', title: 'x', body: 'y', citations: [cite('new', 2)] }]),
};

/** Stands in for a turn that hit the budget cap: the runner throws, with the cost so far. */
const BUDGET = Symbol('budget');
const cost = (job: Job, micro: number): CostRecord => ({
  job,
  model: 'claude-test',
  tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
  costMicroUsd: micro as MicroUsd,
  latencyMs: 1,
});

/** The model boundary, scripted: hands out the given tours in order and records each request. */
function scripted(...tours: unknown[]) {
  const requests: AgentRequest[] = [];
  const runner: AgentRunner = async (request) => {
    requests.push(request);
    const structured = request.job === 'tour' ? tours[requests.length - 1] : undefined;
    if (request.job === 'tour' && structured === undefined) throw new Error('model unavailable');
    if (structured === BUDGET)
      throw new AgentError(
        'The agent stopped without an answer (error_max_budget_usd)',
        cost(request.job, 900),
      );
    return {
      sessionId: 'session-1',
      text: request.job === 'question' ? 'It calls `reflect()` on line 2.' : '',
      structured,
      denials: [],
      cost: cost(request.job, 1500),
    } satisfies AgentReply;
  };
  return { runner, requests };
}

const origin = 'http://127.0.0.1:4123';
const token = 'test-token';

async function open(runner: AgentRunner, cacheDir?: string, model = 'claude-test') {
  const review = new Review({
    source,
    runner,
    model,
    ...(cacheDir ? { cacheDir } : {}),
  });
  await review.done;
  const app = createApp({ origin, token, version: '0.0.0', review });
  const client = hc<AppType>(origin, {
    fetch: app.request,
    headers: { Authorization: `Bearer ${token}` },
  });
  return { review, app, api: client.api };
}

type Api = Awaited<ReturnType<typeof open>>['api'];

/** GET /api/review, narrowed to the success body. */
async function snapshot(api: Api) {
  const res = await api.review.$get();
  if (res.status !== 200) throw new Error(`GET /api/review answered ${res.status}`);
  return res.json();
}

const ready = (tour: TourState) => {
  if (tour.state !== 'ready') throw new Error(`Tour is ${tour.state}: ${JSON.stringify(tour)}`);
  return tour;
};

describe('GET /api/review', () => {
  test('serves the PR, its diff and a tour that passed every check', async () => {
    const { api } = await open(scripted(goodTour).runner);

    const body = await snapshot(api);

    expect(body.pr?.title).toBe('Reflect the request origin');
    expect(body.diff?.files.map((f) => f.path)).toEqual(['src/cors.ts', 'pnpm-lock.yaml']);
    const tour = ready(body.tour);
    expect(tour.problems).toEqual([]);
    expect(tour.tour.stops.map((s) => s.kind)).toEqual(['intent', 'core_change', 'verdict_prompt']);
    expect(tour.tour.stops[1]?.flags).toEqual(['mismatch']);
    expect(tour.tour.stops[1]?.flagNotes).toEqual([
      { flag: 'mismatch', note: 'The description does not mention Vary.' },
    ]);
    expect(tour.tour.skips).toEqual([
      { path: 'pnpm-lock.yaml', hunk: null, reason: 'Lockfile bump' },
    ]);
    expect(tour.costs.map((c) => c.costMicroUsd)).toEqual([1500]);
  });

  test('sends the checker problems back to the guide, and keeps the fixed tour', async () => {
    const { runner, requests } = scripted(gappyTour, goodTour);
    const { api } = await open(runner);

    const tour = ready((await snapshot(api)).tour);

    expect(tour.attempts).toBe(2);
    expect(tour.problems).toEqual([]);
    expect(requests[1]?.resume).toBe('session-1');
    expect(requests[1]?.prompt).toContain('Unexplained: src/cors.ts base line 2 has no home');
    expect(tour.costs).toHaveLength(2);
  });

  test('stops after two retries and shows what is still wrong', async () => {
    const { runner, requests } = scripted(gappyTour, gappyTour, gappyTour, goodTour);
    const { api } = await open(runner);

    const tour = ready((await snapshot(api)).tour);

    expect(requests).toHaveLength(3);
    expect(tour.problems).toEqual([
      'Unexplained: src/cors.ts base line 2 has no home. Cite it in a core_change or edge stop, or skip it.',
    ]);
  });

  test('reports citations outside the file and doubled lines', async () => {
    const bad = {
      stops: stops([
        { kind: 'core_change', title: 'a', body: 'b', citations: [cite('new', 2), cite('old', 2)] },
        { kind: 'edge', title: 'c', body: 'd', citations: [cite('new', 2, 90)] },
      ]),
      skips: [{ target: 'pnpm-lock.yaml', reason: 'Lockfile' }],
    };
    const { runner, requests } = scripted(bad, goodTour);
    await open(runner);

    expect(requests[1]?.prompt).toContain(
      'Stop 3 ("c") cites src/cors.ts head lines 2-90, outside the file (it has 5 lines).',
    );
  });

  test('shows a clear reason when the guide fails', async () => {
    const { api } = await open(scripted().runner);

    const { tour } = await snapshot(api);

    expect(tour).toEqual({ state: 'failed', reason: 'model unavailable', costs: [] });
  });

  test('reopening a PR loads the cached tour with no model calls', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'docent-test-'));
    await open(scripted(goodTour).runner, cacheDir);
    const second = scripted();

    const { api } = await open(second.runner, cacheDir);
    const tour = ready((await snapshot(api)).tour);

    expect(second.requests).toEqual([]);
    expect(tour.cached).toBe(true);
    expect(tour.tour.stops).toHaveLength(3);
  });

  test('a different model writes a fresh tour instead of reusing the cached one', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'docent-test-'));
    await open(scripted(goodTour).runner, cacheDir, 'model-a');
    const second = scripted(goodTour);

    await open(second.runner, cacheDir, 'model-b');

    expect(second.requests).toHaveLength(1);
  });

  test('keeps the last good tour when a retry fails, and records what the failure cost', async () => {
    const { runner, requests } = scripted(gappyTour, 'not a tour', BUDGET);
    const { api } = await open(runner);

    const tour = ready((await snapshot(api)).tour);

    expect(requests).toHaveLength(3);
    expect(tour.tour.stops.map((s) => s.title)).toContain('x');
    expect(tour.problems).toHaveLength(1);
    expect(tour.costs.map((c) => c.costMicroUsd)).toEqual([1500, 1500, 900]);
  });

  test('a first attempt that hits the budget fails with its cost recorded', async () => {
    const { api } = await open(scripted(BUDGET).runner);

    const { tour } = await snapshot(api);

    expect(tour).toMatchObject({ state: 'failed', costs: [{ costMicroUsd: 900 }] });
  });

  test('needs the token', async () => {
    const { app } = await open(scripted(goodTour).runner);

    expect((await app.request(`${origin}/api/review`)).status).toBe(401);
  });
});

describe('GET /api/review/events', () => {
  test('streams the tour state as server-sent events, ending when it is ready', async () => {
    const { api } = await open(scripted(goodTour).runner);

    const text = await (await api.review.events.$get()).text();

    const events = text.split('\n').filter((line) => line.startsWith('data: '));
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]?.slice(6) ?? '').state).toBe('ready');
  });
});

describe('GET /api/file', () => {
  test('serves a file at head or base', async () => {
    const { api } = await open(scripted(goodTour).runner);

    const res = await api.file.$get({ query: { path: 'src/cors.ts', side: 'old' } });

    expect(await res.json()).toEqual({
      path: 'src/cors.ts',
      side: 'old',
      text: base['src/cors.ts'],
    });
  });

  test('refuses paths that leave the repository', async () => {
    const { api } = await open(scripted(goodTour).runner);

    const res = await api.file.$get({ query: { path: '../../etc/passwd', side: 'new' } });

    expect(res.status).toBe(400);
  });

  test('answers 404 for a file that is not there', async () => {
    const { api } = await open(scripted(goodTour).runner);

    expect((await api.file.$get({ query: { path: 'nope.ts', side: 'new' } })).status).toBe(404);
  });

  test('refuses binary files and files over 2 MB', async () => {
    const { api } = await open(scripted(goodTour).runner);

    expect((await api.file.$get({ query: { path: 'logo.png', side: 'new' } })).status).toBe(415);
    expect((await api.file.$get({ query: { path: 'huge.txt', side: 'new' } })).status).toBe(413);
  });
});

describe('POST /api/questions', () => {
  test('the guide answers from the code, with the stop as context', async () => {
    const { runner, requests } = scripted(goodTour);
    const { api } = await open(runner);

    const res = await api.questions.$post({
      json: { stopId: 'stop-2', question: 'What does reflect() return?' },
    });

    expect(await res.json()).toMatchObject({
      answer: { source: 'guide', text: 'It calls `reflect()` on line 2.' },
    });
    const asked = requests.at(-1);
    expect(asked?.job).toBe('question');
    expect(asked?.prompt).toContain('src/cors.ts (head) lines 2-2:\n  const origin = reflect();');
  });

  test('rejects an empty question', async () => {
    const { api } = await open(scripted(goodTour).runner);

    const res = await api.questions.$post({ json: { stopId: 'stop-2', question: ' ' } });

    expect(res.status).toBe(400);
  });
});

describe('the tour cache key', () => {
  const pr = { base: 'a'.repeat(40), head: 'b'.repeat(40) };

  test('the same diff, model and prompt reuse a tour; a changed prompt text writes a new one', () => {
    const key = tourCacheName(pr, 'claude-opus-5-5', 'prompt text');
    expect(tourCacheName(pr, 'claude-opus-5-5', 'prompt text')).toBe(key);
    // An edited prompt, or an edited PR description inside it, must not serve the old tour.
    expect(tourCacheName(pr, 'claude-opus-5-5', 'prompt text, edited')).not.toBe(key);
  });
});
