// The path floor for a PR's risk tier (0, 1, 2a or 2b). The reviewer agent decides the tier,
// using the 2b checklist in docs/process/pull-requests.md. This script gives the lowest tier the
// PR can have, from the paths it changes, so the reviewer can raise the tier above it but never
// set it lower. Paths can't see everything (a backtest found core logic that hides lines from
// the reviewer, which only the checklist catches), so the floor never settles a tier on its own.
//
// Run, as the reviewer:
//   node scripts/tier.ts --pr <number>      reads the PR's files with `gh api` (GET only)
//   git diff -z --name-only --no-renames origin/main...HEAD | node scripts/tier.ts
// It prints the floor and the paths that set it. Add --tier to print just the tier.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';

const TIERS = ['0', '1', '2a', '2b'] as const;
export type Tier = (typeof TIERS)[number];

/** Why one changed path lands in its tier. */
export type Reason = { path: string; tier: Tier; why: string };
export type TierResult = { tier: Tier; reasons: Reason[] };

const rank = (tier: Tier) => TIERS.indexOf(tier);
const higher = (a: Tier, b: Tier): Tier => (rank(a) >= rank(b) ? a : b);

/** The workspace package a path sits in, like "apps/web", if any. */
function packageOf(path: string): string | undefined {
  return /^((?:apps|packages)\/[^/]+)\//.exec(path)?.[1];
}

/** Test files, plus the two folders that hold only test data. Any other `fixtures/` is code. */
const isTest = (path: string) =>
  /\.(test|spec|testing)\.tsx?$/.test(path) ||
  path.startsWith('e2e/') ||
  path.startsWith('packages/evals/fixtures/');

/** In the server, only test files count as tests. A `.testing.ts` helper can weaken a gate test. */
const isServerTest = (path: string) => /\.(test|spec)\.tsx?$/.test(path);

/** Server tests that pin the read-only session options. They're part of the gate. */
const PINNING_TESTS = new Set([
  'apps/server/src/agent.test.ts',
  'apps/server/src/agent.live.test.ts',
]);

/** Core logic that decides which lines of a PR the reviewer never sees. */
const SKIP_PROOFS = new Set(
  ['proof', 'detect', 'rename', 'gitattributes', 'ledger', 'coverage'].map(
    (name) => `packages/core/src/${name}.ts`,
  ),
);

/**
 * Path rules. The first rule that matches a path decides it. The 2b rules are the path floor in
 * docs/process/pull-requests.md, exactly; keep them in step. The rest follow the tier table.
 * Order matters: 2b and harness rules come before the docs and tests rules, so
 * `apps/server/src/agent.test.ts` is 2b and `apps/web/AGENTS.md` is harness. Rules see paths in
 * lower case (see `ruleKey`).
 */
const RULES: { tier: Tier; why: string; matches: (path: string) => boolean }[] = [
  { tier: '2b', why: 'CI, the ruleset and repo rules', matches: (p) => p.startsWith('.github/') },
  { tier: '2b', why: 'the agent runner', matches: (p) => p === 'scripts/as-agent.ts' },
  {
    tier: '2b',
    why: 'permission rules and hooks',
    matches: (p) => /^\.claude\/settings[^/]*\.json$/.test(p),
  },
  {
    tier: '2b',
    why: 'dependencies used by apps/server',
    matches: (p) => p === 'apps/server/package.json',
  },
  {
    tier: '2b',
    why: 'the server, which holds the request and session gates',
    matches: (p) => p.startsWith('apps/server/src/') && (!isServerTest(p) || PINNING_TESTS.has(p)),
  },
  { tier: '2b', why: 'skip proofs: what the reviewer sees', matches: (p) => SKIP_PROOFS.has(p) },
  {
    tier: '2a',
    why: 'the agent harness',
    matches: (p) =>
      /(^|\/)\.claude\//.test(p) ||
      ['agents.md', 'claude.md'].includes(basename(p)) ||
      p.startsWith('docs/process/'),
  },
  {
    tier: '2a',
    why: 'dependencies, version bumps or the lockfile',
    matches: (p) => basename(p) === 'package.json' || p === 'pnpm-lock.yaml',
  },
  { tier: '0', why: 'tests', matches: isTest },
  {
    tier: '2a',
    why: 'shared contract: the core model and tour schema',
    matches: (p) => p.startsWith('packages/core/'),
  },
  { tier: '0', why: 'docs', matches: (p) => p.startsWith('docs/') || p.endsWith('.md') },
  { tier: '1', why: 'feature work', matches: (p) => packageOf(p) !== undefined },
];

/**
 * The form of a path the rules match. A Mac's file system ignores case, so `.Claude/settings.json`
 * is the real settings file there; a leading `./` names the same file. Every rule is
 * written in lower case, so this never takes a path out of 2b.
 */
const ruleKey = (path: string) => path.toLowerCase().replace(/^(?:\.\/)+/, '');

/** For a path outside every package that no rule names. When in doubt, take the higher tier. */
const UNNAMED: { tier: Tier; why: string } = {
  tier: '2a',
  why: 'outside any package, and no rule names it',
};

/**
 * The floor for a set of changed paths, with the reason each path landed where it did. The floor
 * is the highest tier any path reaches, so adding a path can only raise it.
 */
export function assignTier(paths: readonly string[]): TierResult {
  const reasons = [...new Set(paths)].map((path): Reason => {
    const rule = RULES.find((r) => r.matches(ruleKey(path))) ?? UNNAMED;
    return { path, tier: rule.tier, why: rule.why };
  });

  // Tier 1 is feature work inside one package. Work that spans packages goes up a step.
  const packages = [
    ...new Set(reasons.filter((r) => r.tier === '1').map((r) => packageOf(ruleKey(r.path)))),
  ];
  const spanned = reasons.map((r): Reason => {
    if (r.tier !== '1') return r;
    const where = packageOf(ruleKey(r.path)) ?? '';
    return packages.length > 1
      ? { ...r, tier: '2a', why: `feature work spanning ${packages.length} packages` }
      : { ...r, why: `feature work inside ${where}` };
  });

  return { tier: spanned.map((r) => r.tier).reduce(higher, '0'), reasons: spanned };
}

/** GitHub's list of a PR's files stops here, even when paginated. */
const LIST_LIMIT = 3000;

type PullFile = { filename: string; previous_filename?: string };

/**
 * The floor for a PR, from GitHub's list of its files (`gh api --paginate --slurp
 * repos/<repo>/pulls/<n>/files`) and its `changed_files` count. A renamed file counts under both
 * names: moving a file out of a 2b folder is 2b. If the list is incomplete, the files it left out
 * could be anything, so the PR is 2b.
 */
export function tierForPull(pages: unknown, changedFiles: number): TierResult {
  const files: unknown[] = Array.isArray(pages) ? pages.flat() : [];
  if (!Array.isArray(pages) || !files.every(isPullFile)) {
    throw new Error('expected the JSON from the pull request files API');
  }
  const paths = files.flatMap((f) =>
    f.previous_filename === undefined ? [f.filename] : [f.filename, f.previous_filename],
  );
  const result = assignTier(paths);
  if (files.length === changedFiles && files.length < LIST_LIMIT) return result;
  const unlisted: Reason = {
    path: '(files GitHub did not list)',
    tier: '2b',
    why: `GitHub listed ${files.length} of ${changedFiles} changed files (its list stops at ${LIST_LIMIT}), so the rest can't be checked`,
  };
  return { tier: '2b', reasons: [unlisted, ...result.reasons] };
}

function isPullFile(value: unknown): value is PullFile {
  if (typeof value !== 'object' || value === null) return false;
  const { filename, previous_filename } = value as Record<string, unknown>;
  return (
    typeof filename === 'string' &&
    (previous_filename === undefined || typeof previous_filename === 'string')
  );
}

/** Reads a PR's files and file count from GitHub, for the current repo. GET requests only. */
function fetchPull(pr: string): TierResult {
  const gh = (...args: string[]) => execFileSync('gh', ['api', ...args], { encoding: 'utf8' });
  const changed = Number(gh(`repos/{owner}/{repo}/pulls/${pr}`, '--jq', '.changed_files'));
  const pages: unknown = JSON.parse(
    gh('--paginate', '--slurp', `repos/{owner}/{repo}/pulls/${pr}/files`),
  );
  return tierForPull(pages, changed);
}

/**
 * Paths from `git diff --name-only`, one per line or NUL-separated (`-z`). Without `-z`, git
 * wraps unusual names in quotes and escapes them, which would dodge every rule, so those are
 * refused rather than guessed at.
 */
export function parsePathList(text: string): string[] {
  const paths = text
    .split(text.includes('\0') ? '\0' : '\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line !== '');
  const quoted = paths.find((path) => path.startsWith('"'));
  if (quoted !== undefined) {
    throw new Error(`${quoted} looks quoted by git. Use git diff -z, so names arrive as they are.`);
  }
  return paths;
}

/** Keeps a path from breaking the markdown table, or injecting markup into a pasted review. */
const escapeCell = (text: string) => text.replace(/[|<>&`\\\r\n]/g, (c) => `&#${c.charCodeAt(0)};`);

/** The floor, and the paths that set it. Paths at lower tiers are only counted. */
export function report({ tier, reasons }: TierResult): string {
  const setBy = reasons
    .filter((r) => r.tier === tier)
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((r) => `| ${escapeCell(r.path)} | ${r.why.replaceAll('|', '\\|')} |`);
  const lower = reasons.length - setBy.length;
  return [
    `## Tier floor: ${tier}`,
    '',
    'The lowest tier this PR can have, from the paths it changes. Decide the tier with the 2b',
    'checklist in `docs/process/pull-requests.md`. You may raise it above this floor, never lower it.',
    '',
    ...(setBy.length === 0
      ? ['No paths changed.']
      : [`Set by:`, '', '| Path | Why |', '| --- | --- |', ...setBy]),
    ...(lower > 0 ? ['', `${lower} other path${lower === 1 ? '' : 's'} at lower tiers.`] : []),
    '',
  ].join('\n');
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { tier: { type: 'boolean', default: false }, pr: { type: 'string' } },
  });
  try {
    let result: TierResult;
    if (values.pr === undefined) {
      result = assignTier(parsePathList(readFileSync(0, 'utf8')));
    } else if (/^\d+$/.test(values.pr)) {
      result = fetchPull(values.pr);
    } else {
      throw new Error(`--pr takes a PR number, not ${JSON.stringify(values.pr)}`);
    }
    process.stdout.write(values.tier ? `${result.tier}\n` : report(result));
  } catch (error) {
    console.error(`tier: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
