// Jump to definition and imports, through the real endpoints, over a real git repo. The index
// reads untrusted PR code, so these tests also try to make it read something it shouldn't.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type CommitSha, commitSha } from '@docent/core';
import { hc } from 'hono/client';
import { beforeAll, describe, expect, test } from 'vitest';
import { type AppType, createApp } from './app.ts';
import { fixedSession } from './author-session.ts';
import { gitHeadFiles, type HeadFiles } from './head-files.ts';
import { Review } from './review.ts';
import { INDEX_LIMITS, type IndexLimits } from './symbols.ts';

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

let repo: string;
let head: CommitSha;

beforeAll(async () => {
  const outer = await mkdtemp(join(tmpdir(), 'docent-symbols-'));
  repo = join(outer, 'repo');
  await put(outer, 'outside.ts', 'export function secretOutside() {}\n');
  await mkdir(repo);
  await sh(repo, 'init', '--quiet', '--initial-branch=main');

  await put(repo, 'tsconfig.json', '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }');
  await put(
    repo,
    'src/app.ts',
    [
      "import { helper } from './lib';", // 1
      "import { Widget } from '@/ui';", // 2
      "import express from 'express';", // 3
      'export function main() {', // 4
      '  return helper(new Widget());', // 5
      '}', // 6
    ].join('\n'),
  );
  await put(repo, 'src/lib.ts', 'export function helper() {}\n');
  await put(repo, 'src/ui/index.ts', "export { Widget } from './widget';\n");
  await put(repo, 'src/ui/widget.tsx', '\nexport class Widget {}\n');
  await put(repo, 'tools/helper.py', 'def helper():\n    pass\n');
  // Vendored, minified, binary and huge files are left out of the index.
  await put(repo, 'node_modules/dep/index.js', 'export function helper() {}\n');
  await put(repo, 'web/app.min.js', 'function helper(){}\n');
  await put(repo, 'web/long.js', `function helper(){}${' '.repeat(20_000)}\n`);
  await put(repo, 'src/blob.ts', Buffer.from('export function helper() {}\n\0\0'));
  await put(repo, 'src/huge.ts', `export function helper() {}\n${'//\n'.repeat(200_000)}`);
  // A link out of the repo is never read through.
  await symlink('../outside.ts', join(repo, 'escape.ts'));
  await sh(repo, 'add', '-A');
  await sh(repo, 'commit', '--quiet', '-m', 'head');
  head = commitSha(await sh(repo, 'rev-parse', 'HEAD'));

  // A later push, and edits on disk: none of them is the commit under review.
  await put(repo, 'src/later.ts', 'export function helper() {}\n');
  await sh(repo, 'add', '-A');
  await sh(repo, 'commit', '--quiet', '-m', 'later');
  await put(repo, 'src/lib.ts', '\n\n\nexport function helper() {}\n');
  await put(repo, 'src/untracked.ts', 'export function helper() {}\n');
});

/** A review of the repo at `head`, served by the real app, counting index builds. */
async function serve(
  limits: Partial<IndexLimits> = {},
  files: () => Promise<HeadFiles> = () => gitHeadFiles(repo, head),
) {
  let listings = 0;
  const review = new Review({
    source: async () => ({
      pr: {
        url: 'https://github.com/acme/web/pull/7',
        repo: 'acme/web',
        number: 7,
        title: 'Symbols',
        body: '',
        author: 'someone',
        base: head,
        head,
        baseRef: 'main',
        headRef: 'symbols',
      },
      diffText: '',
      commitMessages: [],
      headInBaseRepo: true,
      dir: repo,
      readFile: async () => null,
      currentHead: async () => head,
      postReview: async () => {
        throw new Error('not in this test');
      },
      headFiles: () => {
        listings++;
        return files();
      },
    }),
    runner: async () => {
      throw new Error('no model in this test');
    },
    locator: fixedSession({ found: false, reason: 'none' }),
    model: 'claude-test',
    indexLimits: { ...INDEX_LIMITS, ...limits },
  });
  await review.done;
  const app = createApp({ origin, token, version: '0.0.0', review });
  const { api } = hc<AppType>(origin, {
    fetch: app.request,
    headers: { Authorization: `Bearer ${token}` },
  });
  return { app, api, listings: () => listings };
}

async function definition(
  api: Awaited<ReturnType<typeof serve>>['api'],
  query: { symbol: string; from?: string; line?: string },
) {
  const res = await api.definition.$get({ query });
  if (res.status !== 200) throw new Error(`answered ${res.status}`);
  return res.json();
}

describe('GET /api/definition', () => {
  test('ranks the import first, and returns every other candidate with its path and line', async () => {
    const { api } = await serve();
    const found = await definition(api, { symbol: 'helper', from: 'src/app.ts', line: '5' });
    expect(found.candidates).toEqual([
      { path: 'src/lib.ts', line: 1, kind: 'function', rank: 'import' },
      { path: 'tools/helper.py', line: 1, kind: 'function', rank: 'repo' },
    ]);
    expect(found.more).toBe(0);
    expect(found.index).toMatchObject({ state: 'complete', files: 5 });

    const widget = await definition(api, { symbol: 'Widget', from: 'src/app.ts' });
    expect(widget.candidates).toEqual([
      { path: 'src/ui/widget.tsx', line: 2, kind: 'class', rank: 'import' },
    ]);
  });

  test('reads only the head commit: not later pushes, edits on disk, untracked files or links out', async () => {
    const { api } = await serve();
    const found = await definition(api, { symbol: 'helper' });
    const paths = found.candidates.map((c) => c.path);
    expect(paths).not.toContain('src/later.ts');
    expect(paths).not.toContain('src/untracked.ts');
    // On disk, the edit moved helper to line 4; at head it's on line 1.
    expect(found.candidates).toContainEqual(
      expect.objectContaining({ path: 'src/lib.ts', line: 1 }),
    );
    expect((await definition(api, { symbol: 'secretOutside' })).candidates).toEqual([]);
  });

  test('skips vendored, minified, binary and oversized files, and counts them', async () => {
    const { api } = await serve({ fileBytes: 100_000 });
    const found = await definition(api, { symbol: 'helper' });
    expect(found.candidates.map((c) => c.path).sort()).toEqual(['src/lib.ts', 'tools/helper.py']);
    // node_modules, the .min.js, the long line, the binary and the huge file.
    expect(found.index).toMatchObject({ state: 'complete', files: 5, skipped: 5 });
  });

  test('builds the index once, on first use, and shares it between concurrent requests', async () => {
    const { api, listings } = await serve();
    expect(listings()).toBe(0);
    await Promise.all([
      definition(api, { symbol: 'helper' }),
      definition(api, { symbol: 'Widget' }),
      api.import.$get({ query: { from: 'src/app.ts', spec: './lib' } }),
    ]);
    expect(listings()).toBe(1);
  });

  test('a capped or timed-out index answers as partial instead of hanging', async () => {
    const capped = await serve({ files: 2 });
    const { index } = await definition(capped.api, { symbol: 'helper' });
    expect(index).toMatchObject({ state: 'partial', reason: 'files' });
    expect(index.files).toBeLessThanOrEqual(2);
    const timed = await serve({ ms: -1 });
    expect(await definition(timed.api, { symbol: 'helper' })).toMatchObject({
      candidates: [],
      index: { state: 'partial', reason: 'time', files: 0 },
    });
  });

  test('a read that stalls is cut off at the time limit too', async () => {
    const stalled = await serve({ ms: 50 }, async () => ({
      entries: [{ path: 'src/a.ts', bytes: 10 }],
      truncated: false,
      read: async function* (_paths, signal) {
        await new Promise((resolve) => signal.addEventListener('abort', resolve));
      },
    }));
    expect((await definition(stalled.api, { symbol: 'a' })).index).toMatchObject({
      state: 'partial',
      reason: 'time',
    });
  });

  test('a failed index answers 500 and is built again on the next request', async () => {
    let calls = 0;
    const { api } = await serve({}, async () => {
      if (++calls === 1) throw new Error('git broke');
      return gitHeadFiles(repo, head);
    });
    expect((await api.definition.$get({ query: { symbol: 'helper' } })).status).toBe(500);
    expect((await definition(api, { symbol: 'helper' })).index.state).toBe('complete');
  });

  test('refuses bad input, and anyone without the token', async () => {
    const { api, app } = await serve();
    for (const query of [
      { symbol: '' },
      { symbol: 'a.b' },
      { symbol: 'x'.repeat(201) },
      { symbol: 'helper', from: '../outside.ts' },
      { symbol: 'helper', from: 'src/app.ts', line: '0' },
    ]) {
      expect((await api.definition.$get({ query })).status, JSON.stringify(query)).toBe(400);
    }
    const anonymous = await app.request(`${origin}/api/definition?symbol=helper`);
    expect(anonymous.status).toBe(401);
    const anonymousImport = await app.request(`${origin}/api/import?from=src/app.ts&spec=./lib`);
    expect(anonymousImport.status).toBe(401);
  });
});

describe('GET /api/import', () => {
  test('resolves relative and tsconfig paths, and leaves packages and escapes unresolved', async () => {
    const { api } = await serve();
    const resolve = async (spec: string) => {
      const res = await api.import.$get({ query: { from: 'src/app.ts', spec } });
      if (res.status !== 200) throw new Error(`answered ${res.status}`);
      return (await res.json()).path;
    };
    expect(await resolve('./lib')).toBe('src/lib.ts');
    expect(await resolve('@/ui')).toBe('src/ui/index.ts');
    expect(await resolve('express')).toBeNull();
    expect(await resolve('../../outside')).toBeNull();
    expect(await resolve('./later')).toBeNull();
    const bad = await api.import.$get({ query: { from: 'src/app.ts', spec: 'a\nb' } });
    expect(bad.status).toBe(400);
  });
});
