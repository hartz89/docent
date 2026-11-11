import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    env: { ...process.env, DOCENT_CACHE_DIR: cacheDir, CI: '1' },
  });

test('--prepare caches the tour and exits, so the next open makes no model calls', async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'docent-cli-'));

  const first = await docent('review', '--fixture', fixture, '--prepare');
  expect(first.stdout).toMatch(/Tour ready in .*: 6 stops, 1 attempt\(s\), \$0\.\d{4} on /);
  expect(first.stdout).not.toContain('Docent is running');

  const second = await docent('review', '--fixture', fixture, '--prepare');
  expect(second.stdout).toContain('Tour loaded from cache: no model calls.');
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

test('serve --stop stops the launcher on that port, by the PID it wrote', async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'docent-cli-'));
  const config = join(cacheDir, 'config.json');
  await writeFile(config, JSON.stringify({ allowedRepos: ['honojs/hono'] }));
  const env = { ...process.env, DOCENT_CACHE_DIR: cacheDir, DOCENT_CONFIG: config, CI: '1' };
  const launcher = spawn(process.execPath, [cli, 'serve', '--fixture', fixture, '--port', '0'], {
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = once(launcher, 'exit');
  const port = await new Promise<string>((resolve, reject) => {
    launcher.once('exit', (code) => reject(new Error(`docent serve exited early with ${code}`)));
    createInterface({ input: launcher.stdout }).on('line', (line) => {
      const match = /listening at http:\/\/127\.0\.0\.1:(\d+)/.exec(line);
      if (match?.[1]) resolve(match[1]);
    });
  });
  const stop = () =>
    promisify(execFile)(process.execPath, [cli, 'serve', '--stop', '--port', port], { env });

  expect((await stop()).stdout).toContain(`Stopped the launcher on port ${port}`);
  expect(await exited).toEqual([0, null]);
  expect((await stop()).stdout).toContain(`No launcher is running on port ${port}`);
});
