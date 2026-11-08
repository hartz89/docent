import { describe, expect, test } from 'vitest';
import { costRecord, readOnlyOptions } from './agent.ts';

describe('the guide session is read-only', () => {
  test('pins the exact options that keep the session read-only', () => {
    // If this fails, the change loosens the sandbox. Re-run `DOCENT_LIVE=1 pnpm exec vitest run
    // --project server agent.live` and get a tier 2 review before updating it.
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
});
