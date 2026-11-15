import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, test, vi } from 'vitest';

// Each test spawns real Node processes, which can be slow on a cold CI runner.
vi.setConfig({ testTimeout: 30_000 });

// The real CLI, replaying a recorded review: no GitHub or model calls.
const cli = fileURLToPath(new URL('cli.ts', import.meta.url));
const fixture = fileURLToPath(new URL('../../../e2e/fixtures/hono-4813', import.meta.url));

let cacheDir = '';
afterEach(() => rm(cacheDir, { recursive: true, force: true }));

const docent = (...args: string[]) =>
  promisify(execFile)(process.execPath, [cli, ...args], {
    env: {
      ...process.env,
      DOCENT_CACHE_DIR: cacheDir,
      DOCENT_DATA_DIR: join(cacheDir, 'data'),
      DOCENT_RUN_LOG: '',
      CI: '1',
    },
  });
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

test('stops promptly on SIGTERM, even while a browser is still following the tour', async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'docent-cli-'));
  // A slow replay stands in for a slow machine: the tour is still being written when it stops.
  const child = spawn(
    process.execPath,
    [cli, 'review', '--fixture', fixture, '--replay-pace', '200'],
    {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, DOCENT_DATA_DIR: join(cacheDir, 'data'), DOCENT_RUN_LOG: '', CI: '1' },
    },
  );
  try {
    const link = await new Promise<string>((resolve) => {
      if (!child.stdout) throw new Error('No stdout');
      createInterface({ input: child.stdout }).on('line', (line) => {
        const match = line.match(/https?:\/\/\S+/);
        if (match) resolve(match[0]);
      });
    });
    const { origin, hash } = new URL(link);
    const token = new URLSearchParams(hash.slice(1)).get('token');
    const events = await fetch(`${origin}/api/review/events`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // The progress stream is open, as it is in a browser while the guide writes.
    await events.body?.getReader().read();

    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const outcome = await Promise.race([
      exited.then(([code]) => code),
      new Promise((resolve) => setTimeout(() => resolve('still running after 5 s'), 5_000)),
    ]);
    expect(outcome).toBe(0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});
