import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, test } from 'vitest';

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

test('--prepare refuses --no-cache, since caching is its whole job', async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'docent-cli-'));

  await expect(docent('review', '--fixture', fixture, '--prepare', '--no-cache')).rejects.toThrow(
    /cannot be used with --no-cache/,
  );
});
