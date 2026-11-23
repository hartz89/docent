import { execFile } from 'node:child_process';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, test, vi } from 'vitest';

// Each test spawns real Node processes, which can be slow on a cold CI runner.
vi.setConfig({ testTimeout: 30_000 });

// The real CLI, replaying a recorded review: no GitHub or model calls.
const cli = fileURLToPath(new URL('cli.ts', import.meta.url));
const fixture = fileURLToPath(new URL('../../../e2e/fixtures/hono-4813', import.meta.url));

let cacheDir = '';
afterEach(() => rm(cacheDir, { recursive: true, force: true }));

const docentWith = (env: NodeJS.ProcessEnv, ...args: string[]) =>
  promisify(execFile)(process.execPath, [cli, ...args], {
    env: {
      ...process.env,
      DOCENT_CACHE_DIR: cacheDir,
      DOCENT_DATA_DIR: join(cacheDir, 'data'),
      DOCENT_RUN_LOG: '',
      CI: '1',
      ...env,
    },
  });
const docent = (...args: string[]) => docentWith({}, ...args);
const runFiles = () => readdir(join(cacheDir, 'data', 'runs')).catch(() => []);

test('--prepare caches the tour and exits, so the next open makes no model calls', async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'docent-cli-'));

  const first = await docent('review', '--fixture', fixture, '--prepare');
  expect(first.stdout).toMatch(/Tour ready in .*: 6 stops, 1 attempt\(s\), \$0\.\d{4} on /);
  expect(first.stdout).not.toContain('Docent is running');

  const second = await docent('review', '--fixture', fixture, '--prepare');
  expect(second.stdout).toContain('Tour loaded from cache: no model calls.');
});

test('two --prepare runs of one PR at once write and pay for the tour once', async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'docent-cli-'));
  // Paced, so the tour takes a few seconds and the two processes overlap.
  const run = () => docent('review', '--fixture', fixture, '--prepare', '--replay-pace', '40');

  const outputs = (await Promise.all([run(), run()])).map((r) => r.stdout);

  const paid = outputs.filter((out) => /Tour ready in .*\$0\.\d{4}/.test(out));
  const waited = outputs.filter((out) => out.includes('Tour loaded from cache: no model calls.'));
  expect(paid).toHaveLength(1);
  expect(waited).toHaveLength(1);
  expect(waited[0]).toContain('A tour for this PR is being written by another Docent');
});

test('--prepare exits with an error when the tour fails', async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'docent-cli-'));
  // The same recording with no guide replies, so the tour job fails.
  const broken = join(cacheDir, 'fixture');
  await cp(fixture, broken, { recursive: true, filter: (src) => !src.endsWith('replies.json') });

  await expect(docent('review', '--fixture', broken, '--prepare')).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('Tour failed:'),
  });
});

test.each(['--no-cache', '--record'])('--prepare refuses %s', async (flag) => {
  cacheDir = await mkdtemp(join(tmpdir(), 'docent-cli-'));
  const args = flag === '--record' ? [flag, join(cacheDir, 'rec')] : [flag];

  await expect(docent('review', '--fixture', fixture, '--prepare', ...args)).rejects.toThrow(
    `cannot be used with ${flag}`,
  );
});

test('each launch writes a run file, unless --no-run-log says not to', async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'docent-cli-'));

  await docent('review', '--fixture', fixture, '--prepare');
  expect(await runFiles()).toEqual([expect.stringMatching(/Z-fixture-hono-4813\.jsonl$/)]);
  await docent('review', '--fixture', fixture, '--prepare', '--no-run-log');
  expect(await runFiles()).toHaveLength(1);

  const { stdout } = await docent('runs', 'show', 'latest');
  // A real replayed run, not a hand-written one, reads the same way.
  expect(stdout).toContain(
    'questions go to the guide: This recorded review names no author session',
  );
  expect(stdout).toMatch(/tour attempt 1: passed, \$0\.\d{4}/);
  expect(stdout).toContain('run ended: prepared');
});

describe('--prepare says how to open the tour, the way Docent was started', () => {
  const pr = 'https://github.com/honojs/hono/pull/4813';
  // What npm and pnpm set for a child process: npx is `npm exec`, and `pnpm docent` runs the
  // repo's own script.
  const launches = {
    npx: { npm_command: 'exec', npm_lifecycle_event: 'npx', npm_config_omit: 'optional' },
    'pnpm docent': { npm_command: 'run-script', npm_lifecycle_event: 'docent' },
    'an installed docent': { npm_command: '', npm_lifecycle_event: '' },
  };
  const expected = {
    npx: /Open it with: npx --omit=optional @docent\/\w+@\d+\.\d+\.\d+ review https:\/\/github\.com\/honojs\/hono\/pull\/4813\n/,
    'pnpm docent': `Open it with: pnpm docent review ${pr}\n`,
    'an installed docent': `Open it with: docent review ${pr}\n`,
  };

  test.each(Object.keys(launches) as (keyof typeof launches)[])('from %s', async (launch) => {
    cacheDir = await mkdtemp(join(tmpdir(), 'docent-cli-'));

    const { stdout } = await docentWith(
      launches[launch],
      'review',
      pr,
      '--fixture',
      fixture,
      '--prepare',
    );

    expect(stdout).toMatch(expected[launch]);
  });
});

test('a review without Claude Code stops before fetching anything, and says how to install it', async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'docent-cli-'));

  await expect(
    docentWith(
      { PATH: join(cacheDir, 'empty'), DOCENT_CLAUDE_PATH: '' },
      'review',
      'https://github.com/honojs/hono/pull/4813',
      '--prepare',
    ),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("there's no `claude` on your PATH. Install it from"),
  });
});
