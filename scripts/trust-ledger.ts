// The trust ledger: how agent-landed PRs have held up, per tier and per kind of change.
// It reads GitHub history (GET requests only) and prints a markdown report for the morning brief.
// Why: backlog item 4, "a trust ledger, so autonomy is earned by evidence".
//
// Run:  node scripts/trust-ledger.ts [report.md] [--record snapshot.json] [--replay snapshot.json]
//   report.md  write the report there instead of stdout
//   --record   also save every API response, keyed by path (how the test fixture was made)
//   --replay   read API responses from a saved snapshot instead of GitHub

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const REPO = 'hartz89/docent';
const MAINTAINER = 'hartz89';
const REVIEWER_APP = 'docent-reviewer-hartz89[bot]';
const ESCALATION_LABEL = 'needs-maintainer';

/** Answers one GitHub API GET path with parsed JSON. */
export type Gh = (path: string) => unknown;

type Tier = '0' | '1' | '2' | '2a' | '2b';
type TierSource = 'label' | 'description' | 'backtest' | 'none';

// --- What we read from GitHub (only the fields we use) ---

interface ApiPull {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged_at: string | null;
  created_at: string;
  labels: { name: string }[];
}

interface ApiEvent {
  event: string;
  actor?: { login: string } | null;
  user?: { login: string } | null;
  state?: string;
  body?: string | null;
  created_at?: string;
  submitted_at?: string;
  committer?: { date: string };
  requested_reviewer?: { login: string } | null;
  label?: { name: string };
}

interface ApiReviewComment {
  user: { login: string } | null;
  body: string;
  created_at: string;
  in_reply_to_id?: number;
}

interface ApiFile {
  filename: string;
}

/** Reads every page of a list endpoint. */
function readAll<T>(gh: Gh, path: string): T[] {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const batch = gh(`${path}${sep}per_page=100&page=${page}`) as T[];
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

// --- One PR, as the ledger sees it ---

/** A link between two PRs: one reverted or fixed the other. */
interface Repair {
  number: number;
  how: 'reverted' | 'fixed';
}

export interface Pr {
  number: number;
  title: string;
  createdAt: string;
  mergedAt: string | null;
  closedUnmerged: boolean;
  tier: Tier | null;
  tierSource: TierSource;
  kind: string;
  /** An agent review flagged a problem: requested changes, named one, or left an inline comment. */
  reviewerFlagged: boolean;
  reviewedByAgent: boolean;
  waitedForMaintainer: boolean;
  /** Why the maintainer overrode it, if he did. */
  override: string | null;
  escalatedAt: string | null;
  /** Earlier PRs this one says it reverts or fixes. */
  repairs: Repair[];
  /** Later merged PRs that reverted or fixed this one. */
  repairedBy: Repair[];
}

// --- Tier: label, then description, then the 2026-11-10 backtest ---

/** Matches labels such as "tier-2b", "tier: 1" or "Tier 0". */
function tierFromLabels(labels: string[]): Tier | null {
  for (const name of labels) {
    const tier = /^tier[\s:/-]*(2a|2b|0|1|2)$/i.exec(name)?.[1];
    if (tier) return tier.toLowerCase() as Tier;
  }
  return null;
}

/** Matches "## Tier: 2b", "## Tier\n\n2b", "**Tier 1:**", "**Tier:** 2b", "**Tier: 2.**". */
function tierFromDescription(body: string): Tier | null {
  const tier = /^(?:##\s*|\*\*)Tier\b[\s:*]*(2a|2b|0|1|2)\b/im.exec(body)?.[1];
  return tier ? (tier.toLowerCase() as Tier) : null;
}

function loadBacktest(): Record<string, Tier> {
  const url = new URL('./trust-ledger-backtest.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')).tiers;
}

// --- Kind of change: the riskiest area a PR touches ---

const KINDS: [string, (path: string) => boolean][] = [
  ['identity & GitHub config', (p) => p.startsWith('.github/') || p === 'scripts/as-agent.ts'],
  [
    'harness & permissions',
    (p) =>
      p.startsWith('.claude/') ||
      p.startsWith('docs/process/') ||
      p === 'AGENTS.md' ||
      p === 'CLAUDE.md' ||
      p === 'lefthook.yml',
  ],
  ['server', (p) => p.startsWith('apps/server/')],
  ['core', (p) => p.startsWith('packages/core/')],
  ['evals', (p) => p.startsWith('packages/evals/')],
  ['web', (p) => p.startsWith('apps/web/')],
  ['tooling & deps', (p) => p.startsWith('scripts/') || !p.includes('/')],
  ['e2e', (p) => p.startsWith('e2e/')],
];

export function kindOf(paths: string[]): string {
  for (const [kind, matches] of KINDS) if (paths.some(matches)) return kind;
  return 'docs & backlog';
}

// --- Repairs: reverts and fixes that point back at an earlier PR ---

/** PR numbers this PR reverts or fixes, from its title and description. */
export function repairsIn(title: string, body: string): Repair[] {
  const found: Repair[] = [];
  const add = (n: string | undefined, how: Repair['how']) => {
    if (n && !found.some((r) => r.number === Number(n))) found.push({ number: Number(n), how });
  };
  // "Revert line wrapping (#29, #30)", or GitHub's own 'Revert "…"' with "Reverts owner/repo#29".
  if (/^revert\b/i.test(title)) {
    for (const m of title.matchAll(/#(\d+)/g)) add(m[1], 'reverted');
    for (const m of body.matchAll(/\breverts\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/gi))
      add(m[1], 'reverted');
  }
  // "fix the bug the reviewer found in [#29](…)", "Fixes #12": a fix word, then a PR number
  // later in the same sentence. Closing a gap the earlier PR disclosed ("fixes the gap
  // noted in #25") isn't a repair: nothing escaped.
  for (const m of `${title}\n${body}`.matchAll(/\bfix(?:es|ed)?\b([^.\n#]{0,80})#(\d+)/gi)) {
    if (!/\bgaps?\b/i.test(m[1] ?? '')) add(m[2], 'fixed');
  }
  return found;
}

// --- Building the ledger ---

const isMaintainer = (login: string | undefined) => login === MAINTAINER;
const loginOf = (e: ApiEvent) => (e.user ?? e.actor)?.login;
const timeOf = (e: ApiEvent) => e.submitted_at ?? e.created_at ?? e.committer?.date ?? '';

/**
 * A review or PR comment by the fresh-context reviewer: the reviewer app, or, before the app
 * existed, an agent review posted through the maintainer's login (#3 to #7 did this).
 */
function isAgentReview(e: ApiEvent): boolean {
  if (e.event !== 'reviewed' && e.event !== 'commented') return false;
  return (
    loginOf(e) === REVIEWER_APP ||
    (isMaintainer(loginOf(e)) &&
      /posted (?:here )?through the maintainer's login/i.test(e.body ?? ''))
  );
}

/**
 * Whether review text names a problem: "must-fix", "should-fix", "blockers", "real bug",
 * "fix first", "changes needed". A match is ignored when its sentence negates it before it,
 * as in "No must-fix or should-fix findings" or "I found no real bugs".
 */
export function reportsProblem(text: string): boolean {
  const problem = /must[- ]fix|should[- ]fix|blockers?\b|real bugs?|fix first|changes needed/gi;
  for (const m of text.matchAll(problem)) {
    const sentence =
      text
        .slice(0, m.index)
        .split(/[.!?\n]/)
        .at(-1) ?? '';
    if (!/\b(?:no|not|nothing|without)\b/i.test(sentence)) return true;
  }
  return false;
}

export function buildLedger(gh: Gh, backtest: Record<string, Tier> = loadBacktest()): Pr[] {
  const pulls = readAll<ApiPull>(gh, `repos/${REPO}/pulls?state=all`).sort(
    (a, b) => a.number - b.number,
  );
  const prs: Pr[] = pulls.map((pull) => {
    const events = readAll<ApiEvent>(gh, `repos/${REPO}/issues/${pull.number}/timeline`);
    const inline = readAll<ApiReviewComment>(gh, `repos/${REPO}/pulls/${pull.number}/comments`);
    const files = readAll<ApiFile>(gh, `repos/${REPO}/pulls/${pull.number}/files`).map(
      (f) => f.filename,
    );
    const body = pull.body ?? '';

    const labelTier = tierFromLabels(pull.labels.map((l) => l.name));
    const bodyTier = tierFromDescription(body);
    const pastTier = backtest[String(pull.number)] ?? null;
    const [tier, tierSource]: [Tier | null, TierSource] = labelTier
      ? [labelTier, 'label']
      : bodyTier
        ? [bodyTier, 'description']
        : pastTier
          ? [pastTier, 'backtest']
          : [null, 'none'];

    const agentReviews = events.filter(isAgentReview);
    const appInline = inline.filter((c) => c.user?.login === REVIEWER_APP && !c.in_reply_to_id);

    const escalation = events.find(
      (e) => e.event === 'labeled' && e.label?.name === ESCALATION_LABEL,
    );
    const merged = events.find((e) => e.event === 'merged');
    const closedUnmerged = pull.state === 'closed' && !pull.merged_at;
    const waitedForMaintainer =
      !!escalation ||
      events.some(
        (e) => e.event === 'review_requested' && isMaintainer(e.requested_reviewer?.login),
      ) ||
      (!!merged && isMaintainer(loginOf(merged)));

    return {
      number: pull.number,
      title: pull.title,
      createdAt: pull.created_at,
      mergedAt: pull.merged_at,
      closedUnmerged,
      tier,
      tierSource,
      kind: kindOf(files),
      reviewerFlagged:
        appInline.length > 0 ||
        agentReviews.some((e) => e.state === 'changes_requested' || reportsProblem(e.body ?? '')),
      reviewedByAgent: agentReviews.length > 0,
      waitedForMaintainer,
      override: waitedForMaintainer ? overrideOf(events, inline, closedUnmerged) : null,
      escalatedAt: escalation ? timeOf(escalation) : null,
      repairs: repairsIn(pull.title, body),
      repairedBy: [],
    };
  });

  linkRepairs(prs);
  return prs;
}

/** How the maintainer changed or rejected a PR that waited for him, or null if he didn't. */
function overrideOf(
  events: ApiEvent[],
  inline: ApiReviewComment[],
  closedUnmerged: boolean,
): string | null {
  if (closedUnmerged) return 'closed without merging';
  if (
    events.some(
      (e) => e.event === 'reviewed' && isMaintainer(loginOf(e)) && e.state === 'changes_requested',
    )
  ) {
    return 'requested changes';
  }
  // A remark from him, followed by new commits: he asked for follow-up work. Remarks are his
  // comments, inline comments, and reviews with text. Approvals, agent reviews posted through
  // his login, and "Docent feedback:" (about the tour, not the PR) don't count.
  const isRemark = (e: ApiEvent) => {
    const text = (e.body ?? '').trim();
    return (
      text !== '' &&
      !text.startsWith('Docent feedback:') &&
      e.state !== 'approved' &&
      !isAgentReview(e)
    );
  };
  const remarks = [
    ...events
      .filter(
        (e) => (e.event === 'commented' || e.event === 'reviewed') && isMaintainer(loginOf(e)),
      )
      .filter(isRemark)
      .map(timeOf),
    ...inline.filter((c) => isMaintainer(c.user?.login)).map((c) => c.created_at),
  ].sort();
  const end = events.find((e) => e.event === 'merged' || e.event === 'closed');
  const first = remarks[0];
  if (
    first !== undefined &&
    events.some(
      (e) => e.event === 'committed' && timeOf(e) > first && (!end || timeOf(e) < timeOf(end)),
    )
  ) {
    return 'commented, then more commits followed';
  }
  return null;
}

/**
 * Marks each merged PR that a later merged PR reverted or fixed.
 * A fix that's reverted together with the PR it fixed is part of the same incident,
 * so it isn't counted as a second escape (#29, fixed in #30, both reverted in #31).
 */
function linkRepairs(prs: Pr[]): void {
  const merged = new Map(mergedInOrder(prs).map((p) => [p.number, p]));
  for (const pr of merged.values()) {
    // Only PRs that merged before this one can be repaired by it.
    const repairs = pr.repairs.flatMap((r) => {
      const target = merged.get(r.number);
      return target && target.mergedAt < pr.mergedAt ? [{ ...r, target }] : [];
    });
    const reverted = new Set(repairs.filter((r) => r.how === 'reverted').map((r) => r.number));
    for (const { target, how } of repairs) {
      const fixesAnotherRevertedHere =
        how === 'reverted' &&
        target.repairs.some((x) => x.how === 'fixed' && reverted.has(x.number));
      if (!fixesAnotherRevertedHere) target.repairedBy.push({ number: pr.number, how });
    }
  }
}

/** Merged PRs, oldest merge first. */
function mergedInOrder(prs: Pr[]): (Pr & { mergedAt: string })[] {
  return prs
    .filter((p): p is Pr & { mergedAt: string } => p.mergedAt !== null)
    .sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
}

// --- The report ---

const link = (n: number) => `[#${n}](https://github.com/${REPO}/pull/${n})`;
const pct = (part: number, whole: number) =>
  whole === 0 ? '–' : `${Math.round((100 * part) / whole)}%`;

interface Row {
  merged: number;
  escapes: number;
  reviewed: number;
  flagged: number;
  missed: number;
  cleanRun: number;
}

function rowFor(prs: Pr[]): Row {
  const merged = mergedInOrder(prs);
  const escaped = merged.filter((p) => p.repairedBy.length > 0);
  const lastEscape = escaped.at(-1);
  return {
    merged: merged.length,
    escapes: escaped.length,
    reviewed: merged.filter((p) => p.reviewedByAgent).length,
    flagged: merged.filter((p) => p.reviewerFlagged).length,
    missed: escaped.filter((p) => !p.reviewerFlagged).length,
    cleanRun: lastEscape ? merged.length - 1 - merged.indexOf(lastEscape) : merged.length,
  };
}

function table(groupName: string, groups: [string, Pr[]][]): string {
  const lines = [
    `| ${groupName} | Merged | Escapes | Failure rate | Agent-reviewed | Reviewer flagged | Catch rate | Clean merges since last escape |`,
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const [name, members] of groups) {
    const r = rowFor(members);
    const known = r.flagged + r.missed;
    lines.push(
      `| ${name} | ${r.merged} | ${r.escapes} | ${pct(r.escapes, r.merged)} | ${r.reviewed} | ${r.flagged} | ${pct(r.flagged, known)} | ${r.cleanRun} |`,
    );
  }
  return lines.join('\n');
}

function groupBy(prs: Pr[], key: (p: Pr) => string): [string, Pr[]][] {
  const groups = new Map<string, Pr[]>();
  for (const p of prs) groups.set(key(p), [...(groups.get(key(p)) ?? []), p]);
  return [...groups].sort(([a], [b]) => a.localeCompare(b));
}

/** Monday of the week, as YYYY-MM-DD. */
function weekOf(iso: string): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export function renderReport(prs: Pr[]): string {
  const merged = prs.filter((p) => p.mergedAt);
  const all = rowFor(prs);
  const escaped = merged.filter((p) => p.repairedBy.length > 0);
  const waited = prs.filter((p) => p.waitedForMaintainer && (p.mergedAt || p.closedUnmerged));
  const overridden = waited.filter((p) => p.override);
  const escalated = prs.filter((p) => p.escalatedAt);
  const out: string[] = [];

  out.push('## Trust ledger', '');
  out.push(
    `${prs.length} PRs (${link(prs[0]?.number ?? 0)} to ${link(prs.at(-1)?.number ?? 0)}), ${merged.length} merged.`,
    '',
    `- **Escapes:** ${all.escapes} of ${all.merged} merged PRs were later reverted or fixed (${pct(all.escapes, all.merged)}, the change failure rate).`,
    `- **Review catch rate:** the reviewer flagged problems in ${all.flagged} merged PRs, and missed ${all.missed} that escaped (${pct(all.flagged, all.flagged + all.missed)} caught).`,
    `- **Override rate:** the maintainer changed or rejected ${overridden.length} of ${waited.length} PRs that waited for him (${pct(overridden.length, waited.length)}).`,
    escalated.length === 0
      ? `- **Escalations:** none yet; no PR has carried the \`${ESCALATION_LABEL}\` label.`
      : `- **Escalations:** ${escalated.length} PRs labeled \`${ESCALATION_LABEL}\`, ${escalated.filter((p) => !p.mergedAt && !p.closedUnmerged).length} still open.`,
    '',
  );

  out.push(
    '### By tier',
    '',
    table(
      'Tier',
      groupBy(prs, (p) => p.tier ?? 'unknown'),
    ),
    '',
  );
  out.push(
    '### By kind of change',
    '',
    table(
      'Kind',
      groupBy(prs, (p) => p.kind),
    ),
    '',
  );

  out.push('### Escapes', '');
  if (escaped.length === 0) out.push('None.', '');
  else {
    out.push('| PR | Tier | Kind | Repaired by | Reviewer flagged it? |', '|---|---|---|---|---|');
    for (const p of escaped) {
      const by = p.repairedBy.map((r) => `${r.how} in ${link(r.number)}`).join(', ');
      out.push(
        `| ${link(p.number)} ${p.title} | ${p.tier ?? '?'} | ${p.kind} | ${by} | ${p.reviewerFlagged ? 'yes' : 'no'} |`,
      );
    }
    out.push('');
  }

  out.push('### Waited for the maintainer', '');
  if (overridden.length === 0)
    out.push(`None of the ${waited.length} was changed or rejected.`, '');
  else {
    out.push('| PR | Tier | What he did |', '|---|---|---|');
    for (const p of overridden)
      out.push(`| ${link(p.number)} ${p.title} | ${p.tier ?? '?'} | ${p.override} |`);
    out.push(
      '',
      `Not changed: ${
        waited
          .filter((p) => !p.override)
          .map((p) => link(p.number))
          .join(', ') || 'none'
      }.`,
      '',
    );
  }

  out.push('### Escalations per week', '');
  if (escalated.length === 0)
    out.push(`None yet: the \`${ESCALATION_LABEL}\` label hasn't been used.`, '');
  else {
    out.push('| Week of | PRs opened | Escalated |', '|---|---|---|');
    for (const [week, opened] of groupBy(prs, (p) => weekOf(p.createdAt))) {
      const n = escalated.filter((p) => p.escalatedAt && weekOf(p.escalatedAt) === week).length;
      out.push(`| ${week} | ${opened.length} | ${n} |`);
    }
    out.push('');
  }

  const sources = groupBy(prs, (p) => p.tierSource).map(([s, ps]) => `${s} ${ps.length}`);
  out.push(
    '<details><summary>Every PR, and where its tier came from</summary>',
    '',
    `Tier sources: ${sources.join(', ')}. "backtest" means the tiering backtest of 2026-11-10 (\`scripts/trust-ledger-backtest.json\`), used only when the PR states no tier.`,
    '',
    '| PR | State | Tier | Source | Kind | Reviewer flagged | Escaped |',
    '|---|---|---|---|---|---|---|',
  );
  for (const p of prs) {
    const state = p.mergedAt ? 'merged' : p.closedUnmerged ? 'closed' : 'open';
    out.push(
      `| ${link(p.number)} | ${state} | ${p.tier ?? '?'} | ${p.tierSource} | ${p.kind} | ${p.reviewerFlagged ? 'yes' : ''} | ${p.repairedBy.length ? 'yes' : ''} |`,
    );
  }
  out.push('', '</details>', '');

  out.push(
    '**How to read this.**',
    '- An **escape** is a merged PR that a later PR reverted, or said it fixed. A fix reverted along with the PR it fixed is the same incident, not a second escape.',
    "- The **reviewer** is the fresh-context agent review: the reviewer app, or, before it existed, a review posted through the maintainer's login. It **flagged** a PR when it requested changes, left an inline comment, or named a must-fix, should-fix, blocker or real bug, at any time, even after merge.",
    "- **Catch rate** is flagged PRs out of flagged PRs plus escapes the reviewer didn't flag.",
    '- A PR **waited for the maintainer** when it requested his review, carried the escalation label, or he merged it himself. He **changed** it when he requested changes, or remarked and more commits followed; he **rejected** it when it closed unmerged.',
    '- **Kind** is the riskiest area a PR touches, in this order: identity & GitHub config, harness & permissions, server, core, evals, web, tooling & deps, e2e, docs & backlog.',
  );
  return `${out.join('\n')}\n`;
}

// --- Command line ---

function liveGh(path: string): unknown {
  return JSON.parse(
    execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
  );
}

function main(args: string[]): void {
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args.splice(i, 2)[1];
  };
  const record = flag('--record');
  const replay = flag('--replay');
  const outPath = args[0];

  const saved: Record<string, unknown> = replay ? JSON.parse(readFileSync(replay, 'utf8')) : {};
  const gh: Gh = (path) => {
    if (replay) {
      if (!(path in saved)) throw new Error(`${replay} has no response for ${path}`);
      return saved[path];
    }
    saved[path] = liveGh(path);
    return saved[path];
  };

  const report = renderReport(buildLedger(gh));
  if (record) writeFileSync(record, `${JSON.stringify(saved, null, 1)}\n`);
  if (outPath) writeFileSync(outPath, report);
  else process.stdout.write(report);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
