// Assigns a PR's risk tier (0, 1, 2a or 2b) from the paths it changes.
// The rules are the tier table in docs/process/pull-requests.md, plus one floor: a path that
// .github/CODEOWNERS gives an owner is 2b, because GitHub makes it wait for the maintainer anyway.
// Run: git diff -z --name-only --no-renames origin/main...HEAD | node scripts/tier.ts [--tier]
// It prints a markdown report, or with --tier just the tier. CI runs it on every PR
// (.github/workflows/tier.yml) with --pull-files <file> --changed-files <n> instead of stdin,
// and labels the PR with the result.
//
// Paths can't show a comments-only or formatting-only change, or a contract change that touches
// scrubbing, so the result is a floor: people and agents may raise it, never lower it.
// Changing these rules is tier 2b, and this file is code-owned.

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
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

/**
 * The tier table from docs/process/pull-requests.md, as path rules. The first rule that matches
 * a path decides it. Order matters: harness and contract rules come before the docs and tests
 * rules, so `packages/core/SPEC.md` is a contract and `apps/web/AGENTS.md` is harness.
 */
const RULES: { tier: Tier; why: string; matches: (path: string) => boolean }[] = [
  { tier: '2b', why: 'permissions and settings', matches: (p) => p.startsWith('.claude/') },
  { tier: '2b', why: 'CI, releases and repo rules', matches: (p) => p.startsWith('.github/') },
  {
    tier: '2b',
    why: 'the agent harness',
    matches: (p) =>
      ['AGENTS.md', 'CLAUDE.md'].includes(basename(p)) || p.startsWith('docs/process/'),
  },
  { tier: '2b', why: 'agent identities', matches: (p) => p === 'scripts/as-agent.ts' },
  { tier: '2b', why: 'the tier rules themselves', matches: (p) => p === 'scripts/tier.ts' },
  {
    tier: '2b',
    why: 'dependencies used by apps/server',
    matches: (p) => p === 'apps/server/package.json',
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

/** For a path outside every package that no rule names. When in doubt, take the higher tier. */
const UNNAMED: { tier: Tier; why: string } = {
  tier: '2a',
  why: 'outside any package, and no rule names it',
};

type OwnerRule = { pattern: string; owners: string[]; regex: RegExp };

/** Turns one CODEOWNERS pattern (gitignore-style, as GitHub reads it) into a regex. */
function patternRegex(pattern: string): RegExp {
  // A leading slash, or a slash in the middle, anchors the pattern at the repo root.
  const anchored = pattern.startsWith('/') || pattern.slice(0, -1).includes('/');
  const dirOnly = pattern.endsWith('/');
  const glob = pattern.replace(/^\//, '').replace(/\/$/, '');
  let body = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (glob.startsWith('**/', i)) {
      body += '(?:.*/)?';
      i += 2;
    } else if (glob.startsWith('**', i)) {
      body += '.*';
      i += 1;
    } else if (c === '*') {
      body += '[^/]*';
    } else if (c === '?') {
      body += '[^/]';
    } else {
      body += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  // A pattern that names a folder covers everything inside it.
  const end = dirOnly ? '/.*$' : '(?:/.*)?$';
  return new RegExp(`${anchored ? '^' : '^(?:.*/)?'}${body}${end}`);
}

export function parseCodeowners(text: string): OwnerRule[] {
  return text
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter((line) => line !== '')
    .map((line) => {
      const [pattern = '', ...owners] = line.split(/\s+/);
      return { pattern, owners, regex: patternRegex(pattern) };
    });
}

/** The CODEOWNERS pattern that gives this path an owner, if any. The last matching line wins. */
export function ownedBy(rules: readonly OwnerRule[], path: string): string | undefined {
  const last = rules.findLast((rule) => rule.regex.test(path));
  return last !== undefined && last.owners.length > 0 ? last.pattern : undefined;
}

/** The tier for a set of changed paths, with the reason each path landed where it did. */
export function assignTier(paths: readonly string[], codeowners: string): TierResult {
  const owners = parseCodeowners(codeowners);
  const reasons = [...new Set(paths)].map((path): Reason => {
    const rule = RULES.find((r) => r.matches(path)) ?? UNNAMED;
    const owned = ownedBy(owners, path);
    if (owned !== undefined && rule.tier !== '2b') {
      return {
        path,
        tier: '2b',
        why: `${rule.why} (tier ${rule.tier}), but code-owned by \`${owned}\` in CODEOWNERS`,
      };
    }
    return { path, tier: rule.tier, why: rule.why };
  });

  // Tier 1 is feature work inside one package. Work that spans packages goes up a step.
  const packages = [
    ...new Set(reasons.filter((r) => r.tier === '1').map((r) => packageOf(r.path))),
  ];
  const spanned = reasons.map((r): Reason => {
    if (r.tier !== '1') return r;
    const where = packageOf(r.path) ?? '';
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
 * The tier for a PR, from GitHub's list of its files (`gh api --paginate --slurp
 * repos/<repo>/pulls/<n>/files`) and its `changed_files` count. A renamed file counts under both
 * names: moving a file out of a 2b folder is 2b. If the list is incomplete, the files it left out
 * could be anything, so the PR is 2b.
 */
export function tierForPull(pages: unknown, changedFiles: number, codeowners: string): TierResult {
  const files: unknown[] = Array.isArray(pages) ? pages.flat() : [];
  if (!Array.isArray(pages) || !files.every(isPullFile)) {
    throw new Error('expected the JSON from the pull request files API');
  }
  const paths = files.flatMap((f) =>
    f.previous_filename === undefined ? [f.filename] : [f.filename, f.previous_filename],
  );
  const result = assignTier(paths, codeowners);
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

/** Keeps a path from breaking the markdown table, or injecting markup into the CI summary. */
const escapeCell = (text: string) => text.replace(/[|<>&`\\]/g, (c) => `&#${c.charCodeAt(0)};`);

export function report({ tier, reasons }: TierResult): string {
  const rows = [...reasons]
    .sort((a, b) => rank(b.tier) - rank(a.tier) || a.path.localeCompare(b.path))
    .map((r) => `| ${escapeCell(r.path)} | ${r.tier} | ${r.why.replaceAll('|', '\\|')} |`);
  return [
    `## Risk tier: ${tier}`,
    '',
    'From the changed paths, by the rules in `docs/process/pull-requests.md`. The highest path wins.',
    "Paths can't show comments-only changes or what a contract touches, so this is a floor:",
    'raise it in the description when you know better, never lower it.',
    '',
    '| Path | Tier | Why |',
    '| --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      tier: { type: 'boolean', default: false },
      'pull-files': { type: 'string' },
      'changed-files': { type: 'string' },
    },
  });
  const codeowners = readFileSync(join(import.meta.dirname, '..', '.github', 'CODEOWNERS'), 'utf8');
  try {
    let result: TierResult;
    if (values['pull-files'] === undefined) {
      result = assignTier(parsePathList(readFileSync(0, 'utf8')), codeowners);
    } else {
      const changed = Number(values['changed-files']);
      if (!Number.isInteger(changed) || changed < 0) {
        throw new Error('--pull-files needs --changed-files <n>, the PR changed_files count');
      }
      const pages: unknown = JSON.parse(readFileSync(values['pull-files'], 'utf8'));
      result = tierForPull(pages, changed, codeowners);
    }
    process.stdout.write(values.tier ? `${result.tier}\n` : report(result));
  } catch (error) {
    console.error(`tier: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
