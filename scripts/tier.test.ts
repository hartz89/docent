import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { assignTier, parsePathList, report, type Tier, tierForPull } from './tier.ts';

const SCRIPT = join(import.meta.dirname, 'tier.ts');
const TIERS: Tier[] = ['0', '1', '2a', '2b'];

const tierOf = (paths: string[]) => assignTier(paths).tier;
const whyOf = (paths: string[], path: string) =>
  assignTier(paths).reasons.find((r) => r.path === path)?.why;

/**
 * Merged PRs, with the files each changed (`gh pr view <n> --json files`) and the floor the path
 * rules give them. A tiering backtest over 38 merged PRs (2026-11-10) hand-labeled eight as
 * needing a security review: #1, #3, #7, #9, #10, #11, #19 and #42. Every one floors at 2b.
 */
const NEEDED_SECURITY_REVIEW = [1, 3, 7, 9, 10, 11, 19, 42];

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
  { pr: 2, tier: '2a', paths: ['scripts/sync-main-checkout.sh'] },
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
    tier: '2a',
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
    tier: '2a',
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
  { pr: 8, tier: '2a', paths: ['docs/process/pull-requests.md', 'docs/process/worktrees.md'] },
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
  { pr: 13, tier: '2a', paths: ['docs/process/decisions.md'] },
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
  // Without a rule for apps/server/src/, this fell to 2a. Its review found that an untrusted PR
  // body chose which of the reviewer's sessions got forked.
  {
    pr: 19,
    tier: '2b',
    paths: [
      'apps/server/src/agent.live.test.ts',
      'apps/server/src/agent.test.ts',
      'apps/server/src/agent.ts',
      'apps/server/src/app.ts',
      'apps/server/src/author-session.test.ts',
      'apps/server/src/author-session.ts',
      'apps/server/src/cli.ts',
      'apps/server/src/fixture.ts',
      'apps/server/src/github.ts',
      'apps/server/src/review.test.ts',
      'apps/server/src/review.ts',
      'apps/server/src/server.ts',
      'apps/web/src/review-page.tsx',
      'apps/web/src/tour-screen.tsx',
      'backlog/decisions.md',
      'backlog/index.md',
      'docs/research/2026-11-08-question-path-live.md',
      'e2e/question.spec.ts',
    ],
  },
  // Skip proofs in core. The old rules called this a 2a contract change. Its review found
  // PR-crafted inputs that hid behavior changes from the reviewer.
  {
    pr: 42,
    tier: '2b',
    paths: [
      'packages/core/SPEC.md',
      'packages/core/src/changes.testing.ts',
      'packages/core/src/coverage.ts',
      'packages/core/src/detect.test.ts',
      'packages/core/src/detect.ts',
      'packages/core/src/gitattributes.ts',
      'packages/core/src/index.ts',
      'packages/core/src/ledger.test.ts',
      'packages/core/src/ledger.ts',
      'packages/core/src/proof.ts',
      'packages/core/src/rename.test.ts',
      'packages/core/src/rename.ts',
      'packages/core/src/types.test.ts',
    ],
  },
];

describe('the floor on past PRs', () => {
  test.each(PAST_PRS)('#$pr floors at $tier', ({ paths, tier }) => {
    expect(tierOf(paths)).toBe(tier);
  });

  test('every PR the backtest said needed a security review floors at 2b', () => {
    const tiered = PAST_PRS.filter(({ pr }) => NEEDED_SECURITY_REVIEW.includes(pr));
    expect(tiered.map(({ pr }) => pr)).toEqual(NEEDED_SECURITY_REVIEW);
    for (const { paths } of tiered) expect(tierOf(paths)).toBe('2b');
  });

  test('a #19-style change, server code with its tests, is 2b because of the server code', () => {
    const paths = ['apps/server/src/author-session.ts', 'apps/server/src/author-session.test.ts'];
    expect(tierOf(paths)).toBe('2b');
    expect(whyOf(paths, 'apps/server/src/author-session.test.ts')).toBe('tests');
  });

  test('a #42-style change, one skip-proof file, is 2b where the rest of core is 2a', () => {
    expect(tierOf(['packages/core/src/detect.ts', 'packages/core/src/detect.test.ts'])).toBe('2b');
    expect(tierOf(['packages/core/src/tour.ts', 'packages/core/src/tour.test.ts'])).toBe('2a');
  });

  test('adding a path never lowers the floor', () => {
    const every = [...new Set(PAST_PRS.flatMap(({ paths }) => paths))];
    for (const { pr, paths, tier } of PAST_PRS) {
      for (const extra of every) {
        const raised = tierOf([...paths, extra]);
        expect(TIERS.indexOf(raised), `#${pr} + ${extra}`).toBeGreaterThanOrEqual(
          TIERS.indexOf(tier),
        );
      }
    }
  });
});

describe('the 2b path floor, as docs/process/pull-requests.md lists it', () => {
  test.each([
    '.github/workflows/ci.yml',
    '.github/rulesets/main.json',
    '.github/agent-apps.json',
    'scripts/as-agent.ts',
    '.claude/settings.json',
    '.claude/settings.local.json',
    'apps/server/package.json',
    'apps/server/src/app.ts',
    'apps/server/src/review.ts',
    'apps/server/src/agent.test.ts',
    'apps/server/src/agent.live.test.ts',
    'apps/server/src/agent.testing.ts',
    'packages/core/src/proof.ts',
    'packages/core/src/detect.ts',
    'packages/core/src/rename.ts',
    'packages/core/src/gitattributes.ts',
    'packages/core/src/ledger.ts',
    'packages/core/src/coverage.ts',
    // A Mac's file system ignores case, and ./ names the same file.
    '.Claude/Settings.json',
    'apps/Server/src/app.ts',
    './apps/server/src/app.ts',
    'Packages/Core/src/Detect.ts',
  ])('%s is 2b', (path) => {
    expect(tierOf([path])).toBe('2b');
  });

  // Just outside the list. Some of these are 2b by the checklist; the reviewer raises them.
  test.each<[string, Tier]>([
    ['apps/server/src/review.test.ts', '0'],
    ['apps/server/tsconfig.json', '1'],
    ['packages/core/src/detect.test.ts', '0'],
    ['packages/core/src/tour.ts', '2a'],
    ['.claude/skills/review/SKILL.md', '2a'],
    ['.claude/hooks/guard.sh', '2a'],
    ['apps/web/.claude/settings.json', '2a'],
    ['scripts/check-context-loading.ts', '2a'],
    ['scripts/tier.ts', '2a'],
    ['docs/process/pull-requests.md', '2a'],
    ['AGENTS.md', '2a'],
  ])('%s is %s', (path, tier) => {
    expect(tierOf([path])).toBe(tier);
  });
});

describe('the rest of the tier table', () => {
  test.each<[string, string[], Tier]>([
    ['nothing changed', [], '0'],
    ['docs and backlog', ['README.md', 'docs/brief.md', 'backlog/index.md'], '0'],
    ['tests', ['apps/web/src/api.test.ts', 'e2e/tour.spec.ts', 'scripts/tier.test.ts'], '0'],
    ['eval fixtures', ['packages/evals/fixtures/public/new-case.json'], '0'],
    ['core code in a folder named fixtures', ['packages/core/src/fixtures/scrub.ts'], '2a'],
    ['web code in a folder named fixtures', ['apps/web/src/fixtures/app.ts'], '1'],
    ['feature work in one package', ['apps/web/src/a.tsx', 'apps/web/src/a.test.ts'], '1'],
    ['feature work across two packages', ['apps/web/src/api.ts', 'packages/evals/src/x.ts'], '2a'],
    ['the core spec', ['packages/core/SPEC.md'], '2a'],
    ['a web dependency', ['apps/web/package.json'], '2a'],
    ['lockfile only', ['pnpm-lock.yaml'], '2a'],
    ['a package AGENTS.md', ['apps/web/AGENTS.md'], '2a'],
    ['a root file no rule names', ['.gitignore'], '2a'],
  ])('%s', (_, paths, tier) => {
    expect(tierOf(paths)).toBe(tier);
  });

  test('says which package tier-1 work is in, or that it spans several', () => {
    expect(whyOf(['apps/web/src/a.ts'], 'apps/web/src/a.ts')).toBe('feature work inside apps/web');
    expect(whyOf(['apps/web/src/a.ts', 'packages/evals/src/b.ts'], 'apps/web/src/a.ts')).toBe(
      'feature work spanning 2 packages',
    );
  });
});

describe('the command line', () => {
  const run = (args: string[], input: string) =>
    execFileSync('node', [SCRIPT, ...args], { input, encoding: 'utf8', stdio: 'pipe' });

  test('--tier prints just the tier', () => {
    expect(run(['--tier'], 'apps/web/src/a.ts\n\napps/web/src/b.ts\n')).toBe('1\n');
  });

  test('prints the floor and the paths that set it, and only counts the rest', () => {
    const out = run([], 'backlog/index.md\napps/server/src/app.ts\napps/web/src/a.ts\n');
    expect(out).toContain('## Tier floor: 2b');
    expect(out).toContain(
      '| apps/server/src/app.ts | the server, which holds the request and session gates |',
    );
    expect(out).not.toContain('backlog/index.md');
    expect(out).toContain('2 other paths at lower tiers.');
  });

  test("a hostile path can't break the table or inject markup", () => {
    const out = report(assignTier(['docs/a|b<img src=x>.md']));
    expect(out).toContain('| docs/a&#124;b&#60;img src=x&#62;.md | docs |');
  });

  test("a newline in a file name can't add lines to the report", () => {
    const out = report(assignTier(['docs/a\n## Tier floor: 0\n.md']));
    expect(out.split('\n').filter((line) => line.startsWith('## '))).toEqual(['## Tier floor: 0']);
    expect(out).toContain('| docs/a&#10;## Tier floor: 0&#10;.md | docs |');
  });

  test('reads NUL-separated paths from git diff -z, names with newlines included', () => {
    expect(run(['--tier'], '.github/café.yml\0apps/web/src/a\nb.ts\0')).toBe('2b\n');
  });

  test('refuses a path git quoted, instead of letting it dodge the rules', () => {
    expect(() => parsePathList('"apps/server/src/caf\\303\\251.ts"\n')).toThrow(/git diff -z/);
    expect(() => run(['--tier'], '"apps/server/src/caf\\303\\251.ts"\n')).toThrow();
  });

  test('--pr takes only a number', () => {
    expect(() => run(['--pr', '18; rm -rf /'], '')).toThrow(/takes a PR number/);
  });
});

describe('tierForPull', () => {
  const web = (n: number) => ({ filename: `apps/web/src/f${n}.ts` });

  test('a rename counts under its old name too', () => {
    const pages = [[{ filename: 'docs/moved.ts', previous_filename: 'apps/server/src/moved.ts' }]];
    expect(tierForPull(pages, 1).tier).toBe('2b');
  });

  test('a complete list, across pages, is tiered by its paths', () => {
    expect(tierForPull([[web(1), web(2)], [web(3)]], 3).tier).toBe('1');
  });

  test('a list shorter than the PR is 2b, and says why', () => {
    const result = tierForPull([[web(1)]], 2);
    expect(result.tier).toBe('2b');
    expect(result.reasons[0]?.why).toMatch(/listed 1 of 2 changed files/);
  });

  test('a list that hit GitHub’s 3,000-file limit is 2b', () => {
    const pages = [Array.from({ length: 3000 }, (_, i) => web(i))];
    expect(tierForPull(pages, 3000).tier).toBe('2b');
  });

  test('refuses JSON that is not the files API', () => {
    expect(() => tierForPull({ message: 'Bad credentials' }, 0)).toThrow();
    expect(() => tierForPull([[{ name: 'x' }]], 1)).toThrow();
  });
});
