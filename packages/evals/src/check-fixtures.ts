// Slow check, not part of `pnpm verify`: confirms every public fixture still matches GitHub.
// For each manifest it checks that the PR's head is `head`, that `base` is the merge base,
// that the size bucket fits the diff, and that every line range sits inside a diff hunk.
// Needs an authenticated `gh`. Run: pnpm --filter @docent/evals check:fixtures

import { execFileSync } from 'node:child_process';
import { loadFixtures, PUBLIC_FIXTURES_DIR } from './fixtures.ts';
import { type FixtureManifest, type LineRange, sizeFor } from './manifest.ts';

interface CompareFile {
  filename: string;
  additions: number;
  deletions: number;
  patch?: string;
}

function ghApi<T>(path: string): T {
  const out = execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out) as T;
}

/** New-side line spans of each hunk in a unified diff patch. */
function hunkSpans(patch: string): LineRange[] {
  const spans: LineRange[] = [];
  for (const match of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count > 0) spans.push({ start, end: start + count - 1 });
  }
  return spans;
}

function checkFixture(fixture: FixtureManifest): string[] {
  const { repo, pr, base, head } = fixture.source;
  const problems: string[] = [];

  let prHead: string;
  try {
    prHead = ghApi<{ head: { sha: string } }>(`repos/${repo}/pulls/${pr}`).head.sha;
  } catch {
    return [`could not read ${repo}#${pr}`];
  }
  if (prHead !== head)
    problems.push(`source.head is ${head}, but ${repo}#${pr} has head ${prHead}`);

  let compare: { merge_base_commit: { sha: string }; files: CompareFile[] };
  try {
    compare = ghApi(`repos/${repo}/compare/${base}...${head}`);
  } catch {
    return [...problems, `could not compare ${base}...${head}; does each SHA exist?`];
  }
  if (compare.merge_base_commit.sha !== base) {
    problems.push(`source.base must be the merge base ${compare.merge_base_commit.sha}`);
  }

  const changed = compare.files.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  if (sizeFor(changed) !== fixture.size) {
    problems.push(
      `size is "${fixture.size}", but ${changed} changed lines is "${sizeFor(changed)}"`,
    );
  }

  const ranges = [
    ...fixture.expectedFindings.map((r, i) => ({ ...r, at: `expectedFindings[${i}]` })),
    ...fixture.mustNotSkip.map((r, i) => ({ ...r, at: `mustNotSkip[${i}]` })),
  ];
  for (const { at, file, lines } of ranges) {
    const where = `${at} ${file}:${lines.start}-${lines.end}`;
    const changedFile = compare.files.find((f) => f.filename === file);
    if (!changedFile) {
      problems.push(`${where}: file is not in the diff`);
      continue;
    }
    if (!changedFile.patch) {
      problems.push(`${where}: GitHub sent no patch for this file (too large?)`);
      continue;
    }
    const spans = hunkSpans(changedFile.patch);
    if (!spans.some((s) => s.start <= lines.start && lines.end <= s.end)) {
      const list = spans.map((s) => `${s.start}-${s.end}`).join(', ');
      problems.push(`${where}: not inside one diff hunk (hunks at head: ${list})`);
    }
  }
  return problems;
}

const { manifests, problems: loadProblems } = loadFixtures(PUBLIC_FIXTURES_DIR, 'public');
const problems = [...loadProblems];
for (const manifest of manifests) {
  for (const problem of checkFixture(manifest)) problems.push(`${manifest.id}: ${problem}`);
}

if (problems.length > 0) {
  console.error(`check:fixtures: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`check:fixtures: ${manifests.length} fixtures match GitHub`);
