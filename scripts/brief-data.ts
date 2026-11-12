// Gathers what changed since the last maintainer brief, as JSON for the brief skill
// (.claude/skills/brief/SKILL.md). Read-only: every GitHub call is a GET through `gh api`,
// run as the builder app by default. How briefs work: docs/process/briefs.md
//
//   node scripts/brief-data.ts                 JSON on stdout, since the last brief
//   node scripts/brief-data.ts --since <iso>   from a given time instead
//   node scripts/brief-data.ts --plain-gh      use your own gh login, not the builder app
//   node scripts/brief-data.ts --threshold <n> the score at which a brief is due (default 10)
//   node scripts/brief-data.ts --mark <iso> [--url <artifact>]
//                                              record that a brief covering up to <iso> went out
//
// The last brief's time lives outside the repo, in the git common dir shared by every
// worktree: <git-common-dir>/docent/last-brief.json. It's per machine, like the briefs.

import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

export const REPO = 'hartz89/docent';

/** A brief is due once merged PRs plus every 500 changed lines reach this. */
export const DUE_THRESHOLD = 10;
const LINES_PER_POINT = 500;
/** Escalated PRs that may wait on the maintainer at once (docs/process/pull-requests.md). */
export const ESCALATION_LIMIT = 2;
const NEEDS_MAINTAINER = 'needs-maintainer';
const ESCALATION_QUEUED = 'escalation-queued';
/** With no last brief recorded, look back this far. */
const DEFAULT_LOOKBACK_DAYS = 3;
const PER_PAGE = 100;
const MAX_PAGES = 10;

/** Fetches one GitHub REST path (GET) and returns the parsed JSON. */
export type Api = (path: string) => Promise<unknown>;

export type Tier = '0' | '1' | '2a' | '2b' | '2';

export type MergedPr = {
  number: number;
  url: string;
  title: string;
  author: string;
  mergedAt: string;
  tier: Tier | null;
  /** First sentence of the description's Intent, or the title when there is none. */
  outcome: string;
  additions: number;
  deletions: number;
  labels: string[];
};

export type OpenPr = {
  number: number;
  url: string;
  title: string;
  author: string;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  autoMerge: boolean;
  tier: Tier | null;
  /** First sentence of the description's Intent, or the title when there is none. */
  outcome: string;
  labels: string[];
  /** Description sections addressed to the maintainer: open questions, steps, decisions. */
  maintainerNotes: { heading: string; text: string }[];
};

export type Escape = {
  kind: 'revert' | 'fix';
  /** The PR that reverted or fixed. */
  by: { number: number; url: string; title: string };
  /** The earlier PRs it repairs. */
  repairs: { number: number; url: string; tier: Tier | null }[];
};

export type BriefData = {
  repo: string;
  since: string;
  sinceSource: 'flag' | 'last-brief' | 'default';
  until: string;
  lastBrief: LastBrief | null;
  change: {
    mergedPrs: number;
    changedLines: number;
    score: number;
    threshold: number;
    due: boolean;
  };
  merged: MergedPr[];
  escalations: {
    limit: number;
    waiting: OpenPr[];
    queued: OpenPr[];
    overLimit: boolean;
  };
  inProgress: OpenPr[];
  escapes: Escape[];
  /** Merged PRs and escapes per tier, this period. The trust ledger's raw numbers. */
  ledger: Record<string, { merged: number; escapes: number }>;
  newBacklogIssues: { number: number; url: string; title: string; createdAt: string }[];
  mainCiFailures: {
    name: string;
    url: string;
    title: string;
    sha: string;
    createdAt: string;
    /** True when this is the workflow's latest run on main: main is red right now. */
    stillFailing: boolean;
  }[];
  /** The "Open" section of backlog/decisions.md on main, one entry per bullet. */
  openDecisions: { title: string; text: string }[];
};

export type LastBrief = { at: string; url?: string };

type Raw = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const login = (user: unknown): string => str((user as Raw | null)?.login);
const labelNames = (labels: unknown): string[] =>
  Array.isArray(labels) ? labels.map((l) => str((l as Raw).name)).filter(Boolean) : [];

/** Reads every page of a list endpoint, stopping early once `done` says the rest is too old. */
async function pages(api: Api, path: string, done?: (item: Raw) => boolean): Promise<Raw[]> {
  const all: Raw[] = [];
  const sep = path.includes('?') ? '&' : '?';
  for (let page = 1; page <= MAX_PAGES; page++) {
    const items = (await api(`${path}${sep}per_page=${PER_PAGE}&page=${page}`)) as Raw[];
    all.push(...items);
    if (items.length < PER_PAGE || (done && items.some(done))) return all;
  }
  throw new Error(`${path} has more than ${MAX_PAGES} pages; narrow the window with --since`);
}

/** The tier a PR's description states, under a "Tier" heading or label. */
export function parseTier(body: string): Tier | null {
  const start = body.search(/^#{1,6}\s*Tier\b|\*\*Tier\b|^Tier:/im);
  if (start < 0) return null;
  const after = body.slice(start).replace(/^\W*Tier\W*/i, '');
  const match = after.slice(0, 200).match(/\b(2a|2b|0|1|2)\b(?!\.?\d)/i);
  return match ? ((match[1] as string).toLowerCase() as Tier) : null;
}

/** The first sentence of the description's Intent, as plain text. */
export function parseOutcome(body: string, title: string): string {
  const match = body.match(
    /(?:^#{1,6}\s*Intent\b[^\n]*\n+|\*\*Intent:?\*\*:?\s*)([\s\S]*?)(\n\n|$)/im,
  );
  const text = plain(match?.[1] ?? '');
  if (!text) return title;
  const sentence = text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;
  return sentence.length > 240 ? `${sentence.slice(0, 237)}...` : sentence;
}

const TO_MAINTAINER =
  /^(maintainer\b|open questions?|questions?\b|decisions?\b|needs you)|for the maintainer/i;

/** Description sections whose heading speaks to the maintainer. */
export function parseMaintainerNotes(body: string): { heading: string; text: string }[] {
  const notes: { heading: string; text: string }[] = [];
  const sections = body.split(/^(?=#{1,6}\s)/m);
  for (const section of sections) {
    const heading = section.match(/^#{1,6}\s+(.*)/)?.[1]?.trim();
    if (!heading || !TO_MAINTAINER.test(heading)) continue;
    const text = section.slice(section.indexOf('\n') + 1).trim();
    notes.push({ heading, text: text.length > 600 ? `${text.slice(0, 597)}...` : text });
  }
  return notes;
}

/** PR numbers a revert or fix says it repairs. */
export function parseRepairs(title: string, body: string): number[] {
  const found = new Set<number>();
  if (/\brevert/i.test(title)) for (const m of title.matchAll(/#(\d+)/g)) found.add(Number(m[1]));
  for (const m of body.matchAll(
    /^\s*(?:This )?(?:reverts?|repairs?):?\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/gim,
  )) {
    found.add(Number(m[1]));
  }
  return [...found].sort((a, b) => a - b);
}

/** The bullets under "## Open" in backlog/decisions.md. */
export function parseOpenDecisions(markdown: string): { title: string; text: string }[] {
  const open = markdown.match(/^## Open\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1] ?? '';
  return open
    .split(/^- /m)
    .slice(1)
    .map((item) => {
      const text = item.trim().replace(/\s+/g, ' ');
      const title = text.match(/^\*\*(.+?)\*\*/)?.[1]?.replace(/\.$/, '') ?? text.slice(0, 80);
      return { title, text };
    });
}

function plain(markdown: string): string {
  return markdown
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function openPr(raw: Raw): OpenPr {
  const body = str(raw.body);
  return {
    number: num(raw.number),
    url: str(raw.html_url),
    title: str(raw.title),
    author: login(raw.user),
    draft: raw.draft === true,
    createdAt: str(raw.created_at),
    updatedAt: str(raw.updated_at),
    autoMerge: raw.auto_merge != null,
    tier: parseTier(body),
    outcome: parseOutcome(body, str(raw.title)),
    labels: labelNames(raw.labels),
    maintainerNotes: parseMaintainerNotes(body),
  };
}

const inWindow = (at: string, since: string, until: string): boolean =>
  at !== '' && Date.parse(at) >= Date.parse(since) && Date.parse(at) < Date.parse(until);

/** Runs `fn` over `items`, a few at a time, keeping order. */
async function mapLimited<T, R>(items: T[], fn: (item: T) => Promise<R>, limit = 4): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return out;
}

export async function gather(
  api: Api,
  options: {
    since: string;
    sinceSource: BriefData['sinceSource'];
    until: string;
    lastBrief?: LastBrief | null;
    repo?: string;
    threshold?: number;
  },
): Promise<BriefData> {
  const { since, until } = options;
  const repo = options.repo ?? REPO;
  const threshold = options.threshold ?? DUE_THRESHOLD;
  const base = `repos/${repo}`;

  // Closed PRs, newest activity first. A PR merged in the window was updated at or after
  // its merge, so once a page reaches activity before `since`, nothing older can qualify.
  const closed = await pages(
    api,
    `${base}/pulls?state=closed&sort=updated&direction=desc`,
    (pr) => Date.parse(str(pr.updated_at)) < Date.parse(since),
  );
  const mergedRaw = closed
    .filter((pr) => inWindow(str(pr.merged_at), since, until))
    .sort((a, b) => Date.parse(str(a.merged_at)) - Date.parse(str(b.merged_at)));

  // The list endpoint has no line counts, so read each merged PR once.
  const details = await mapLimited(
    mergedRaw,
    (pr) => api(`${base}/pulls/${num(pr.number)}`) as Promise<Raw>,
  );
  const merged: MergedPr[] = details.map((pr) => {
    const body = str(pr.body);
    return {
      number: num(pr.number),
      url: str(pr.html_url),
      title: str(pr.title),
      author: login(pr.user),
      mergedAt: str(pr.merged_at),
      tier: parseTier(body),
      outcome: parseOutcome(body, str(pr.title)),
      additions: num(pr.additions),
      deletions: num(pr.deletions),
      labels: labelNames(pr.labels),
    };
  });

  // Reverts, and fixes that name what they repair (`Repairs #N`, or the `escape` label).
  const escapes: Escape[] = [];
  const tierOf = new Map(merged.map((pr) => [pr.number, pr.tier]));
  for (const [i, pr] of merged.entries()) {
    const repairs = parseRepairs(pr.title, str(details[i]?.body));
    const isRevert = /\brevert/i.test(pr.title);
    if (repairs.length === 0 && !pr.labels.includes('escape')) continue;
    const repaired = await mapLimited(repairs, async (n) => {
      if (!tierOf.has(n)) {
        // `#N` may name an issue, or a PR that doesn't exist. Count it, with no tier.
        const old = (await api(`${base}/pulls/${n}`).catch(() => null)) as Raw | null;
        tierOf.set(n, old ? parseTier(str(old.body)) : null);
      }
      return {
        number: n,
        url: `https://github.com/${repo}/pull/${n}`,
        tier: tierOf.get(n) ?? null,
      };
    });
    escapes.push({
      kind: isRevert ? 'revert' : 'fix',
      by: { number: pr.number, url: pr.url, title: pr.title },
      repairs: repaired,
    });
  }

  const ledger: BriefData['ledger'] = {};
  const row = (tier: Tier | 'unattributed' | null) => {
    const key = tier ?? 'unstated';
    ledger[key] ??= { merged: 0, escapes: 0 };
    return ledger[key];
  };
  for (const pr of merged) row(pr.tier).merged++;
  for (const found of escapes) {
    for (const r of found.repairs) row(r.tier).escapes++;
    // An `escape` label with no `Repairs #N` can't be pinned to a tier.
    if (found.repairs.length === 0) row('unattributed').escapes++;
  }

  const open = (await pages(api, `${base}/pulls?state=open&sort=created&direction=asc`)).map(
    openPr,
  );
  const waiting = open.filter((pr) => pr.labels.includes(NEEDS_MAINTAINER));
  const queued = open.filter(
    (pr) => pr.labels.includes(ESCALATION_QUEUED) && !pr.labels.includes(NEEDS_MAINTAINER),
  );
  const inProgress = open.filter((pr) => !waiting.includes(pr) && !queued.includes(pr));

  // `since` on the issues endpoint filters by update time, so check creation time too.
  const issues = await pages(
    api,
    `${base}/issues?labels=backlog&state=all&sort=created&direction=desc&since=${encodeURIComponent(since)}`,
  );
  const newBacklogIssues = issues
    .filter((issue) => !issue.pull_request && inWindow(str(issue.created_at), since, until))
    .map((issue) => ({
      number: num(issue.number),
      url: str(issue.html_url),
      title: str(issue.title),
      createdAt: str(issue.created_at),
    }));

  // Completed runs on main, newest first. A failure that a later run of the same workflow
  // fixed is history, not a red main, so it's marked `stillFailing: false`.
  const runs = (await api(
    `${base}/actions/runs?branch=main&status=completed&created=${encodeURIComponent(`>=${since}`)}&per_page=${PER_PAGE}`,
  )) as { workflow_runs?: Raw[] };
  const completed = (runs.workflow_runs ?? [])
    .filter((run) => inWindow(str(run.created_at), since, until))
    .sort((a, b) => Date.parse(str(b.created_at)) - Date.parse(str(a.created_at)));
  const latestByWorkflow = new Map<string, Raw>();
  for (const run of completed) {
    if (!latestByWorkflow.has(str(run.name))) latestByWorkflow.set(str(run.name), run);
  }
  const mainCiFailures = completed
    .filter((run) => run.conclusion === 'failure')
    .map((run) => ({
      name: str(run.name),
      url: str(run.html_url),
      title: str(run.display_title),
      sha: str(run.head_sha).slice(0, 7),
      createdAt: str(run.created_at),
      stillFailing: latestByWorkflow.get(str(run.name)) === run,
    }));

  const decisionsFile = (await api(`${base}/contents/backlog/decisions.md?ref=main`)) as Raw;
  const openDecisions = parseOpenDecisions(
    Buffer.from(str(decisionsFile.content), 'base64').toString('utf8'),
  );

  const changedLines = merged.reduce((sum, pr) => sum + pr.additions + pr.deletions, 0);
  const score = merged.length + Math.floor(changedLines / LINES_PER_POINT);

  return {
    repo,
    since,
    sinceSource: options.sinceSource,
    until,
    lastBrief: options.lastBrief ?? null,
    change: { mergedPrs: merged.length, changedLines, score, threshold, due: score >= threshold },
    merged,
    escalations: {
      limit: ESCALATION_LIMIT,
      waiting,
      queued,
      overLimit: waiting.length > ESCALATION_LIMIT,
    },
    inProgress,
    escapes,
    ledger,
    newBacklogIssues,
    mainCiFailures,
    openDecisions,
  };
}

// ---- CLI -------------------------------------------------------------------------------

/** Where the last brief's time is kept: the git common dir, shared by all worktrees. */
export function stateFile(cwd = process.cwd()): string {
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8' });
  return join(resolve(cwd, common.trim()), 'docent', 'last-brief.json');
}

export function readLastBrief(path: string): LastBrief | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as LastBrief;
    return typeof value.at === 'string' && !Number.isNaN(Date.parse(value.at)) ? value : null;
  } catch {
    return null;
  }
}

const run = promisify(execFile);

/** The gh arguments for one read: a bare GET, no method, fields or input. */
export function ghArgs(path: string): string[] {
  if (path.startsWith('-')) throw new Error(`not an API path: ${path}`);
  return ['api', path];
}

/** Real GitHub reads. Through the builder app unless `plainGh`. */
function githubApi(plainGh: boolean): Api {
  const runner = join(import.meta.dirname, 'as-agent.ts');
  return async (path) => {
    const [cmd, args] = plainGh
      ? ['gh', ghArgs(path)]
      : [process.execPath, [runner, 'builder', '--', 'gh', ...ghArgs(path)]];
    const { stdout } = await run(cmd, args, { maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(stdout);
  };
}

function isoArg(name: string, value: string | undefined): string {
  if (!value || Number.isNaN(Date.parse(value))) throw new Error(`${name} needs an ISO time`);
  return new Date(value).toISOString();
}

async function main(argv: string[]): Promise<void> {
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i < 0 ? undefined : (argv[i + 1] ?? '');
  };
  const path = stateFile();

  const mark = flag('--mark');
  if (mark !== undefined) {
    const url = flag('--url');
    const record: LastBrief = { at: isoArg('--mark', mark), ...(url ? { url } : {}) };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    process.stderr.write(`Recorded the last brief in ${path}\n`);
    return;
  }

  const lastBrief = readLastBrief(path);
  const sinceFlag = flag('--since');
  const until = new Date().toISOString();
  const [since, sinceSource]: [string, BriefData['sinceSource']] =
    sinceFlag !== undefined
      ? [isoArg('--since', sinceFlag), 'flag']
      : lastBrief
        ? [lastBrief.at, 'last-brief']
        : [new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 86_400_000).toISOString(), 'default'];
  const threshold = flag('--threshold');

  let api = githubApi(argv.includes('--plain-gh'));
  const recordDir = flag('--record');
  if (recordDir) api = recording(api, recordDir);

  const data = await gather(api, {
    since,
    sinceSource,
    until,
    lastBrief,
    ...(threshold ? { threshold: Number(threshold) } : {}),
  });
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

/** Fields the gatherer reads. Recording keeps only these, so fixtures stay small. */
const KEPT = new Set([
  'number',
  'html_url',
  'title',
  'body',
  'user',
  'login',
  'labels',
  'name',
  'draft',
  'created_at',
  'updated_at',
  'merged_at',
  'auto_merge',
  'additions',
  'deletions',
  'pull_request',
  'workflow_runs',
  'display_title',
  'head_sha',
  'content',
  'conclusion',
]);

function trim(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(trim);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => KEPT.has(k))
      .map(([k, v]) => [k, trim(v)]),
  );
}

/** Wraps an Api so each response is saved, trimmed, as a fixture for tests. */
function recording(api: Api, dir: string): Api {
  mkdirSync(dir, { recursive: true });
  const index: Record<string, string> = {};
  return async (path) => {
    const value = trim(await api(path));
    const name = path.replace(/^repos\/[^/]+\/[^/]+\//, '').replace(/&?(per_page|page)=\d+/g, '');
    const file = `${name
      .replace(/[^\w]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60)}.json`;
    index[path] = file;
    writeFileSync(join(dir, file), `${JSON.stringify(value, null, 2)}\n`);
    writeFileSync(join(dir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
    return value;
  };
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`brief-data: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
