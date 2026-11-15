import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type CommitSha, commitSha } from '@docent/core';
import { beforeAll, describe, expect, test } from 'vitest';
import { explainGhFailure, prefetchBlobs } from './github.ts';

const run = promisify(execFile);

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

/** Plain git for building test repos, with no user config (signing, hooks) in the way. */
async function sh(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', dir, ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  return stdout;
}

const missingBlobs = async (dir: string, sha: CommitSha) =>
  (await sh(dir, 'rev-list', '--objects', '--no-object-names', '--missing=print', sha))
    .split('\n')
    .filter((line) => line.startsWith('?')).length;

describe('prefetchBlobs', () => {
  let origin: string;
  let sha: CommitSha;

  beforeAll(async () => {
    origin = await mkdtemp(join(tmpdir(), 'docent-prefetch-'));
    await sh(origin, 'init', '--quiet', '--initial-branch=main');
    await writeFile(join(origin, 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(origin, 'b.ts'), 'export const b = 2;\n');
    await sh(origin, 'add', '-A');
    await sh(origin, 'commit', '--quiet', '-m', 'one');
    sha = commitSha((await sh(origin, 'rev-parse', 'HEAD')).trim());
  });

  test('a checkout that already has every blob asks for nothing', async () => {
    expect(await prefetchBlobs(origin, [sha])).toBe(0);
  });

  test('it fetches only through the hardened git, and a refused fetch is quiet', async () => {
    // A blobless clone made with plain git, whose remote is on disk. Docent's git never speaks
    // the file transport, so the batch fetch is refused: nothing arrives, and nothing throws.
    await sh(origin, 'config', 'uploadpack.allowFilter', 'true');
    const parent = await mkdtemp(join(tmpdir(), 'docent-prefetch-clone-'));
    const clone = join(parent, 'clone');
    await sh(
      parent,
      'clone',
      '--quiet',
      '--no-checkout',
      '--filter=blob:none',
      `file://${origin}`,
      clone,
    );
    expect(await missingBlobs(clone, sha)).toBe(2);

    expect(await prefetchBlobs(clone, [sha])).toBe(0);
    expect(await missingBlobs(clone, sha)).toBe(2);
  });
});
