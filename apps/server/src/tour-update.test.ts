// Tour updates across pushes (issue #65), driven through a whole review: a real git repo with a
// commit per push, the review's cache, and a scripted guide.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type CommitSha, type CostRecord, commitSha, type MicroUsd } from '@docent/core';
import { afterEach, describe, expect, test } from 'vitest';
import type { AgentReply, AgentRequest, AgentRunner } from './agent.ts';
import { fixedSession } from './author-session.ts';
import { commitReader, git, type PrSource } from './github.ts';
import { Review, type TourState } from './review.ts';
import { TOUR_PROMPT_VERSION } from './tour.ts';

const base = {
  'src/cors.ts': "export function cors() {\n  const origin = '*';\n  return origin;\n}\n",
};
// Push 1: the origin is reflected, and a new helper says what varies.
const push1 = {
  'src/cors.ts':
    "export function cors() {\n  const origin = reflect();\n  return origin;\n}\n\nexport function vary() {\n  return 'Origin';\n}\n",
};
// Push 2, a fix: the helper changes. The origin change is untouched.
const push2 = {
  'src/cors.ts':
    "export function cors() {\n  const origin = reflect();\n  return origin;\n}\n\nexport function vary() {\n  return 'Origin, Accept';\n}\n",
};
// Push 2, moved: a comment above everything shifts every line down; nothing else changes.
const push2Moved = {
  'src/cors.ts': `// CORS helpers.\n${push1['src/cors.ts']}`,
};

const cite = (side: 'new' | 'old', startLine: number, endLine = startLine) => ({
  path: 'src/cors.ts',
  side,
  startLine,
  endLine,
});
const intent = {
  kind: 'intent',
  title: 'Why',
  body: 'Reflects the origin.',
  flags: [],
  citations: [],
};
const origin = {
  kind: 'core_change',
  title: 'The origin is reflected',
  body: 'The wildcard is replaced by the request origin.',
  flags: [],
  citations: [cite('new', 2), cite('old', 2)],
};
const vary = {
  kind: 'edge',
  title: 'A helper names what varies',
  body: 'The new helper returns the Vary header value.',
  flags: [],
  citations: [cite('new', 6, 8)],
};
const verdict = {
  kind: 'verdict_prompt',
  title: 'Your call',
  body: 'Does it do what it says?',
  flags: [],
  citations: [],
};
const firstTour = { stops: [intent, origin, vary, verdict] };

const cost = (job: AgentRequest['job'], micro: number): CostRecord => ({
  job,
  model: 'claude-test',
  tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
  costMicroUsd: micro as MicroUsd,
  latencyMs: 1,
});

/** The guide, scripted: hands out the given answers in order and records each request. */
function scripted(...answers: unknown[]) {
  const requests: AgentRequest[] = [];
  const runner: AgentRunner = async (request) => {
    requests.push(request);
    const structured = answers[requests.length - 1];
    if (structured === undefined) throw new Error('model unavailable');
    return {
      sessionId: 'session-1',
      text: '',
      structured,
      denials: [],
      cost: cost(request.job, 1500),
    } satisfies AgentReply;
  };
  return { runner, requests };
}

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A repo with the base commit; `push` commits a new head on top of the last one. */
async function repo() {
  const dir = await mkdtemp(join(tmpdir(), 'docent-update-'));
  cleanup.push(dir);
  const commit = async (files: Record<string, string>, message: string) => {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), text);
    }
    await git(dir, ['add', '-A']);
    await git(dir, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@docent.invalid',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      message,
    ]);
    return commitSha((await git(dir, ['rev-parse', 'HEAD'])).stdout.trim());
  };
  await git(dir, ['init', '--quiet', '--initial-branch=main']);
  const baseSha = await commit(base, 'base');
  return {
    push: (files: Record<string, string>) => commit(files, 'push'),
    /** The PR as GitHub would show it at this head. */
    at:
      (head: CommitSha, body = 'Reflects the origin instead of the wildcard.'): PrSource =>
      async (onStep) => {
        onStep('Fetching the pull request');
        const diffText = (await git(dir, ['diff', '--no-color', baseSha, head])).stdout;
        return {
          pr: {
            url: 'https://github.com/acme/web/pull/7',
            repo: 'acme/web',
            number: 7,
            title: 'Reflect the request origin',
            body,
            author: 'someone',
            base: baseSha,
            head,
            baseRef: 'main',
            headRef: 'fix',
            handoff: null,
          },
          diffText,
          commitMessages: [],
          commitShas: [],
          headInBaseRepo: true,
          dir,
          ...commitReader(dir, baseSha, head),
          currentHead: async () => head,
          postReview: async () => {
            throw new Error('not in this test');
          },
        };
      },
  };
}

async function review(source: PrSource, runner: AgentRunner, cacheDir: string) {
  const states: TourState[] = [];
  const opened = new Review({
    source,
    runner,
    locator: fixedSession({ found: false, reason: 'none' }),
    model: 'claude-test',
    cacheDir,
  });
  opened.subscribe((tour) => states.push(tour));
  await opened.done;
  const tour = opened.snapshot().tour;
  await opened.close();
  if (tour.state !== 'ready') throw new Error(`Tour is ${tour.state}: ${JSON.stringify(tour)}`);
  return { tour, states };
}

describe('a push updates the tour instead of writing a new one', () => {
  test('keeps the stops whose code is unchanged, shows them at once, and marks what the guide rewrote', async () => {
    const git = await repo();
    const cacheDir = await mkdtemp(join(tmpdir(), 'docent-cache-'));
    cleanup.push(cacheDir);
    await review(git.at(await git.push(push1)), scripted(firstTour).runner, cacheDir);

    const second = await git.push(push2);
    // The guide rewrites only the helper's stop, stop 3, citing its new line.
    const guide = scripted({
      stops: [{ ...vary, replaces: 3, body: 'The helper now names Accept too.' }],
    });
    const { tour, states } = await review(git.at(second), guide.runner, cacheDir);

    expect(guide.requests).toHaveLength(1);
    const prompt = guide.requests[0]?.prompt ?? '';
    expect(prompt).toContain('This is an update of an earlier tour');
    expect(prompt).toContain('3. [changed] edge: A helper names what varies');
    expect(prompt).toContain('2. [kept] core_change: The origin is reflected');
    // The changed line, and the changed lines beside it, whose surroundings it changed.
    expect(prompt).toContain('- src/cors.ts new lines 6-8');
    // The update's own rules sit above the line; the earlier stops, PR data, below the diff.
    expect(prompt.indexOf('This is an update')).toBeLessThan(prompt.indexOf('# PR #7'));
    expect(prompt.indexOf('# PR #7')).toBeLessThan(prompt.indexOf("earlier tour's stops"));

    // Before the guide answered, the reviewer could read the kept stops, and only those.
    const shown = states.find((s) => s.state === 'working' && s.stops.length > 0);
    expect(shown?.state === 'working' && shown.updating).toBe(true);
    expect(shown?.state === 'working' && shown.stops.map((s) => s.title)).toEqual([
      'Why',
      'The origin is reflected',
      'Your call',
    ]);

    expect(tour.update?.dropped).toBe(0);
    expect(tour.problems).toEqual([]);
    expect(tour.tour.stops.map((s) => [s.title, s.updated])).toEqual([
      ['Why', false],
      ['The origin is reflected', false],
      ['A helper names what varies', true],
      ['Your call', false],
    ]);
    expect(tour.costs).toHaveLength(1);
  });

  test('a stop whose code changed and that the guide leaves alone is dropped, never left on the old lines', async () => {
    const git = await repo();
    const cacheDir = await mkdtemp(join(tmpdir(), 'docent-cache-'));
    cleanup.push(cacheDir);
    await review(git.at(await git.push(push1)), scripted(firstTour).runner, cacheDir);

    // The guide adds a stop for the new line instead of rewriting stop 3.
    const added = {
      ...vary,
      title: 'Accept varies too',
      body: 'Accept joins Origin.',
      citations: [cite('new', 7)],
      replaces: 0,
    };
    const { tour } = await review(
      git.at(await git.push(push2)),
      scripted({ stops: [added] }).runner,
      cacheDir,
    );

    expect(tour.update?.dropped).toBe(1);
    expect(tour.tour.stops.map((s) => s.title)).toEqual([
      'Why',
      'The origin is reflected',
      'Accept varies too',
      'Your call',
    ]);
    expect(tour.tour.stops[2]?.anchors).toEqual([cite('new', 7)]);
  });

  test('an update that leaves the new lines unexplained is sent back, as a whole tour would be', async () => {
    const git = await repo();
    const cacheDir = await mkdtemp(join(tmpdir(), 'docent-cache-'));
    cleanup.push(cacheDir);
    await review(git.at(await git.push(push1)), scripted(firstTour).runner, cacheDir);

    // First it only retitles the intent; the repair then explains the new line.
    const guide = scripted(
      { stops: [{ ...intent, replaces: 1, title: 'Why, still' }] },
      { stops: [{ ...vary, replaces: 0, title: 'Accept varies', citations: [cite('new', 7)] }] },
    );
    const { tour } = await review(git.at(await git.push(push2)), guide.runner, cacheDir);

    expect(guide.requests).toHaveLength(2);
    expect(guide.requests[1]?.prompt).toContain('new since the earlier tour and not proven');
    expect(guide.requests[1]?.resume).toBe('session-1');
    expect(tour.problems).toEqual([]);
    expect(tour.tour.stops.filter((s) => s.updated).map((s) => s.title)).toEqual([
      'Why, still',
      'Accept varies',
    ]);
  });

  test('code that only moved keeps its stops, on the lines where it is now, at no cost', async () => {
    const git = await repo();
    const cacheDir = await mkdtemp(join(tmpdir(), 'docent-cache-'));
    cleanup.push(cacheDir);
    await review(git.at(await git.push(push1)), scripted(firstTour).runner, cacheDir);

    // The comment is a new changed line, so the guide is asked, and it changes nothing; the
    // checker still holds the tour to the rule that new lines are explained.
    const guide = scripted(
      { stops: [] },
      {
        stops: [
          {
            ...intent,
            kind: 'edge',
            replaces: 0,
            title: 'A header comment',
            citations: [cite('new', 1)],
          },
        ],
      },
    );
    const { tour } = await review(git.at(await git.push(push2Moved)), guide.runner, cacheDir);

    const kept = tour.tour.stops.find((s) => s.title === 'A helper names what varies');
    expect(kept?.anchors).toEqual([cite('new', 7, 9)]);
    expect(kept?.updated).toBe(false);
    expect(tour.tour.stops.find((s) => s.title === 'The origin is reflected')?.anchors).toEqual([
      cite('new', 3),
      cite('old', 2),
    ]);
  });

  test('a new head with the same changes, like a rebase, keeps the tour with no model call', async () => {
    const git = await repo();
    const cacheDir = await mkdtemp(join(tmpdir(), 'docent-cache-'));
    cleanup.push(cacheDir);
    await review(git.at(await git.push(push1)), scripted(firstTour).runner, cacheDir);

    const guide = scripted();
    const { tour } = await review(git.at(await git.push({})), guide.runner, cacheDir);

    expect(guide.requests).toEqual([]);
    expect(tour.costs).toEqual([]);
    expect(tour.update).toEqual(expect.objectContaining({ dropped: 0 }));
    expect(tour.tour.stops.map((s) => s.title)).toEqual(firstTour.stops.map((s) => s.title));
  });

  test('a changed description writes a whole tour: kept flags were checked against the old one', async () => {
    const git = await repo();
    const cacheDir = await mkdtemp(join(tmpdir(), 'docent-cache-'));
    cleanup.push(cacheDir);
    await review(git.at(await git.push(push1)), scripted(firstTour).runner, cacheDir);

    const guide = scripted({
      stops: [intent, origin, { ...vary, citations: [cite('new', 6, 8)] }, verdict],
    });
    const { tour } = await review(
      git.at(await git.push(push2), 'Now also names Accept.'),
      guide.runner,
      cacheDir,
    );

    expect(guide.requests[0]?.prompt).not.toContain('This is an update');
    expect(tour.update).toBeNull();
    expect(tour.tour.stops.every((s) => !s.updated)).toBe(true);
  });

  test('a basis the cache cannot read means a whole tour, not a failure', async () => {
    const git = await repo();
    const cacheDir = await mkdtemp(join(tmpdir(), 'docent-cache-'));
    cleanup.push(cacheDir);
    await review(git.at(await git.push(push1)), scripted(firstTour).runner, cacheDir);
    const file = join(
      cacheDir,
      'tour-bases',
      'acme__web',
      `pr-7-claude-test-p${TOUR_PROMPT_VERSION}.json`,
    );
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(2);
    await writeFile(file, '{ not json');

    const guide = scripted(firstTour);
    const { tour } = await review(git.at(await git.push(push2)), guide.runner, cacheDir);

    expect(guide.requests[0]?.prompt).not.toContain('This is an update');
    expect(tour.update).toBeNull();
  });
});

describe('retrying a failed update', () => {
  test('stays an update from the earlier head, and only then moves the basis to the new head', async () => {
    const git = await repo();
    const cacheDir = await mkdtemp(join(tmpdir(), 'docent-cache-'));
    cleanup.push(cacheDir);
    const first = await git.push(push1);
    await review(git.at(first), scripted(firstTour).runner, cacheDir);
    const file = join(
      cacheDir,
      'tour-bases',
      'acme__web',
      `pr-7-claude-test-p${TOUR_PROMPT_VERSION}.json`,
    );
    const basisHead = async () => JSON.parse(await readFile(file, 'utf8')).head;
    expect(await basisHead()).toBe(first);

    // The guide is down for the first try, then answers the retry like a normal update.
    const second = await git.push(push2);
    const answer = { stops: [{ ...vary, replaces: 3, body: 'The helper now names Accept too.' }] };
    const requests: AgentRequest[] = [];
    const runner: AgentRunner = async (request) => {
      requests.push(request);
      if (requests.length === 1) throw new Error('model unavailable');
      return {
        sessionId: 'session-1',
        text: '',
        structured: answer,
        denials: [],
        cost: cost(request.job, 1500),
      } satisfies AgentReply;
    };
    const opened = new Review({
      source: git.at(second),
      runner,
      locator: fixedSession({ found: false, reason: 'none' }),
      model: 'claude-test',
      cacheDir,
    });
    await opened.done;
    expect(opened.snapshot().tour.state).toBe('failed');
    // The failed update left the basis where it was: the next try still starts from the first head.
    expect(await basisHead()).toBe(first);

    // `done` covers only the first try. The retry's state is working from the moment it starts,
    // so subscribing right after it begins sees its end, not the failure before it.
    expect(opened.retry()).toBe(true);
    const settled = new Promise<void>((resolve) => {
      opened.subscribe((state) => {
        if (state.state === 'ready' || state.state === 'failed') resolve();
      });
    });
    await settled;
    await opened.close();
    const tour = opened.snapshot().tour;
    if (tour.state !== 'ready') throw new Error(`Tour is ${tour.state}: ${JSON.stringify(tour)}`);

    // Both tries asked for an update of the earlier tour, not a whole new one.
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.prompt).toContain('This is an update of an earlier tour');
      expect(request.prompt).toContain('2. [kept] core_change: The origin is reflected');
    }
    // The reviewer gets the kept stops, with the rewritten one marked.
    expect(tour.update).toEqual(expect.objectContaining({ from: first, dropped: 0 }));
    expect(tour.problems).toEqual([]);
    expect(tour.tour.stops.map((s) => [s.title, s.updated])).toEqual([
      ['Why', false],
      ['The origin is reflected', false],
      ['A helper names what varies', true],
      ['Your call', false],
    ]);
    expect(await basisHead()).toBe(second);
  });
});

describe('a push can never slip a change past an update', () => {
  // A second changed file the first tour leaves off its route: a check, then an audit call.
  const guard = (lines: string[]) => ({
    ...push1,
    'src/guard.ts': `export function guard(user: { admin: boolean }) {\n${lines.join('\n')}\n  return true;\n}\n`,
  });
  const check = '  if (!user.admin) return false;';
  const audit = '  audit(user);';

  async function pushed(second: Record<string, string>, ...answers: unknown[]) {
    const git = await repo();
    const cacheDir = await mkdtemp(join(tmpdir(), 'docent-cache-'));
    cleanup.push(cacheDir);
    await review(
      git.at(await git.push(guard([check, audit]))),
      scripted(firstTour).runner,
      cacheDir,
    );
    const guide = scripted(...answers);
    const { tour } = await review(git.at(await git.push(second)), guide.runner, cacheDir);
    return { guide, tour };
  }
  const explainGuard = {
    stops: [
      {
        ...vary,
        replaces: 0,
        title: 'The guard changed',
        citations: [{ ...cite('new', 1, 4), path: 'src/guard.ts' }],
      },
    ],
  };

  test('a changed line moved within its file, outside every cited range, counts as new', async () => {
    const { guide, tour } = await pushed(guard([audit, check]), explainGuard);

    expect(guide.requests).toHaveLength(1);
    expect(guide.requests[0]?.prompt).toContain('- src/guard.ts new lines');
    expect(tour.tour.stops.some((s) => s.title === 'The guard changed' && s.updated)).toBe(true);
  });

  test('a changed line taken out is not passed over: the guide is asked', async () => {
    const { guide } = await pushed(guard([audit]), explainGuard);

    expect(guide.requests).toHaveLength(1);
    expect(guide.requests[0]?.prompt).toContain('This is an update');
  });

  test('a danger flag is never dropped with its stale stop: the guide must rewrite it', async () => {
    const git = await repo();
    const cacheDir = await mkdtemp(join(tmpdir(), 'docent-cache-'));
    cleanup.push(cacheDir);
    const danger = { ...vary, flags: [{ kind: 'danger', note: 'Varies on nothing useful.' }] };
    await review(
      git.at(await git.push(push1)),
      scripted({ stops: [intent, origin, danger, verdict] }).runner,
      cacheDir,
    );

    // First the guide leaves the flagged stop alone; it is sent back, and rewrites it.
    const guide = scripted({ stops: [] }, { stops: [{ ...danger, replaces: 3 }] });
    const { tour } = await review(git.at(await git.push(push2)), guide.runner, cacheDir);

    expect(guide.requests[0]?.prompt).toContain('Flag danger: Varies on nothing useful.');
    expect(guide.requests[1]?.prompt).toContain('Stop 3 carried a danger flag');
    expect(tour.tour.stops[2]?.flags).toEqual(['danger']);
    expect(tour.update?.dropped).toBe(0);
  });
});
