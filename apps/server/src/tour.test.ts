import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseUnifiedDiff } from '@docent/core';
import { describe, expect, test } from 'vitest';
import type { AgentRequest } from './agent.ts';
import { fixtureRunner, fixtureSource } from './fixture.ts';
import { generateTour, TOUR_PROMPT_VERSION, TOUR_PROMPTS } from './tour.ts';

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
  });

  test('new tours use the current prompt, and an eval run can pick an older one', async () => {
    const { workspace, diff } = await recorded();
    const prompts: string[] = [];
    const replay = fixtureRunner(FIXTURE);
    const runner = (request: AgentRequest) => {
      prompts.push(request.prompt);
      return replay(request);
    };
    const job = { workspace, diff, runner, model: 'claude-test', onProgress: () => {} };

    await generateTour(job);
    const second = prompts.length;
    await generateTour({ ...job, promptVersion: 2 });

    expect(TOUR_PROMPT_VERSION).toBe(4);
    expect(prompts[0]).toBe(TOUR_PROMPTS[4](workspace.pr, diff));
    expect(prompts[second]).toBe(TOUR_PROMPTS[2](workspace.pr, diff));
  });
});
