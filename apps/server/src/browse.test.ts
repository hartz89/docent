// The file browser serves files from an untrusted PR to the browser. These tests run the real
// endpoints over a real git repo, built to try to make them serve something they shouldn't.
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { commitSha } from '@docent/core';
import { hc } from 'hono/client';
import { beforeAll, describe, expect, test } from 'vitest';
import { type AppType, createApp } from './app.ts';
import { fixedSession } from './author-session.ts';
import { commitReader, MAX_FILE_BYTES } from './github.ts';
import { gitHeadFiles } from './head-files.ts';
import { Review } from './review.ts';

const run = promisify(execFile);
const origin = 'http://127.0.0.1:4123';
const token = 'test-token';

/** Plain git for building the test repo, with no user config (signing, hooks) in the way. */
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
  return stdout.trim();
}

async function put(root: string, path: string, content: string | Buffer) {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), content);
}

let api: ReturnType<typeof hc<AppType>>['api'];
let headReader: (max: number) => ReturnType<typeof commitReader>;

beforeAll(async () => {
  const outer = await mkdtemp(join(tmpdir(), 'docent-browse-'));
  const repo = join(outer, 'repo');
  await put(outer, 'secret-outside.txt', 'SECRET OUTSIDE THE REPO\n');
  await mkdir(repo);
  await sh(repo, 'init', '--quiet', '--initial-branch=main');

  // Base: the commit before the PR.
  await put(repo, 'README.md', 'base readme\n');
  await sh(repo, 'add', '-A');
  await sh(repo, 'commit', '--quiet', '-m', 'base');
  const base = commitSha(await sh(repo, 'rev-parse', 'HEAD'));

  // Head: what the PR's tour was written for.
  await put(repo, 'README.md', 'head readme\n');
  await put(repo, 'src/app.ts', 'export const app = 1;\n');
  await put(repo, 'logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  await put(repo, 'big.txt', 'x'.repeat(MAX_FILE_BYTES + 1));
  await put(repo, 'run.sh', 'echo hi\n');
  await chmod(join(repo, 'run.sh'), 0o755);
  await symlink('../secret-outside.txt', join(repo, 'escape-relative'));
  await symlink(join(outer, 'secret-outside.txt'), join(repo, 'escape-absolute'));
  await sh(repo, 'add', '-A');
  await sh(repo, 'commit', '--quiet', '-m', 'head');
  const head = commitSha(await sh(repo, 'rev-parse', 'HEAD'));
  headReader = (max) => commitReader(repo, base, head, max);

  // A later push, and edits on disk: neither is the commit under review.
  await put(repo, 'README.md', 'pushed after the tour\n');
  await sh(repo, 'commit', '--quiet', '-am', 'later');
  await put(repo, 'README.md', 'edited on disk\n');
  await put(repo, 'untracked.txt', 'never committed\n');

  const review = new Review({
    source: async () => ({
      pr: {
        url: 'https://github.com/acme/web/pull/7',
        repo: 'acme/web',
        number: 7,
        title: 'Browse',
        body: '',
        author: 'someone',
        base,
        head,
        baseRef: 'main',
        headRef: 'browse',
        handoff: null,
      },
      diffText: '',
      commitMessages: [],
      commitShas: [],
      headInBaseRepo: true,
      dir: repo,
      ...commitReader(repo, base, head),
      headFiles: () => gitHeadFiles(repo, head),
      currentHead: async () => head,
      postReview: async () => {
        throw new Error('not in this test');
      },
    }),
    runner: async () => {
      throw new Error('no model in this test');
    },
    locator: fixedSession({ found: false, reason: 'none' }),
    model: 'claude-test',
  });
  await review.done;
  const app = createApp({ origin, token, version: '0.0.0', review });
  api = hc<AppType>(origin, {
    fetch: app.request,
    headers: { Authorization: `Bearer ${token}` },
  }).api;
});

const open = (path: string, side: 'old' | 'new' = 'new') =>
  api.file.$get({ query: { path, side } });

async function text(path: string, side: 'old' | 'new' = 'new') {
  const res = await open(path, side);
  if (res.status !== 200) throw new Error(`${path} answered ${res.status}`);
  return (await res.json()).text;
}

describe('GET /api/tree', () => {
  test("lists every file at the PR's head commit, not the disk or a later push", async () => {
    const res = await api.tree.$get();
    if (res.status !== 200) throw new Error(`answered ${res.status}`);
    const body = await res.json();

    expect(body.truncated).toBe(false);
    expect(body.entries.map((e) => `${e.kind} ${e.path}`).sort()).toEqual([
      'file README.md',
      'file big.txt',
      'file logo.png',
      'file run.sh',
      'file src/app.ts',
      'symlink escape-absolute',
      'symlink escape-relative',
    ]);
  });

  test('stops at the cap, and says the list is cut short', async () => {
    const tree = await headReader(3).tree();

    expect(tree.entries).toHaveLength(3);
    expect(tree.truncated).toBe(true);
  });

  test('needs the token, like every other route', async () => {
    const anonymous = hc<AppType>(origin, {
      fetch: createApp({ origin, token, version: '0.0.0' }).request,
    }).api;

    expect((await anonymous.tree.$get()).status).toBe(401);
  });
});

describe('GET /api/file, for browsing', () => {
  test('serves files as they are at head, or at base when asked', async () => {
    expect(await text('README.md')).toBe('head readme\n');
    expect(await text('README.md', 'old')).toBe('base readme\n');
    expect(await text('src/app.ts')).toBe('export const app = 1;\n');
    expect(await text('run.sh')).toBe('echo hi\n');
  });

  test('never serves the working tree: untracked files are not there', async () => {
    expect((await open('untracked.txt')).status).toBe(404);
  });

  test("doesn't follow symlinks out of the repo", async () => {
    for (const path of ['escape-relative', 'escape-absolute']) {
      const res = await open(path);
      const body = JSON.stringify(await res.json());

      expect(res.status).toBe(415);
      expect(body).toMatch(/symbolic link/);
      expect(body).not.toContain('SECRET');
    }
  });

  test('refuses traversal, absolute paths, NUL bytes and dot segments', async () => {
    for (const path of [
      '../secret-outside.txt',
      'src/../../secret-outside.txt',
      '/etc/passwd',
      'README.md\0',
      './README.md',
      'src/./app.ts',
      '--output=/tmp/x',
    ]) {
      expect((await open(path)).status, path).toBe(400);
    }
  });

  test('a folder or a revision-like path is not a file', async () => {
    expect((await open('src')).status).toBe(404);
    expect((await open('HEAD:README.md')).status).toBe(404);
    expect((await open('*.md')).status).toBe(404);
  });

  test('binary and oversized files are named, not sent', async () => {
    const binary = await open('logo.png');
    const big = await open('big.txt');

    expect(binary.status).toBe(415);
    expect(await binary.json()).toEqual({ error: 'A binary file, not shown.' });
    expect(big.status).toBe(413);
    expect(JSON.stringify(await big.json())).not.toContain('xxxx');
  });
});
