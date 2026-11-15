import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseUnifiedDiff } from '@docent/core';
import { describe, expect, test } from 'vitest';
import type { AgentRequest } from './agent.ts';
import { fixtureRunner, fixtureSource } from './fixture.ts';
import {
  compareRoute,
  generateTour,
  routeTourSchema,
  TOUR_PROMPT_VERSION,
  TOUR_PROMPTS,
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
