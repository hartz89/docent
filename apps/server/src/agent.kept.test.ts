// sdkRunner's kept fork, with the SDK scripted: whatever happens, the fork's saved transcript
// leaves Claude Code's projects folder, and the session it forked is never touched.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

type Script = (options: { sessionId?: string }) => AsyncGenerator<unknown>;
let script: Script;
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: { sessionId?: string } }) => script(options),
}));
const { AgentError, sdkRunner } = await import('./agent.ts');

const AUTHOR = '11111111-2222-4333-8444-555555555555';
let project = '';
let kept = '';

beforeEach(async () => {
  const config = await mkdtemp(join(tmpdir(), 'docent-config-'));
  project = join(config, 'projects', '-checkout');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, `${AUTHOR}.jsonl`), '{"type":"user"}\n');
  kept = await mkdtemp(join(tmpdir(), 'docent-kept-'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', config);
});
afterEach(() => vi.unstubAllEnvs());

const usage = {
  input_tokens: 1,
  output_tokens: 1,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};
const result = (sessionId: string, subtype: string) => ({
  type: 'result',
  subtype,
  is_error: subtype !== 'success',
  session_id: sessionId,
  result: 'Ready.',
  permission_denials: [],
  errors: [],
  usage,
});

/** Claude Code saving the fork as it runs, under the id Docent chose. */
const save = async (id: string | undefined) => {
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  await writeFile(join(project, `${id}.jsonl`), '{"type":"user"}\n');
};

const prime = () =>
  sdkRunner({
    job: 'question',
    prompt: 'Reply with just: Ready.',
    cwd: '/checkout',
    model: 'claude-test',
    fork: AUTHOR,
    keepIn: kept,
  });

test('a primer that succeeds is moved out, under the id Docent chose', async () => {
  let chosen: string | undefined;
  script = async function* (options) {
    chosen = options.sessionId;
    await save(chosen);
    yield { type: 'system', subtype: 'init', session_id: chosen };
    yield result(chosen ?? '', 'success');
  };

  const reply = await prime();

  expect(reply.sessionId).toBe(chosen);
  expect(await readdir(kept)).toEqual([`${chosen}.jsonl`]);
  expect(await readdir(project)).toEqual([`${AUTHOR}.jsonl`]);
});

test('a primer that runs over budget is deleted, and the author session is untouched', async () => {
  script = async function* (options) {
    await save(options.sessionId);
    // Even a message naming the session it forks can't point the cleanup at the original.
    yield { type: 'system', subtype: 'init', session_id: AUTHOR };
    yield result(options.sessionId ?? '', 'error_max_budget_usd');
  };

  await expect(prime()).rejects.toBeInstanceOf(AgentError);

  expect(await readdir(project)).toEqual([`${AUTHOR}.jsonl`]);
  expect(await readdir(kept)).toEqual([]);
});

test('a primer that stops before saying anything is still deleted', async () => {
  script = async function* (options) {
    await save(options.sessionId);
    yield* [];
    throw new Error('Claude Code exited');
  };

  await expect(prime()).rejects.toThrow('Claude Code exited');

  expect(await readdir(project)).toEqual([`${AUTHOR}.jsonl`]);
  expect(existsSync(join(project, `${AUTHOR}.jsonl`))).toBe(true);
});
