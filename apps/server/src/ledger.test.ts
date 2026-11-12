// The skip ledger over a real git repo: proofs read from git objects at the two pinned commits,
// the whole-repo word lookups answered by `git grep`, and the tour checked without requiring
// every changed line to be cited.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { commitSha, type Diff, type MicroUsd, parseUnifiedDiff } from '@docent/core';
import { beforeAll, describe, expect, test } from 'vitest';
import type { AgentRequest, AgentRunner } from './agent.ts';
import { commitReader, type Workspace } from './github.ts';
import { gitHeadFiles } from './head-files.ts';
import { type LedgerFileView, ledgerFor, proveForReview } from './ledger.ts';
import { generateTour, type TourView } from './tour.ts';

const run = promisify(execFile);

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
  return stdout;
}

const lines = (...text: string[]) => `${text.join('\n')}\n`;

async function write(repo: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(repo, path, '..'), { recursive: true });
    await writeFile(join(repo, path), text);
  }
}

const definition = (comment: string, name: string, body: string) =>
  lines(`// ${comment}`, `export function ${name}(key) {`, `  return ${body};`, '}');
const caller = (name: string, from: string, op = '===') =>
  lines(
    `import { ${name} } from './${from}.ts';`,
    '',
    `const found = ${name}(1);`,
    `if (found ${op} null) throw new Error();`,
  );

let workspace: Workspace;
let diff: Diff;

beforeAll(async () => {
  const repo = await mkdtemp(join(tmpdir(), 'docent-ledger-'));
  await sh(repo, 'init', '--quiet', '--initial-branch=main');
  await write(repo, {
    // Base's attributes: the only ones a generated-file proof may read.
    '.gitattributes': 'src/schema.gen.ts linguist-generated\n',
    'src/schema.gen.ts': 'export const version = 1;\n',
    'src/api.gen.ts': 'export const api = 1;\n',
    // A real rename: the definition and its only caller.
    'src/clock.ts': definition('Clock.', 'isExpired', 'key < now()'),
    'src/session.ts': caller('isExpired', 'clock'),
    // A "rename" whose caller also flips an operator.
    'src/users.ts': definition('Users.', 'getUser', 'db.find(key)'),
    'src/main.ts': caller('getUser', 'users'),
    // A rename whose new name is already used elsewhere in the repo, outside the diff.
    'src/cache.ts': definition('Cache.', 'loadItem', 'store.get(key)'),
    'docs/notes.md': 'Call readItem to read from the store.\n',
    'src/a.ts': 'export const a = 1;\n',
    'src/server.ts': lines("import { a } from './a.ts';", '', 'export const port = a;'),
  });
  await sh(repo, 'add', '-A');
  await sh(repo, 'commit', '--quiet', '-m', 'base');
  const base = commitSha((await sh(repo, 'rev-parse', 'HEAD')).trim());

  await write(repo, {
    // The PR marks a file generated itself. That must count for nothing.
    '.gitattributes': lines(
      'src/schema.gen.ts linguist-generated',
      'src/api.gen.ts linguist-generated',
    ),
    'src/schema.gen.ts': 'export const version = 2;\n',
    'src/api.gen.ts': 'export const api = 2;\n',
    'src/clock.ts': definition('Clock.', 'hasExpired', 'key < now()'),
    'src/session.ts': caller('hasExpired', 'clock'),
    'src/users.ts': definition('Users.', 'fetchUser', 'db.find(key)'),
    'src/main.ts': caller('fetchUser', 'users', '!=='),
    'src/cache.ts': definition('Cache.', 'readItem', 'store.get(key)'),
    'src/server.ts': lines(
      "import { a } from './a.ts';",
      "import { version } from './schema.gen.ts';",
      '',
      'export const port = a + version;',
    ),
    'src/new.ts': lines(
      "import { hasExpired } from './clock.ts';",
      '',
      'export const stale = hasExpired(0);',
    ),
  });
  await sh(repo, 'add', '-A');
  await sh(repo, 'commit', '--quiet', '-m', 'head');
  const head = commitSha((await sh(repo, 'rev-parse', 'HEAD')).trim());

  const diffText = await sh(repo, 'diff', '--no-color', base, head);
  diff = parseUnifiedDiff(diffText, base, head);
  workspace = {
    pr: {
      url: 'https://github.com/acme/web/pull/9',
      repo: 'acme/web',
      number: 9,
      title: 'Rename the expiry check',
      body: 'Renames isExpired to hasExpired.',
      author: 'someone',
      base,
      head,
      baseRef: 'main',
      headRef: 'rename',
    },
    diffText,
    commitMessages: [],
    headInBaseRepo: true,
    dir: repo,
    ...commitReader(repo, base, head),
    headFiles: () => gitHeadFiles(repo, head),
    currentHead: async () => head,
    postReview: async () => {
      throw new Error('not in this test');
    },
  };
});

const cite = (path: string, startLine: number, endLine = startLine) => ({
  path,
  side: 'new' as const,
  startLine,
  endLine,
});

/** The guide's tour: it cites the behavior and leaves every import and the renames uncited. */
const wire = {
  stops: [
    { kind: 'intent', title: 'Why', body: 'Renames the expiry check.', flags: [], citations: [] },
    {
      kind: 'core_change',
      title: 'The port adds the schema version',
      body: 'The port now includes the version.',
      flags: [],
      citations: [cite('src/server.ts', 4), cite('src/new.ts', 3)],
    },
    { kind: 'verdict_prompt', title: 'Your call', body: 'Does it?', flags: [], citations: [] },
  ],
  notes: [{ path: 'src/api.gen.ts', note: 'Generated client' }],
};

/** One scripted guide reply: the tour above, every time. */
function guide(): { runner: AgentRunner; requests: AgentRequest[] } {
  const requests: AgentRequest[] = [];
  const runner: AgentRunner = async (request) => {
    requests.push(request);
    return {
      sessionId: 'session-1',
      text: '',
      structured: wire,
      denials: [],
      cost: {
        job: request.job,
        model: 'claude-test',
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        costMicroUsd: 1 as MicroUsd,
        latencyMs: 1,
      },
    };
  };
  return { runner, requests };
}

async function tour(): Promise<{ view: TourView; attempts: number; problems: string[] }> {
  const { runner } = guide();
  const outcome = await generateTour({
    workspace,
    diff,
    runner,
    model: 'claude-test',
    onProgress: () => {},
  });
  return { view: outcome.tour, attempts: outcome.attempts, problems: outcome.problems };
}

const byPath = (files: readonly LedgerFileView[]) => new Map(files.map((f) => [f.path, f]));

describe('the skip ledger, from a real repo', () => {
  test('an uncited import no longer fails the tour: one attempt, no problems', async () => {
    const { attempts, problems } = await tour();
    expect(attempts).toBe(1);
    expect(problems).toEqual([]);
  });

  test('every changed line lands in exactly one place, with proofs from the pinned commits', async () => {
    const { view } = await tour();
    const ledger = await ledgerFor(
      diff,
      view,
      await proveForReview(workspace, diff),
      workspace.readFile,
    );
    const files = byPath(ledger.files);
    const total = diff.files
      .flatMap((f) => f.hunks.flatMap((h) => h.lines))
      .filter((l) => l.kind !== 'context').length;

    expect(ledger.lines.onRoute + ledger.lines.provenSkip + ledger.lines.notOnRoute).toBe(total);
    expect(ledger.lines.onRoute).toBe(2);

    // The uncited import in an existing file is listed, not hidden, and not proven.
    expect(files.get('src/server.ts')).toMatchObject({
      place: 'on_route',
      onRoute: 1,
      proven: null,
      notOnRoute: { added: [2], removed: [3] },
    });
    // In a new file, named imports and blank lines are proven.
    expect(files.get('src/new.ts')).toMatchObject({
      place: 'on_route',
      onRoute: 1,
      proven: { lines: 2, labels: ['blank_line', 'import_in_new_file'] },
      notOnRoute: null,
    });
  });

  test('a rename is proven, with its mapping, once git grep finds the old name gone', async () => {
    const { view } = await tour();
    const ledger = await ledgerFor(
      diff,
      view,
      await proveForReview(workspace, diff),
      workspace.readFile,
    );
    const files = byPath(ledger.files);
    for (const path of ['src/clock.ts', 'src/session.ts']) {
      expect(files.get(path)).toMatchObject({
        place: 'proven_skip',
        proven: { labels: ['rename'], renames: [{ from: 'isExpired', to: 'hasExpired' }] },
        notOnRoute: null,
      });
    }
  });

  test('a fake rename is refused: the hunk that also flips an operator stays visible', async () => {
    const { view } = await tour();
    const ledger = await ledgerFor(
      diff,
      view,
      await proveForReview(workspace, diff),
      workspace.readFile,
    );
    const files = byPath(ledger.files);
    expect(files.get('src/main.ts')).toMatchObject({
      place: 'not_on_route',
      proven: null,
      notOnRoute: { added: [1, 3, 4], removed: [1, 3, 4] },
    });
  });

  test('a rename whose new name already appears elsewhere in the repo is refused', async () => {
    const asked: string[] = [];
    const watched: Workspace = {
      ...workspace,
      findWords: async (side, words) => {
        asked.push(...words.map((w) => `${side}:${w}`));
        return workspace.findWords(side, words);
      },
    };
    const proofs = await proveForReview(watched, diff);
    const ledger = await ledgerFor(diff, (await tour()).view, proofs, workspace.readFile);
    expect(asked).toContain('old:readItem');
    expect(byPath(ledger.files).get('src/cache.ts')).toMatchObject({
      place: 'not_on_route',
      proven: null,
    });
  });

  test("generated files are judged by base's .gitattributes, never the PR's own", async () => {
    const { view } = await tour();
    const ledger = await ledgerFor(
      diff,
      view,
      await proveForReview(workspace, diff),
      workspace.readFile,
    );
    const files = byPath(ledger.files);
    expect(files.get('src/schema.gen.ts')).toMatchObject({
      place: 'proven_skip',
      proven: {
        labels: ['generated'],
        rules: ['base .gitattributes:1 src/schema.gen.ts'],
      },
    });
    // Marked generated only by the PR: listed, with the guide's note shown as its own word.
    expect(files.get('src/api.gen.ts')).toMatchObject({
      place: 'not_on_route',
      proven: null,
      note: 'Generated client',
    });
    expect(files.get('.gitattributes')).toMatchObject({ place: 'not_on_route', proven: null });
  });

  test(".gitattributes git can't list or read in full prove nothing generated", async () => {
    const partial: Workspace = { ...workspace, baseGitattributes: async () => null };
    const ledger = await ledgerFor(
      diff,
      (await tour()).view,
      await proveForReview(partial, diff),
      workspace.readFile,
    );
    expect(byPath(ledger.files).get('src/schema.gen.ts')).toMatchObject({
      place: 'not_on_route',
      proven: null,
    });
    // A tree listing cut short is such a case: a later file might opt a folder back in.
    expect(await commitReader(workspace.dir, diff.base, diff.head, 2).baseGitattributes()).toBe(
      null,
    );
  });

  test('word lookups past the deadline prove no rename', async () => {
    const slow: Workspace = {
      ...workspace,
      findWords: (side, words) =>
        new Promise((resolve) => setTimeout(() => resolve(workspace.findWords(side, words)), 200)),
    };
    const ledger = await ledgerFor(
      diff,
      (await tour()).view,
      await proveForReview(slow, diff, 20),
      workspace.readFile,
    );
    expect(byPath(ledger.files).get('src/clock.ts')).toMatchObject({ place: 'not_on_route' });
  });

  test('a word lookup git cannot answer proves nothing', async () => {
    const blind: Workspace = { ...workspace, findWords: async () => new Map() };
    const ledger = await ledgerFor(
      diff,
      (await tour()).view,
      await proveForReview(blind, diff),
      workspace.readFile,
    );
    expect(byPath(ledger.files).get('src/clock.ts')).toMatchObject({ place: 'not_on_route' });
  });
});
