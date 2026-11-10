import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CostRecord, commitSha, type Job, type MicroUsd } from '@docent/core';
import { hc } from 'hono/client';
import { describe, expect, test } from 'vitest';
import { AgentError, type AgentReply, type AgentRequest, type AgentRunner } from './agent.ts';
import { type AppType, createApp } from './app.ts';
import { GitHubRefusal, type PrSource, type ReviewPost } from './github.ts';
import { Review, type TourState } from './review.ts';

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

const prHead = commitSha('h'.repeat(40));

/** GitHub's side of the PR: where its head is now, and the reviews posted to it. */
function fakeGitHub() {
  return { head: prHead, posted: [] as ReviewPost[], refusal: null as string | null };
}
type FakeGitHub = ReturnType<typeof fakeGitHub>;

const sourceFor =
  (github: FakeGitHub): PrSource =>
  async (onStep) => {
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
        head: prHead,
        baseRef: 'main',
        headRef: 'fix',
      },
      diffText,
      dir: '/nowhere',
      readFile: async (side, path) => (side === 'new' ? head : base)[path] ?? null,
      currentHead: async () => github.head,
      postReview: async (review) => {
        if (github.refusal) throw new GitHubRefusal(github.refusal);
        github.posted.push(review);
        return {
          url: `https://github.com/acme/web/pull/7#pullrequestreview-${github.posted.length}`,
        };
      },
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

async function open(
  runner: AgentRunner,
  cacheDir?: string,
  model = 'claude-test',
  github = fakeGitHub(),
) {
  const review = new Review({
    source: sourceFor(github),
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
type App = Awaited<ReturnType<typeof open>>['app'];

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

describe('POST /api/review/submit', () => {
  /** Opens the review against a fake GitHub, and returns both. */
  const openWithGitHub = async () => {
    const github = fakeGitHub();
    return { github, ...(await open(scripted(goodTour).runner, undefined, 'claude-test', github)) };
  };
  /** Posts raw JSON, so tests can send what the typed client wouldn't allow. */
  const post = (app: App, json: unknown, headers: Record<string, string> = {}) =>
    app.request(`${origin}/api/review/submit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(json),
    });

  test('posts one review on this PR, at the head the tour was written for', async () => {
    const { github, api } = await openWithGitHub();

    const res = await api.review.submit.$post({
      json: { event: 'APPROVE', body: '  Looks right to me.  ' },
    });

    expect(res.status).toBe(200);
    expect(github.posted).toEqual([
      { commitId: prHead, event: 'APPROVE', body: 'Looks right to me.' },
    ]);
    const posted = {
      event: 'APPROVE',
      body: 'Looks right to me.',
      commitId: prHead,
      url: 'https://github.com/acme/web/pull/7#pullrequestreview-1',
    };
    expect(await res.json()).toEqual({ posted });
    // A reload finds it posted, so the form stays locked.
    expect((await snapshot(api)).posted).toEqual(posted);
  });

  test('approving needs no summary', async () => {
    const { github, app } = await openWithGitHub();

    expect((await post(app, { event: 'APPROVE' })).status).toBe(200);
    expect(github.posted).toEqual([{ commitId: prHead, event: 'APPROVE', body: '' }]);
  });

  test('ignores any repo, PR or commit the client sends', async () => {
    const { github, app } = await openWithGitHub();

    await post(app, {
      event: 'COMMENT',
      body: 'Note',
      commit_id: 'e'.repeat(40),
      commitId: 'e'.repeat(40),
      repo: 'evil/repo',
      number: 1,
    });

    expect(github.posted).toEqual([{ commitId: prHead, event: 'COMMENT', body: 'Note' }]);
  });

  test.each(['REQUEST_CHANGES', 'COMMENT'])(
    'refuses %s without a summary, and posts nothing',
    async (event) => {
      const { github, app } = await openWithGitHub();

      const res = await post(app, { event, body: '   ' });

      expect(res.status).toBe(400);
      expect(github.posted).toEqual([]);
    },
  );

  test('refuses an event GitHub does not have', async () => {
    const { github, app } = await openWithGitHub();

    expect((await post(app, { event: 'DISMISS', body: 'x' })).status).toBe(400);
    expect(github.posted).toEqual([]);
  });

  test('refuses when the PR has new commits since the tour, rather than approve unseen code', async () => {
    const { github, app } = await openWithGitHub();
    github.head = commitSha('n'.repeat(40));

    const res = await post(app, { event: 'APPROVE', body: 'LGTM' });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'The PR has new commits since this tour. Reopen it in Docent to review them.',
    });
    expect(github.posted).toEqual([]);
  });

  test('posts only once, even when two submits race', async () => {
    const { github, app } = await openWithGitHub();

    const [first, second] = await Promise.all([
      post(app, { event: 'APPROVE' }),
      post(app, { event: 'APPROVE' }),
    ]);
    const third = await post(app, { event: 'COMMENT', body: 'One more thing' });

    expect([first.status, second.status, third.status]).toEqual([200, 409, 409]);
    expect(github.posted).toHaveLength(1);
  });

  test("passes on GitHub's refusal, and lets the reviewer try again", async () => {
    const { github, app } = await openWithGitHub();
    github.refusal =
      "GitHub doesn't let you approve your own pull request. Choose Comment instead.";

    const res = await post(app, { event: 'APPROVE' });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: github.refusal });
    github.refusal = null;
    expect((await post(app, { event: 'COMMENT', body: 'Fine by me' })).status).toBe(200);
  });

  test('needs the token and our own origin', async () => {
    const { github, app } = await openWithGitHub();

    expect((await post(app, { event: 'APPROVE' }, { Authorization: '' })).status).toBe(401);
    expect((await post(app, { event: 'APPROVE' }, { Origin: 'https://evil.example' })).status).toBe(
      403,
    );
    expect(github.posted).toEqual([]);
  });
});
