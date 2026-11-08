import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  assignTier,
  ownedBy,
  parseCodeowners,
  parsePathList,
  report,
  type Tier,
  tierForPull,
} from './tier.ts';

const SCRIPT = join(import.meta.dirname, 'tier.ts');
// The real file, so these tests also catch CODEOWNERS drifting away from the tier rules.
const CODEOWNERS = readFileSync(join(import.meta.dirname, '..', '.github', 'CODEOWNERS'), 'utf8');

const tierOf = (paths: string[]) => assignTier(paths, CODEOWNERS).tier;
const whyOf = (paths: string[], path: string) =>
  assignTier(paths, CODEOWNERS).reasons.find((r) => r.path === path)?.why;

/**
 * Merged PRs #1–#17, with the files each changed (`gh pr view <n> --json files`) and the tier
 * its description stated. #1–#6 predate the 2a/2b split and said "Tier 2"; their stated
 * reasons (harness, config, the lockfile) are all 2b-class now. #11 stated no tier; it only
 * changes `.claude/settings.json`, which is 2b.
 */
const PAST_PRS: { pr: number; tier: Tier; paths: string[] }[] = [
  {
    pr: 1,
    tier: '2b',
    paths: [
      '.claude/settings.json',
      'AGENTS.md',
      'CLAUDE.md',
      'backlog/decisions.md',
      'backlog/index.md',
      'docs/experiments/sdd.md',
      'docs/north-stars.md',
      'docs/process/decisions.md',
      'docs/process/pull-requests.md',
      'docs/process/worktrees.md',
    ],
  },
  { pr: 2, tier: '2b', paths: ['scripts/sync-main-checkout.sh'] },
  {
    pr: 3,
    tier: '2b',
    paths: [
      '.github/CODEOWNERS',
      '.github/agent-apps.json',
      '.github/rulesets/main.json',
      'AGENTS.md',
      'docs/process/agent-identities.md',
      'docs/process/worktrees.md',
      'scripts/as-agent.test.ts',
      'scripts/as-agent.ts',
    ],
  },
  {
    pr: 4,
    tier: '2b',
    paths: [
      'backlog/decisions.md',
      'docs/process/decisions.md',
      'docs/process/pull-requests.md',
      'docs/process/worktrees.md',
    ],
  },
  {
    pr: 5,
    tier: '2b',
    paths: [
      'backlog/index.md',
      'biome.json',
      'docs/experiments/sdd.md',
      'packages/core/AGENTS.md',
      'packages/core/CLAUDE.md',
      'packages/core/SPEC.md',
      'packages/core/src/anchor.test.ts',
      'packages/core/src/anchor.ts',
      'packages/core/src/arbitraries.testing.ts',
      'packages/core/src/basics.ts',
      'packages/core/src/batch.test.ts',
      'packages/core/src/batch.ts',
      'packages/core/src/cost.test.ts',
      'packages/core/src/cost.ts',
      'packages/core/src/coverage.test.ts',
      'packages/core/src/coverage.ts',
      'packages/core/src/diff.test.ts',
      'packages/core/src/diff.ts',
      'packages/core/src/index.ts',
      'packages/core/src/question.ts',
      'packages/core/src/review.ts',
      'packages/core/src/spec.test.ts',
      'packages/core/src/tour.test.ts',
      'packages/core/src/tour.ts',
      'packages/core/src/types.test.ts',
      'packages/core/tsconfig.json',
      'packages/core/tsconfig.test.json',
      'tsconfig.json',
    ],
  },
  {
    pr: 6,
    tier: '2b',
    paths: [
      'backlog/index.md',
      'docs/experiments/sdd.md',
      'docs/research/2026-11-06-eval-fixtures.md',
      'packages/evals/AGENTS.md',
      'packages/evals/CLAUDE.md',
      'packages/evals/fixtures/public/graphql-scalars-2719-phone-redos.json',
      'packages/evals/fixtures/public/hono-4267-client-index-param.json',
      'packages/evals/fixtures/public/hono-4813-cors-credentials.json',
      'packages/evals/fixtures/public/hono-5205-etag-stream-digest.json',
      'packages/evals/fixtures/public/ky-122-timeout-abort.json',
      'packages/evals/fixtures/public/ky-536-unknown-fetch-options.json',
      'packages/evals/fixtures/public/ky-571-jsdoc-typo.json',
      'packages/evals/fixtures/public/vite-15365-env-file-watch.json',
      'packages/evals/fixtures/public/vite-4118-slash-esm.json',
      'packages/evals/fixtures/public/yargs-766-command-validation.json',
      'packages/evals/package.json',
      'packages/evals/src/check-fixtures.ts',
      'packages/evals/src/fixtures.ts',
      'packages/evals/src/index.ts',
      'packages/evals/src/manifest.test.ts',
      'packages/evals/src/manifest.ts',
      'packages/evals/tsconfig.json',
      'pnpm-lock.yaml',
      'tsconfig.json',
      'vitest.config.ts',
    ],
  },
  {
    pr: 7,
    tier: '2b',
    paths: [
      'apps/server/package.json',
      'apps/server/src/agent.live.test.ts',
      'apps/server/src/agent.test.ts',
      'apps/server/src/agent.ts',
      'apps/server/src/app.ts',
      'apps/server/src/cli.ts',
      'apps/server/src/fixture.ts',
      'apps/server/src/github.ts',
      'apps/server/src/review.test.ts',
      'apps/server/src/review.ts',
      'apps/server/src/server.ts',
      'apps/server/src/tour.ts',
      'apps/server/tsconfig.json',
      'apps/web/package.json',
      'apps/web/src/api.ts',
      'apps/web/src/code-view.tsx',
      'apps/web/src/highlight.ts',
      'apps/web/src/main.tsx',
      'apps/web/src/markdown.tsx',
      'apps/web/src/review-page.tsx',
      'apps/web/src/status-screen.tsx',
      'apps/web/src/styles.css',
      'apps/web/src/tour-screen.tsx',
      'backlog/decisions.md',
      'biome.json',
      'e2e/fixtures.ts',
      'e2e/fixtures/hono-4813/diff.patch',
      'e2e/fixtures/hono-4813/files/base/src/middleware/cors/index.ts',
      'e2e/fixtures/hono-4813/files/head/src/middleware/cors/index.test.ts',
      'e2e/fixtures/hono-4813/files/head/src/middleware/cors/index.ts',
      'e2e/fixtures/hono-4813/pr.json',
      'e2e/fixtures/hono-4813/replies.json',
      'e2e/tour.spec.ts',
      'e2e/tsconfig.json',
      'package.json',
      'packages/core/src/diff-parse.test.ts',
      'packages/core/src/diff-parse.ts',
      'packages/core/src/index.ts',
      'playwright.config.ts',
      'pnpm-lock.yaml',
    ],
  },
  { pr: 8, tier: '2b', paths: ['docs/process/pull-requests.md', 'docs/process/worktrees.md'] },
  {
    pr: 9,
    tier: '2b',
    paths: [
      'docs/process/agent-identities.md',
      'docs/process/worktrees.md',
      'scripts/as-agent.test.ts',
      'scripts/as-agent.ts',
    ],
  },
  { pr: 10, tier: '2b', paths: ['.github/agent-apps.json'] },
  { pr: 11, tier: '2b', paths: ['.claude/settings.json'] },
  { pr: 12, tier: '0', paths: ['backlog/decisions.md', 'backlog/index.md'] },
  { pr: 13, tier: '2b', paths: ['docs/process/decisions.md'] },
  {
    pr: 14,
    tier: '2b',
    paths: [
      'apps/server/src/cli.test.ts',
      'apps/server/src/cli.ts',
      'docs/process/pull-requests.md',
      'docs/process/worktrees.md',
      'packages/evals/AGENTS.md',
    ],
  },
  { pr: 15, tier: '0', paths: ['backlog/index.md', 'docs/research/2026-11-08-first-dogfood.md'] },
  { pr: 16, tier: '0', paths: ['backlog/index.md'] },
  { pr: 17, tier: '1', paths: ['apps/web/src/highlight.ts', 'apps/web/vite.config.ts'] },
];

describe('assignTier on past PRs', () => {
  test.each(PAST_PRS)('#$pr was tier $tier', ({ paths, tier }) => {
    expect(tierOf(paths)).toBe(tier);
  });
});

describe('assignTier rules', () => {
  test.each<[string, string[], Tier]>([
    ['nothing changed', [], '0'],
    ['docs and backlog', ['README.md', 'docs/brief.md', 'backlog/index.md'], '0'],
    ['tests in an unowned package', ['apps/web/src/api.test.ts', 'e2e/tour.spec.ts'], '0'],
    ['server tests, which CODEOWNERS leaves unowned', ['apps/server/src/app.test.ts'], '0'],
    ['eval fixtures', ['packages/evals/fixtures/public/new-case.json'], '0'],
    ['e2e fixtures', ['e2e/fixtures/hono-4813/pr.json'], '0'],
    ['core code in a folder named fixtures', ['packages/core/src/fixtures/scrub.ts'], '2a'],
    ['web code in a folder named fixtures', ['apps/web/src/fixtures/app.ts'], '1'],
    [
      'feature work in one package',
      ['apps/web/src/tour-screen.tsx', 'apps/web/src/x.test.ts'],
      '1',
    ],
    ['feature work across two packages', ['apps/web/src/api.ts', 'packages/evals/src/x.ts'], '2a'],
    ['the core model', ['packages/core/src/tour.ts', 'packages/core/src/tour.test.ts'], '2a'],
    ['the core spec', ['packages/core/SPEC.md'], '2a'],
    ['a root file no rule names', ['.gitignore'], '2a'],
    ['server code', ['apps/server/src/app.ts'], '2b'],
    ['a package AGENTS.md', ['apps/web/AGENTS.md'], '2b'],
    ['a web dependency', ['apps/web/package.json'], '2b'],
    ['lockfile only', ['pnpm-lock.yaml'], '2b'],
    ['a new workflow', ['.github/workflows/tier.yml'], '2b'],
    ['the tier script itself', ['scripts/tier.ts'], '2b'],
    ['a script test, which CODEOWNERS owns', ['scripts/tier.test.ts'], '2b'],
  ])('%s', (_, paths, tier) => {
    expect(tierOf(paths)).toBe(tier);
  });

  test('a dependency the doc calls 2a is raised to 2b, and says so', () => {
    expect(whyOf(['apps/web/package.json'], 'apps/web/package.json')).toBe(
      'dependencies, version bumps or the lockfile (tier 2a), but code-owned by `package.json` in CODEOWNERS',
    );
  });

  test('says which package tier-1 work is in, or that it spans several', () => {
    expect(whyOf(['apps/web/src/a.ts'], 'apps/web/src/a.ts')).toBe('feature work inside apps/web');
    expect(whyOf(['apps/web/src/a.ts', 'packages/evals/src/b.ts'], 'apps/web/src/a.ts')).toBe(
      'feature work spanning 2 packages',
    );
  });

  // pull-requests.md says these are 2b. CODEOWNERS is what makes GitHub enforce that, so each
  // must be code-owned too. If one fails, CODEOWNERS has a gap the doc doesn't.
  test.each([
    '.claude/settings.json',
    '.github/workflows/ci.yml',
    'AGENTS.md',
    'apps/web/CLAUDE.md',
    'docs/process/pull-requests.md',
    'scripts/as-agent.ts',
    'scripts/tier.ts',
    'apps/server/package.json',
    'apps/server/src/app.ts',
  ])('%s is 2b and code-owned', (path) => {
    expect(tierOf([path])).toBe('2b');
    expect(ownedBy(parseCodeowners(CODEOWNERS), path)).toBeDefined();
  });
});

describe('ownedBy', () => {
  const rules = parseCodeowners(
    [
      '# comment',
      'AGENTS.md @a',
      '/docs/process/ @a',
      'tsconfig*.json @a',
      '/src/ @a',
      '/src/**/*.test.ts',
    ].join('\n'),
  );

  test.each<[string, string | undefined]>([
    ['AGENTS.md', 'AGENTS.md'],
    ['packages/core/AGENTS.md', 'AGENTS.md'],
    ['docs/process/a/b.md', '/docs/process/'],
    ['docs/research/process/x.md', undefined],
    ['packages/core/tsconfig.test.json', 'tsconfig*.json'],
    ['src/app.ts', '/src/'],
    ['src/deep/app.test.ts', undefined],
    ['other/src/app.ts', undefined],
  ])('%s → %s', (path, pattern) => {
    expect(ownedBy(rules, path)).toBe(pattern);
  });
});

describe('the command line', () => {
  const run = (args: string[], input: string) =>
    execFileSync('node', [SCRIPT, ...args], { input, encoding: 'utf8', stdio: 'pipe' });

  test('--tier prints just the tier', () => {
    expect(run(['--tier'], 'apps/web/src/a.ts\n\napps/web/src/b.ts\n')).toBe('1\n');
  });

  test('prints a report with every path and why, highest tier first', () => {
    const out = run([], 'backlog/index.md\nscripts/tier.ts\n');
    expect(out).toContain('## Risk tier: 2b');
    expect(out.indexOf('scripts/tier.ts')).toBeLessThan(out.indexOf('backlog/index.md'));
    expect(out).toContain('| backlog/index.md | 0 | docs |');
  });

  test("a hostile path can't break the table or inject markup", () => {
    const out = report(assignTier(['docs/a|b<img src=x>.md'], CODEOWNERS));
    expect(out).toContain('| docs/a&#124;b&#60;img src=x&#62;.md | 0 | docs |');
  });

  test('reads NUL-separated paths from git diff -z, names with newlines included', () => {
    expect(run(['--tier'], 'docs/process/café.md\0apps/web/src/a\nb.ts\0')).toBe('2b\n');
  });

  test('refuses a path git quoted, instead of letting it dodge the rules', () => {
    expect(() => parsePathList('"docs/process/caf\\303\\251.md"\n')).toThrow(/git diff -z/);
    expect(() => run(['--tier'], '"docs/process/caf\\303\\251.md"\n')).toThrow();
  });

  test('reads the pull request files API, as CI does', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tier-'));
    try {
      const file = join(dir, 'files.json');
      // `gh api --paginate --slurp` gives one array per page.
      writeFileSync(file, JSON.stringify([[{ filename: 'apps/web/src/a.ts' }]]));
      expect(run(['--tier', '--pull-files', file, '--changed-files', '1'], '')).toBe('1\n');
      expect(() => run(['--tier', '--pull-files', file], '')).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('tierForPull', () => {
  const web = (n: number) => ({ filename: `apps/web/src/f${n}.ts` });

  test('a rename counts under its old name too', () => {
    const pages = [[{ filename: 'docs/moved.md', previous_filename: 'docs/process/moved.md' }]];
    expect(tierForPull(pages, 1, CODEOWNERS).tier).toBe('2b');
  });

  test('a complete list is tiered by its paths', () => {
    expect(tierForPull([[web(1), web(2)], [web(3)]], 3, CODEOWNERS).tier).toBe('1');
  });

  test('a list shorter than the PR is 2b, and says why', () => {
    const result = tierForPull([[web(1)]], 2, CODEOWNERS);
    expect(result.tier).toBe('2b');
    expect(result.reasons[0]?.why).toMatch(/listed 1 of 2 changed files/);
  });

  test('a list that hit GitHub’s 3,000-file limit is 2b', () => {
    const pages = [Array.from({ length: 3000 }, (_, i) => web(i))];
    expect(tierForPull(pages, 3000, CODEOWNERS).tier).toBe('2b');
  });

  test('refuses JSON that is not the files API', () => {
    expect(() => tierForPull({ message: 'Bad credentials' }, 0, CODEOWNERS)).toThrow();
    expect(() => tierForPull([[{ name: 'x' }]], 1, CODEOWNERS)).toThrow();
  });
});
