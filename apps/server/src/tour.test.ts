import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseUnifiedDiff } from '@docent/core';
import { describe, expect, test } from 'vitest';
import type { AgentRequest } from './agent.ts';
import { fixtureRunner, fixtureSource } from './fixture.ts';
import {
  compareRoute,
  fromCache,
  generateTour,
  referenceTourSchema,
  routeTourSchema,
  TOUR_PROMPT_VERSION,
  TOUR_PROMPTS,
  type TourOutcome,
  tourSchema,
} from './tour.ts';

const FIXTURE = join(import.meta.dirname, '..', '..', '..', 'e2e', 'fixtures', 'hono-4813');

async function recorded() {
  const workspace = await fixtureSource(FIXTURE)(() => {});
  const diff = parseUnifiedDiff(workspace.diffText, workspace.pr.base, workspace.pr.head);
  return { workspace, diff };
}

describe('tour prompt versions', () => {
  test('a shipped prompt never changes, so old A/B runs stay reproducible', async () => {
    const { workspace, diff } = await recorded();
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    // To change a shipped prompt, add a new version instead. The hash also covers the shared
    // coverage rules and diff rendering: changing those changes v2 too, so fork them first.
    expect(sha(TOUR_PROMPTS[2](workspace.pr, diff))).toBe(
      '420dcd0b8449c4f76bf860aaf2c2bc5fb40ab74da91e2a91f20d71c99a96a8c6',
    );
    expect(sha(TOUR_PROMPTS[3](workspace.pr, diff))).toBe(
      'f62bda8b9f6694ee41d3a11347f95dcb66f268c897a3aa372e008239cf9eff1a',
    );
    expect(sha(TOUR_PROMPTS[4](workspace.pr, diff))).toBe(
      '5c47b5a3540d1ec33dbe4b084465925962dfe08869e648d4d546d53c92b84e8e',
    );
    // Never shipped, but evaluated: frozen so its A/B against v4 can be rerun.
    expect(sha(TOUR_PROMPTS[5](workspace.pr, diff))).toBe(
      '384efbbd8dd113722579ff40f6499ea4d95ffbb2c9080ea5c905e5a85a98c67d',
    );
    // The references experiment, evaluated against v4.
    expect(sha(TOUR_PROMPTS[6](workspace.pr, diff))).toBe(
      '61b0dec0718ffaed4ae63dcb5750497703fcfdee6eb82129a7c7d9b794ed6a1b',
    );
  });

  test('new tours use the current prompt, and an eval run can pick an older one', async () => {
    const { workspace, diff } = await recorded();
    const requests: AgentRequest[] = [];
    const replay = fixtureRunner(FIXTURE);
    const runner = (request: AgentRequest) => {
      requests.push(request);
      return replay(request);
    };
    const job = { workspace, diff, runner, model: 'claude-test', proofs: [], onProgress: () => {} };

    await generateTour(job);
    const second = requests.length;
    await generateTour({ ...job, promptVersion: 2 });
    const third = requests.length;
    await generateTour({ ...job, promptVersion: 5 });
    const fourth = requests.length;
    await generateTour({ ...job, promptVersion: 6 });

    // The v6 experiment asks for references in the prose, in a schema of its own.
    expect(requests[fourth]?.prompt).toContain('Point at code from the prose, sparingly');
    expect(requests[fourth]?.schema).toBe(referenceTourSchema);
    expect(TOUR_PROMPT_VERSION).toBe(4);
    expect(requests[0]?.prompt).toBe(TOUR_PROMPTS[4](workspace.pr, diff));
    expect(requests[0]?.schema).toBe(tourSchema);
    expect(requests[second]?.prompt).toBe(TOUR_PROMPTS[2](workspace.pr, diff));
    // The v5 experiment asks for the route ahead of the stops, in a schema of its own.
    expect(requests[third]?.prompt).toContain('Write the route first');
    expect(requests[third]?.schema).toBe(routeTourSchema);
    expect(Object.keys(routeTourSchema.properties)[0]).toBe('route');
  });

  test('v5 streams its route ahead of the stops, and its repairs send no route', async () => {
    const { workspace, diff } = await recorded();
    const recordedReply = await fixtureRunner(FIXTURE)({
      job: 'tour',
      prompt: '',
      cwd: '',
      model: 'claude-test',
    });
    const { stops } = recordedReply.structured as { stops: { kind: string; title: string }[] };
    const route = stops.map((s) => s.title);
    // The first answer drops the verdict, so the checker asks for a repair that adds it.
    const replies = [
      { route, stops: stops.slice(0, -1) },
      { route: [], stops: [{ ...stops.at(-1), replaces: 0 }] },
    ];
    const requests: AgentRequest[] = [];
    const routes: string[][] = [];
    const runner = async (request: AgentRequest) => {
      const structured = replies[requests.length];
      requests.push(request);
      const json = JSON.stringify(structured);
      for (let at = 50; at < json.length + 50; at += 50) request.onOutput?.(json.slice(0, at));
      return { ...recordedReply, structured };
    };

    const outcome = await generateTour({
      workspace,
      diff,
      runner,
      model: 'claude-test',
      promptVersion: 5,
      proofs: [],
      onProgress: (p) => {
        if (p.step === 'writing') routes.push(p.route);
      },
    });

    expect(routes.at(-1)).toEqual(route);
    expect(requests[1]?.prompt).toContain('"route": an empty list');
    expect(outcome.problems).toEqual([]);
    expect(outcome.tour.stops.map((s) => s.title)).toEqual(route);
  });
});

describe('references in the prose', () => {
  type Ref = { phrase: string; path: string; side: string; startLine: number; endLine: number };
  type WireStop = { title: string; body: string; references?: Ref[] };
  const FILE = 'src/middleware/cors/index.ts';
  const ref = (phrase: string, startLine: number, endLine = startLine): Ref => ({
    phrase,
    path: FILE,
    side: 'new',
    startLine,
    endLine,
  });

  /** The recorded tour, with these references on stop 3, run through the real checker. */
  async function tourWith(references: Ref[] | undefined) {
    const { workspace, diff } = await recorded();
    const reply = await fixtureRunner(FIXTURE)({
      job: 'tour',
      prompt: '',
      cwd: '',
      model: 'claude-test',
    });
    const { stops } = reply.structured as { stops: WireStop[] };
    // Only stop 3 has references; the others have none at all, as in a tour from before them.
    const edited = stops.map(({ references: _, ...s }, i) =>
      i === 2 && references ? { ...s, references } : s,
    );
    const structured = { stops: edited };
    return generateTour({
      workspace,
      diff,
      runner: async () => ({ ...reply, structured }),
      model: 'claude-test',
      promptVersion: 6,
      proofs: [],
      onProgress: () => {},
    });
  }

  test('references that check out show as phrases of the body, pointing at their lines', async () => {
    const outcome = await tourWith([
      ref('the resolver returns `origin || null`', 80, 82),
      ref("`origin` defaults to `'*'`", 65),
    ]);
    const stop = outcome.tour.stops[2];
    expect(outcome.problems).toEqual([]);
    expect(stop?.refs.map((r) => stop.body.slice(r.start, r.end))).toEqual([
      'the resolver returns `origin || null`',
      "`origin` defaults to `'*'`",
    ]);
    expect(stop?.refs[0]).toMatchObject({
      state: 'current',
      path: FILE,
      side: 'new',
      startLine: 80,
      endLine: 82,
    });
    expect(outcome.references).toEqual({ written: 2, unresolved: 0, overCap: 0 });
  });

  test('a reference that does not check out is dropped, never sent back, and so is one past the cap', async () => {
    const outcome = await tourWith([
      ref('the resolver returns `origin || null`', 80, 82),
      ref('the resolver', 9000),
      ref('not in the body', 65),
      ref('origin || null', 80),
      { ...ref('Express', 1), side: 'sideways' },
      ref('`opts.credentials`', 80),
      ref('`optsOrigin', 77),
      ref('any website can now make credentialed requests', 80, 82),
      ref('line 65', 65),
    ]);
    const stop = outcome.tour.stops[2];
    // Nothing about a reference is a problem the guide must fix.
    expect(outcome.problems).toEqual([]);
    expect(outcome.attempts).toBe(1);
    // The first three placed, in text order: the rest go back to plain words.
    expect(stop?.refs.map((r) => stop.body.slice(r.start, r.end))).toEqual([
      '`opts.credentials`',
      'the resolver returns `origin || null`',
      'any website can now make credentialed requests',
    ]);
    // Unresolved: a range outside the file, a phrase not in the body, one inside a placed one,
    // the wrong shape, and one that splits a code span. Over the cap: "line 65".
    expect(outcome.references).toEqual({ written: 9, unresolved: 5, overCap: 1 });
  });

  test('a stop with no references is plain prose, as before', async () => {
    const outcome = await tourWith(undefined);
    expect(outcome.tour.stops[2]?.refs).toEqual([]);
    expect(outcome.tour.stops.every((s) => s.refs.length === 0)).toBe(true);
    expect(outcome.references).toEqual({ written: 0, unresolved: 0, overCap: 0 });
  });

  test('a tour cached before references existed reads back as plain prose', async () => {
    const outcome = await tourWith(undefined);
    const { references: _, ...old } = outcome;
    const stops = old.tour.stops.map(({ refs: _r, ...s }) => s);
    const cached = fromCache({ ...old, tour: { ...old.tour, stops } } as unknown as TourOutcome);
    expect(cached.tour.stops.every((s) => s.refs.length === 0)).toBe(true);
    expect(cached.references).toEqual({ written: 0, unresolved: 0, overCap: 0 });
    expect(cached.cached).toBe(true);
  });
});

describe('compareRoute', () => {
  test('a route matches only with the same titles, in the same order, and no more', () => {
    expect(compareRoute(['Why', 'The  fix'], ['Why', 'The fix'])).toEqual({
      planned: 2,
      written: 2,
      sameTitles: 2,
      matches: true,
    });
    expect(compareRoute(['Why', 'The fix', 'Your call'], ['Why', 'A new title'])).toMatchObject({
      sameTitles: 1,
      matches: false,
    });
    expect(compareRoute([], ['Why'])).toMatchObject({ planned: 0, sameTitles: 0, matches: false });
  });
});
