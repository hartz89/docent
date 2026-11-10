import { join } from 'node:path';
import type { CostRecord, MicroUsd } from '@docent/core';
import {
  type AgentRequest,
  type AgentRunner,
  fixtureRunner,
  fixtureSource,
} from '@docent/server/evals';
import { describe, expect, test } from 'vitest';
import { loadFixtures, PUBLIC_FIXTURES_DIR } from './fixtures.ts';
import { renderMarkdown, runFixture, runNeutralCheck, totals } from './tour-eval.ts';

// A recorded review of hono#4813, the same PR as the public fixture hono-4813-cors-credentials.
const RECORDED = join(import.meta.dirname, '..', '..', '..', 'e2e', 'fixtures', 'hono-4813');
const manifest = loadFixtures(PUBLIC_FIXTURES_DIR, 'public').manifests.find(
  (m) => m.id === 'hono-4813-cors-credentials',
);
if (!manifest) throw new Error('The hono-4813 fixture is missing.');

const cost = (micro: number): CostRecord => ({
  job: 'eval_judge',
  model: 'claude-test',
  tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  costMicroUsd: micro as MicroUsd,
  latencyMs: 1,
});

/** The recorded tour, plus a scripted judge that grades stops 1 to 5. */
function scripted(judge: unknown) {
  const tour = fixtureRunner(RECORDED);
  const requests: AgentRequest[] = [];
  const runner: AgentRunner = async (request) => {
    requests.push(request);
    if (request.job !== 'eval_judge') return tour(request);
    return { sessionId: 'j', text: '', structured: judge, cost: cost(20_000), denials: [] };
  };
  return { runner, requests };
}

const grade = (stop: number, behaviorFirst: boolean, unfoundedOpinion: boolean) => ({
  stop,
  behaviorFirst,
  unfoundedOpinion,
  why: 'Because.',
});
const judgment = {
  stops: [
    grade(1, true, false),
    grade(2, false, false),
    grade(3, true, true),
    grade(4, true, false),
    grade(5, false, false),
  ],
  findings: [{ finding: 1, explained: true, stop: 3, why: 'Stop 3 says any origin is echoed.' }],
};

const run = async (runner: AgentRunner) =>
  runFixture({
    manifest,
    workspace: await fixtureSource(RECORDED)(() => {}),
    prompt: 2,
    runner,
    model: 'claude-test',
    judgeModel: 'claude-judge',
    judgeCwd: '/nowhere',
  });

describe('the tour eval', () => {
  test('scores a tour on defects, danger flags, stop quality and cost', async () => {
    const { runner, requests } = scripted(judgment);
    const result = await run(runner);

    if (result.status !== 'ok') throw new Error(result.error);
    expect(result.findings).toEqual([
      {
        file: 'src/middleware/cors/index.ts',
        lines: { start: 80, end: 82 },
        externalKnowledge: false,
        cited: true,
        explained: true,
      },
    ]);
    expect(result.danger).toEqual({ expected: true, raised: true });
    // The verdict_prompt stop isn't graded.
    expect(result.stops.map((s) => s.stop)).toEqual([1, 2, 3, 4, 5]);
    // The recorded v2 tour opens every stop with code.
    expect(result.stops.every((s) => s.mechanical.codeInFirstSentence)).toBe(true);
    expect(result.judgeUsd).toBe(0.02);

    const judge = requests.find((r) => r.job === 'eval_judge');
    expect(judge?.model).toBe('claude-judge');
    expect(judge?.prompt).toContain('Defect 1: src/middleware/cors/index.ts line 80-82');
    // The judge grades blind: nothing says which prompt version wrote the tour.
    expect(judge?.prompt).not.toMatch(/\bv2\b|version/i);

    const t = totals([result], 2);
    expect(t.findings).toEqual({ expected: 1, cited: 1, explained: 1 });
    expect(t.quality.behaviorFirst).toBe(0.6);
    expect(t.unfoundedOpinions).toBe(1);
    expect(t.quality.plainFirstSentence).toBe(0);

    const markdown = renderMarkdown({
      date: '2026-11-08',
      model: 'claude-test',
      judgeModel: 'claude-judge',
      judgeRubric: 1,
      runs: [result],
      prompts: [2],
    });
    expect(markdown).toContain('| Defects explained, cited (judge) | 1/1 |');
    expect(markdown).toContain('| Stops with an unfounded opinion (judge, target 0) | 1 (20%) |');
    expect(markdown).toContain('| First sentence states the behavior change (judge) | 60% |');
  });

  test('a judge that skips a stop fails the run, and its paid call still counts', async () => {
    const { runner } = scripted({ ...judgment, stops: judgment.stops.slice(1) });
    const result = await run(runner);

    expect(result).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('stop 1'),
      judgeUsd: 0.02,
    });
  });

  test('a failed run keeps its defects in the totals, as missed, and the report says so', async () => {
    const result = await run(async () => {
      throw new Error('model unavailable');
    });

    expect(result).toMatchObject({ status: 'failed', tourUsd: 0, judgeUsd: 0 });
    expect(totals([result], 2)).toMatchObject({
      fixtures: 1,
      failed: 1,
      findings: { expected: 1, cited: 0, explained: 0 },
    });
    const markdown = renderMarkdown({
      date: '2026-11-08',
      model: 'm',
      judgeModel: 'j',
      judgeRubric: 1,
      runs: [result],
      prompts: [2],
    });
    expect(markdown).toContain(
      '| Defects explained, cited (judge) | 0/1 (1 failed run, counted as missed) |',
    );
    expect(markdown).toContain('**failed**, 1 defect(s) counted as missed');
  });

  test('a defect counts as explained only if the stop the judge names cites its lines', async () => {
    // Stop 5 is about the tests; it never cites the middleware lines where the defect lives.
    const finding = { finding: 1, explained: true, stop: 5, why: 'Stop 5 describes it.' };
    const { runner } = scripted({ ...judgment, findings: [finding] });
    const result = await run(runner);

    if (result.status !== 'ok') throw new Error(result.error);
    expect(result.findings[0]).toMatchObject({ cited: true, explained: false });
  });

  test('the neutral check reads first sentences blind and scores each prompt', async () => {
    const { runner } = scripted(judgment);
    const v2 = await run(runner);
    const v3 = { ...(await run(runner)), prompt: 3 as const };
    const prompts: string[] = [];
    const neutral: AgentRunner = async (request) => {
      prompts.push(request.prompt);
      const items = [...request.prompt.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
      // Every other sentence reads clearly.
      const answers = items.map((item) => ({ item, clear: item % 2 === 1 }));
      return { sessionId: 'n', text: '', structured: { answers }, cost: cost(10_000), denials: [] };
    };

    const error = await runNeutralCheck({
      runs: [v2, v3],
      prTitle: 'fix(cors): credentials',
      runner: neutral,
      judgeModel: 'claude-judge',
      judgeCwd: '/nowhere',
    });

    expect(error).toBeNull();
    // One call for the fixture, with all ten first sentences, backticks stripped, no version.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('10. ');
    expect(prompts[0]).not.toContain('`');
    expect(prompts[0]).not.toMatch(/\bv[23]\b|version/i);
    const read = totals([v2, v3], 2).neutral.read + totals([v2, v3], 3).neutral.read;
    const clear = totals([v2, v3], 2).neutral.clear + totals([v2, v3], 3).neutral.clear;
    expect({ read, clear }).toEqual({ read: 10, clear: 5 });
    // The call's cost is split over the runs.
    expect(v2.judgeUsd).toBeCloseTo(0.025);
  });
});
