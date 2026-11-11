import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const HOOK = fileURLToPath(new URL('../hooks/record-session.mjs', import.meta.url));
const SESSION = '7e2cfb5b-77c5-46af-9de2-27ca9a1c1f85';
const PROJECT = '/Users/someone/.claude/projects/-Users-someone-repo';

/** Runs the hook as Claude Code does: the event as JSON on stdin. */
function runHook(input: unknown, dataDir: string) {
  return spawnSync(process.execPath, [HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...process.env, DOCENT_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    // No global config, and a fixed identity: CI has none.
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });

/** A checkout on branch `fix`, whose origin URL carries a token that must never be recorded. */
async function checkout() {
  const dir = await mkdtemp(join(tmpdir(), 'docent-hook-repo-'));
  git(dir, 'init', '-q', '-b', 'fix');
  git(dir, 'remote', 'add', 'origin', 'https://x-access-token:ghs_secret@github.com/acme/web.git');
  return dir;
}

async function records(dataDir: string) {
  const dir = join(dataDir, 'sessions');
  const names = (await readdir(dir)).sort();
  return Promise.all(
    names.map(async (name) => ({ name, ...JSON.parse(await readFile(join(dir, name), 'utf8')) })),
  );
}

test('a session start records the session, its checkout, branch and origin', async () => {
  const repo = await checkout();
  const dataDir = await mkdtemp(join(tmpdir(), 'docent-data-'));

  const result = runHook(
    {
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: SESSION,
      transcript_path: `${PROJECT}/${SESSION}.jsonl`,
      cwd: repo,
    },
    dataDir,
  );

  // Nothing printed: SessionStart output would land in the author's context.
  expect(result).toMatchObject({ status: 0, stdout: '', stderr: '' });
  const [record] = await records(dataDir);
  expect(record).toEqual({
    name: `${SESSION}.json`,
    version: 1,
    event: 'SessionStart',
    sessionId: SESSION,
    agentId: null,
    parentSessionId: null,
    cwd: repo,
    branch: 'fix',
    origin: 'https://github.com/acme/web.git',
    transcriptPath: `${PROJECT}/${SESSION}.jsonl`,
    recordedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
  });
  // Only the author can read records.
  expect((await stat(join(dataDir, 'sessions', `${SESSION}.json`))).mode & 0o777).toBe(0o600);
});

test("a subagent start records the agent, its parent, and the subagent's own transcript", async () => {
  // The subagent works in a linked worktree on its own branch, as isolated subagents do.
  const repo = await checkout();
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init', '--no-gpg-sign');
  const worktree = join(repo, '..', `${repo.split('/').at(-1)}-wt`);
  git(repo, 'worktree', 'add', '-q', '-b', 'subagent-work', worktree);
  const dataDir = await mkdtemp(join(tmpdir(), 'docent-data-'));

  runHook(
    {
      hook_event_name: 'SubagentStart',
      session_id: SESSION,
      agent_id: 'a56fac17cea3321fb',
      agent_type: 'general-purpose',
      transcript_path: `${PROJECT}/${SESSION}.jsonl`,
      cwd: join(worktree),
    },
    dataDir,
  );

  expect(await records(dataDir)).toEqual([
    expect.objectContaining({
      name: `${SESSION}.agent-a56fac17cea3321fb.json`,
      event: 'SubagentStart',
      sessionId: SESSION,
      agentId: 'a56fac17cea3321fb',
      parentSessionId: SESSION,
      branch: 'subagent-work',
      origin: 'https://github.com/acme/web.git',
      transcriptPath: `${PROJECT}/${SESSION}/subagents/agent-a56fac17cea3321fb.jsonl`,
    }),
  ]);
});

test('outside a git checkout, branch and origin are null', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'docent-hook-plain-'));
  const dataDir = await mkdtemp(join(tmpdir(), 'docent-data-'));

  runHook(
    {
      hook_event_name: 'SessionStart',
      session_id: SESSION,
      transcript_path: `${PROJECT}/${SESSION}.jsonl`,
      cwd: dir,
    },
    dataDir,
  );

  expect(await records(dataDir)).toEqual([
    expect.objectContaining({ cwd: dir, branch: null, origin: null }),
  ]);
});

test('bad input writes nothing, prints nothing and still exits 0', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'docent-data-'));
  const inputs = [
    'not json',
    { hook_event_name: 'PreToolUse', session_id: SESSION, transcript_path: '/t.jsonl', cwd: '/' },
    // An id that would escape the records folder.
    {
      hook_event_name: 'SessionStart',
      session_id: '../../x',
      transcript_path: '/t.jsonl',
      cwd: '/',
    },
    {
      hook_event_name: 'SubagentStart',
      session_id: SESSION,
      agent_id: '../evil',
      transcript_path: '/t.jsonl',
      cwd: '/',
    },
  ];

  for (const input of inputs) {
    expect(runHook(input, dataDir)).toMatchObject({ status: 0, stdout: '', stderr: '' });
  }
  await expect(readdir(join(dataDir, 'sessions'))).rejects.toThrow();
});
