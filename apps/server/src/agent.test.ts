import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  costRecord,
  discardTranscript,
  forkCostEstimateUsd,
  keepTranscript,
  readOnlyOptions,
  sdkRunner,
} from './agent.ts';

describe('the guide session is read-only', () => {
  test('pins the exact options that keep the session read-only', () => {
    // If this fails, the change loosens the sandbox. Re-run `DOCENT_LIVE=1 pnpm exec vitest run
    // --project server agent.live` before updating it. Loosening these options weakens a gate, so
    // the PR escalates to the maintainer (docs/process/pull-requests.md).
    expect(readOnlyOptions({ cwd: '/checkout', model: 'claude-test' })).toEqual({
      cwd: '/checkout',
      model: 'claude-test',
      tools: ['Read', 'Grep', 'Glob'],
      permissionMode: 'dontAsk',
      strictMcpConfig: true,
      mcpServers: {},
      settingSources: [],
      maxTurns: 60,
      maxBudgetUsd: 2,
    });
  });

  test('adds only resume and the output schema when asked', () => {
    const options = readOnlyOptions({
      cwd: '/checkout',
      model: 'claude-test',
      resume: 'session-1',
      schema: { type: 'object' },
    });

    expect(options).toMatchObject({
      resume: 'session-1',
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      tools: ['Read', 'Grep', 'Glob'],
      permissionMode: 'dontAsk',
    });
  });

  test('a call whose signal is already aborted never starts', async () => {
    // An abort listener added now would never fire, leaving the session with no time limit.
    await expect(
      sdkRunner({
        job: 'question',
        prompt: 'never sent',
        cwd: '/nowhere',
        model: 'claude-test',
        signal: AbortSignal.abort(new Error('deadline passed')),
      }),
    ).rejects.toThrow('deadline passed');
  });

  test('a caller can lower or raise the spending cap', () => {
    expect(
      readOnlyOptions({ cwd: '/checkout', model: 'claude-test', maxBudgetUsd: 5 }).maxBudgetUsd,
    ).toBe(5);
  });

  test('a kept fork differs only in being saved, with one turn', () => {
    expect(
      readOnlyOptions({ cwd: '/checkout', model: 'claude-test', fork: 'author-1', keepIn: '/k' }),
    ).toEqual({
      ...readOnlyOptions({ cwd: '/checkout', model: 'claude-test', fork: 'author-1' }),
      persistSession: true,
      maxTurns: 1,
    });
  });

  test("forks the author's session with the same sandbox, and saves no copy", () => {
    // Fork, never resume in place: a resume would append to the author's own transcript.
    expect(readOnlyOptions({ cwd: '/checkout', model: 'claude-test', fork: 'author-1' })).toEqual({
      ...readOnlyOptions({ cwd: '/checkout', model: 'claude-test' }),
      resume: 'author-1',
      forkSession: true,
      persistSession: false,
    });
  });
});

describe('costRecord', () => {
  test('prices 5-minute cache writes at 1.25x input and 1-hour ones at 2x (K2)', () => {
    const record = costRecord(
      'tour',
      'claude-opus-5-5',
      {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 2_000_000,
        cache_creation: {
          ephemeral_5m_input_tokens: 1_000_000,
          ephemeral_1h_input_tokens: 1_000_000,
        },
      },
      10,
    );

    // $4 input + $20 output + $0.20 cache read + $5 (5m) + $8 (1h)
    expect(record.costMicroUsd).toBe(37_200_000);
  });

  test("prices Haiku 5.5 at its long-prompt rate once a request's prompt passes 100k", () => {
    const usage = {
      input_tokens: 0,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
    };

    // $0.50 output + $0.01 cache read, then $2.50 + $0.05 above 100k.
    expect(costRecord('question', 'claude-haiku-5-5', usage, 1, 90_000).costMicroUsd).toBe(510_000);
    expect(costRecord('question', 'claude-haiku-5-5', usage, 1, 200_000).costMicroUsd).toBe(
      2_550_000,
    );
    // Opus has one price at any length.
    expect(costRecord('question', 'claude-opus-5-5', usage, 1, 200_000).costMicroUsd).toBe(
      20_200_000,
    );
  });

  test('estimates a fork of a long session on Haiku at the long-prompt rate', () => {
    // 400k tokens written to a 1-hour cache: 2x the $0.50 long-prompt input price.
    expect(forkCostEstimateUsd('claude-haiku-5-5', 400_000)).toBeCloseTo(0.4);
    expect(forkCostEstimateUsd('claude-haiku-5-5', 50_000)).toBeCloseTo(0.01);
  });
});

describe("keeping a fork out of Claude Code's projects folder", () => {
  const id = '0a1b2c3d-1111-4222-8333-444455556666';
  afterEach(() => vi.unstubAllEnvs());

  /** A config folder holding one saved session, with a tool-results folder beside it. */
  async function saved() {
    const config = await mkdtemp(join(tmpdir(), 'docent-config-'));
    const project = join(config, 'projects', '-some-checkout');
    await mkdir(join(project, id), { recursive: true });
    await writeFile(join(project, `${id}.jsonl`), '{"type":"user"}\n');
    await writeFile(join(project, id, 'result.txt'), 'output');
    vi.stubEnv('CLAUDE_CONFIG_DIR', config);
    return project;
  }

  test('moves the transcript out, and deletes its tool results', async () => {
    const project = await saved();
    const kept = await mkdtemp(join(tmpdir(), 'docent-kept-'));

    expect(await keepTranscript(id, kept)).toBe(true);

    expect(await readdir(kept)).toEqual([`${id}.jsonl`]);
    expect(await readdir(project)).toEqual([]);
  });

  test('a failed move throws, and discarding then removes the saved copy', async () => {
    const project = await saved();

    await expect(
      keepTranscript(id, join(tmpdir(), 'docent-no-such-folder', 'x')),
    ).rejects.toThrow();
    await discardTranscript(id);

    expect(await readdir(project)).toEqual([]);
  });

  test('ignores a missing transcript and an id that is not a UUID', async () => {
    const project = await saved();
    const kept = await mkdtemp(join(tmpdir(), 'docent-kept-'));

    expect(await keepTranscript('9a1b2c3d-1111-4222-8333-444455556666', kept)).toBe(false);
    expect(await keepTranscript('../-some-checkout', kept)).toBe(false);
    await discardTranscript('../-some-checkout');

    expect(existsSync(join(project, `${id}.jsonl`))).toBe(true);
  });
});
