import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type CommitSha, commitSha } from '@docent/core';
import { beforeAll, describe, expect, test } from 'vitest';
import { commitReader, explainGhFailure, git, MAX_FILE_BYTES, prefetchBlobs } from './github.ts';

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

describe('git', () => {
  test('a call that hangs is stopped at its timeout', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'docent-git-timeout-'));
    await sh(repo, 'init', '--quiet');
    // `cat-file --batch` waits on stdin for ids, which never come.
    const started = Date.now();
    await expect(git(repo, ['cat-file', '--batch'], { timeout: 200 })).rejects.toMatchObject({
      killed: true,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

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

    expect(await prefetchBlobs(clone, [sha])).toBe(2);
    expect(await missingBlobs(clone, sha)).toBe(2);
  });
});

describe('reading many files at once', () => {
  /** A commit built from exact tree entries, so modes and odd names need no filesystem. */
  async function commit(
    repo: string,
    entries: Record<string, { mode: string; text?: string | Buffer; oid?: string }>,
  ): Promise<CommitSha> {
    await sh(repo, 'read-tree', '--empty');
    const scratch = await mkdtemp(join(tmpdir(), 'docent-blob-'));
    for (const [path, { mode, text, oid }] of Object.entries(entries)) {
      let id = oid;
      if (id === undefined) {
        const blob = join(scratch, 'blob');
        await writeFile(blob, text ?? '');
        id = (await sh(repo, 'hash-object', '-w', blob)).trim();
      }
      // On macOS git folds decomposed names into composed ones unless told not to.
      await sh(
        repo,
        '-c',
        'core.precomposeunicode=false',
        'update-index',
        '--add',
        '--cacheinfo',
        `${mode},${id},${path}`,
      );
    }
    const tree = (await sh(repo, 'write-tree')).trim();
    return commitSha((await sh(repo, 'commit-tree', tree, '-m', 'c')).trim());
  }

  const file = (text: string | Buffer) => ({ mode: '100644', text });
  const shared = {
    'run.sh': { mode: '100755', text: '#!/bin/sh\necho hi\n' },
    link: { mode: '120000', text: 'plain.ts' },
    'long-link': { mode: '120000', text: 'x/'.repeat(2500) },
    'vendor/lib': { mode: '160000', oid: 'a'.repeat(40) },
    'logo.png': file(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])),
    'big.txt': file('x'.repeat(MAX_FILE_BYTES + 1)),
    'exact.txt': file('y'.repeat(MAX_FILE_BYTES)),
    'empty.txt': file(''),
    'latin1.txt': file(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])),
    'with space.ts': file('space\n'),
    'line\nbreak.ts': file('newline\n'),
    'café.ts': file('composed\n'),
    'café.ts': file('decomposed\n'),
    '日本/ファイル.ts': file('unicode\n'),
    'star*.ts': file('literal\n'),
    'src/a.ts': file('nested\n'),
    'same1.ts': file('same\n'),
    'same2.ts': file('same\n'),
  };
  // Every kind of answer, plus names that only exist at one side, or nowhere, or aren't safe.
  // `src` comes first: asking for a folder must not hide the files asked for inside it.
  const asked = [
    'src',
    ...Object.keys(shared),
    'plain.ts',
    'gone.txt',
    'new.ts',
    'nope.ts',
    'starX.ts',
    'vendor/lib/inner.ts',
    'cafe.ts',
    '../escape',
    '-x',
    '',
    'src/./a.ts',
    'plain.ts',
  ];

  let reader: ReturnType<typeof commitReader>;

  beforeAll(async () => {
    const repo = await mkdtemp(join(tmpdir(), 'docent-batch-'));
    await sh(repo, 'init', '--quiet', '--initial-branch=main');
    const base = await commit(repo, {
      ...shared,
      'plain.ts': file('export const v = 1;\n'),
      'gone.txt': file('deleted at head\n'),
    });
    const head = await commit(repo, {
      ...shared,
      'plain.ts': file('export const v = 2;\n'),
      'new.ts': file('added at head\n'),
    });
    reader = commitReader(repo, base, head);
  });

  const oneAtATime = async (side: 'old' | 'new', paths: readonly string[]) =>
    new Map(await Promise.all(paths.map(async (p) => [p, await reader.open(side, p)] as const)));

  test.each(['old', 'new'] as const)('agrees with reading each file alone, at %s', async (side) => {
    const batched = await reader.openAll(side, asked);
    expect(batched).toEqual(await oneAtATime(side, asked));
    expect([...batched.keys()].sort()).toEqual([...new Set(asked)].sort());

    // And the answers are the interesting ones, so agreeing isn't just both saying "missing".
    const kind = (path: string) => batched.get(path)?.kind;
    expect(batched.get('plain.ts')).toEqual({
      kind: 'text',
      text: `export const v = ${side === 'old' ? 1 : 2};\n`,
    });
    expect(batched.get('link')).toEqual({ kind: 'symlink', target: 'plain.ts' });
    expect(batched.get('big.txt')).toEqual({ kind: 'too_large', bytes: MAX_FILE_BYTES + 1 });
    expect(batched.get('café.ts')).toEqual({ kind: 'text', text: 'composed\n' });
    expect(batched.get('café.ts')).toEqual({ kind: 'text', text: 'decomposed\n' });
    expect(batched.get('empty.txt')).toEqual({ kind: 'text', text: '' });
    expect(kind('logo.png')).toBe('binary');
    expect(kind('exact.txt')).toBe('text');
    for (const path of [
      'run.sh',
      'with space.ts',
      'line\nbreak.ts',
      '日本/ファイル.ts',
      'src/a.ts',
    ]) {
      expect(kind(path), path).toBe('text');
    }
    for (const path of ['long-link', 'vendor/lib', 'src', 'starX.ts', '../escape', '-x']) {
      expect(kind(path), path).toBe('missing');
    }
    expect(kind('gone.txt')).toBe(side === 'old' ? 'text' : 'missing');
    expect(kind('new.ts')).toBe(side === 'new' ? 'text' : 'missing');
  });

  test('more paths than one command line holds are still all read', async () => {
    const padding = Array.from({ length: 1500 }, (_, i) => `pad/${'p'.repeat(90)}/${i}.ts`);
    const batched = await reader.openAll('new', [...padding, 'plain.ts', 'src/a.ts']);

    expect(batched.get('plain.ts')).toEqual({ kind: 'text', text: 'export const v = 2;\n' });
    expect(batched.get('src/a.ts')).toEqual({ kind: 'text', text: 'nested\n' });
    expect(padding.every((path) => batched.get(path)?.kind === 'missing')).toBe(true);
  });

  test('a name that only looks the same never stands in for the file asked for', async () => {
    // A tree a PR could push by hand: beside `caf�.ts`, a name that isn't UTF-8 but decodes
    // to the same text, and a name listed twice. Asking for the folder lists all of them.
    const repo = await mkdtemp(join(tmpdir(), 'docent-batch-names-'));
    await sh(repo, 'init', '--quiet', '--initial-branch=main');
    const scratch = await mkdtemp(join(tmpdir(), 'docent-tree-'));
    const object = async (type: string, bytes: Buffer) => {
      const path = join(scratch, 'object');
      await writeFile(path, bytes);
      return (await sh(repo, 'hash-object', '--literally', '-t', type, '-w', path)).trim();
    };
    const entry = (mode: string, name: Buffer, oid: string) =>
      Buffer.concat([Buffer.from(`${mode} `), name, Buffer.from([0]), Buffer.from(oid, 'hex')]);
    const real = await object('blob', Buffer.from('// the real file\nexport const v = 1;\n'));
    const impostor = await object('blob', Buffer.from('// an impostor\nexport const v = 1;\n'));
    const src = await object(
      'tree',
      Buffer.concat([
        entry('100644', Buffer.from('caf�.ts'), real),
        entry('100644', Buffer.from([0x63, 0x61, 0x66, 0xf5, 0x2e, 0x74, 0x73]), impostor),
        entry('100644', Buffer.from('dup.ts'), real),
        entry('100644', Buffer.from('dup.ts'), impostor),
      ]),
    );
    const root = await object('tree', entry('40000', Buffer.from('src'), src));
    const sha = commitSha((await sh(repo, 'commit-tree', root, '-m', 'c')).trim());
    const odd = commitReader(repo, sha, sha);
    const paths = ['src', 'src/caf�.ts', 'src/dup.ts', 'src/caf\uD800.ts'];

    const batched = await odd.openAll('new', paths);
    for (const path of paths) expect(batched.get(path), path).toEqual(await odd.open('new', path));
    expect(batched.get('src/caf�.ts')).toEqual({
      kind: 'text',
      text: '// the real file\nexport const v = 1;\n',
    });
    expect(batched.get('src/dup.ts')).toEqual({ kind: 'missing' });
  });

  test("a blob git can't read is missing, and doesn't cost the files beside it", async () => {
    const repo = await mkdtemp(join(tmpdir(), 'docent-batch-lost-'));
    await sh(repo, 'init', '--quiet', '--initial-branch=main');
    const sha = await commit(repo, { 'a.ts': file('kept\n'), 'b.ts': file('lost\n') });
    const lost = (await sh(repo, 'rev-parse', `${sha}:b.ts`)).trim();
    await rm(join(repo, '.git', 'objects', lost.slice(0, 2), lost.slice(2)));
    const broken = commitReader(repo, sha, sha);

    // `ls-tree --long` can't size it (it prints `BAD`), so neither reader takes it as a blob.
    expect(await broken.open('new', 'b.ts')).toEqual({ kind: 'missing' });
    expect(await broken.openAll('new', ['a.ts', 'b.ts'])).toEqual(
      new Map([
        ['a.ts', { kind: 'text', text: 'kept\n' }],
        ['b.ts', { kind: 'missing' }],
      ]),
    );
  });
});
