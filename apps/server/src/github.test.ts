import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { defaultDataDir, explainGhFailure } from './github.ts';

// Shapes copied from real `gh api` failures: the response body on stdout, a summary on stderr.
describe('explainGhFailure', () => {
  test('a missing gh, or a missing login, says how to fix it', () => {
    expect(explainGhFailure({ code: 'ENOENT' })).toMatch(/isn't installed/);
    expect(
      explainGhFailure({
        code: 4,
        stderr: 'To get started with GitHub CLI, please run:  gh auth login',
      }),
    ).toMatch(/isn't signed in/);
    expect(
      explainGhFailure({
        stdout: '{"message":"Bad credentials"}',
        stderr: 'gh: Bad credentials (HTTP 401)',
      }),
    ).toMatch(/isn't signed in/);
  });

  test('approving your own PR points to Comment instead', () => {
    const stdout = JSON.stringify({
      message: 'Unprocessable Entity',
      errors: ['Can not approve your own pull request'],
    });

    expect(explainGhFailure({ stdout, stderr: 'gh: Unprocessable Entity (HTTP 422)' })).toBe(
      "GitHub doesn't let you approve your own pull request. Choose Comment instead.",
    );
  });

  test("anything else passes on GitHub's own words", () => {
    const stdout = JSON.stringify({
      message: 'Unprocessable Entity',
      errors: ['Review body is too long'],
    });

    expect(explainGhFailure({ stdout, stderr: 'gh: Unprocessable Entity (HTTP 422)' })).toBe(
      "GitHub didn't accept the review: Review body is too long",
    );
  });
});

// The Claude Code hook can't import `defaultDataDir`, so it computes the folder itself. Both must
// land in the same place, or Docent never sees the hook's records.
describe('defaultDataDir', () => {
  const hook = fileURLToPath(
    new URL('../../../packages/claude-code/hooks/record-session.mjs', import.meta.url),
  );
  const session = '7e2cfb5b-77c5-46af-9de2-27ca9a1c1f85';
  const vars = ['HOME', 'USERPROFILE', 'DOCENT_DATA_DIR', 'XDG_DATA_HOME', 'LOCALAPPDATA'];

  /** Sets exactly these variables (unset when undefined), runs `body`, then puts them back. */
  async function withEnv<T>(env: Record<string, string | undefined>, body: () => Promise<T>) {
    const saved = Object.fromEntries(vars.map((name) => [name, process.env[name]]));
    const apply = (values: Record<string, string | undefined>) => {
      for (const name of vars) {
        const value = values[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    };
    apply(env);
    try {
      return await body();
    } finally {
      apply(saved);
    }
  }

  /** Runs the hook on a session start, under the current environment. */
  async function runHook() {
    const cwd = await mkdtemp(join(tmpdir(), 'docent-hook-cwd-'));
    spawnSync(process.execPath, [hook], {
      input: JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: session,
        transcript_path: join(cwd, `${session}.jsonl`),
        cwd,
      }),
      env: { ...process.env },
    });
  }

  test("with no override, the hook writes into the server's OS default folder", async () => {
    const home = await mkdtemp(join(tmpdir(), 'docent-home-'));
    await withEnv({ HOME: home, USERPROFILE: home }, async () => {
      const dir = defaultDataDir();
      await runHook();
      expect(dir.startsWith(home)).toBe(true);
      expect(existsSync(join(dir, 'sessions', `${session}.json`))).toBe(true);
    });
  });

  test('both follow DOCENT_DATA_DIR', async () => {
    const data = await mkdtemp(join(tmpdir(), 'docent-data-'));
    const { HOME, USERPROFILE } = process.env;
    await withEnv({ HOME, USERPROFILE, DOCENT_DATA_DIR: data }, async () => {
      expect(defaultDataDir()).toBe(data);
      await runHook();
      expect(existsSync(join(data, 'sessions', `${session}.json`))).toBe(true);
    });
  });
});
