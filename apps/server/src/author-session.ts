// Finds the PR author's Claude Code session on this machine, so a question can fork it and get an
// answer that knows why the change was built the way it was.
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream, existsSync, rmSync } from 'node:fs';
import { mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { finished } from 'node:stream/promises';
import { type SessionId, sessionId } from '@docent/core';
import { git } from './github.ts';

/** The author's session, or why questions go to the guide instead. */
export type AuthorSession =
  | {
      found: true;
      id: SessionId;
      /** Where the author worked, if known. The fork reads a checkout somewhere else. */
      cwd: string | null;
      /** How it was found, for the UI: "the --session flag", say. */
      via: string;
      /** The session's context size at its last turn, which a fork pays to cache. */
      contextTokens: number | null;
      /**
       * A transcript file to fork instead of the session id: a private copy of a subagent's
       * transcript, converted so it forks like a top-level session. The original is never touched.
       */
      transcript?: string;
    }
  | { found: false; reason: string };

/** What the PR says about itself: enough to find its author session and tie it to the PR. */
export type Handoff = {
  repo: string;
  headRef: string;
  /** The head branch lives in the PR's own repo, so only someone with write access pushed it. */
  headInBaseRepo: boolean;
  body: string;
  /** Oldest first, as GitHub lists them. */
  commitMessages: readonly string[];
  /** The PR's commits' full SHAs, oldest first, like `commitMessages`. */
  commitShas: readonly string[];
};

export type SessionLocator = (handoff: Handoff) => Promise<AuthorSession>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Claude Code's links to a session, as its attribution lines put them in commits and PR bodies:
 * `Claude-Session: https://claude.ai/code/session_…`.
 */
const SESSION_LINK = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/g;

/** Transcripts bigger than this are skipped, with a warning, rather than read. */
const MAX_TRANSCRIPT_BYTES = 1024 ** 3;

const NO_MATCH = "The linked session doesn't match this PR";

/**
 * Finds the author session among this machine's Claude Code transcripts.
 * - An explicit id (`docent review --session <id>`) wins. It must exist on this machine. The
 *   reviewer chose it, so it isn't checked against the PR.
 * - Otherwise, a session link in the PR. Links are public, so anyone can paste one into a PR,
 *   and a link alone never picks a session. The link names the session on claude.ai, and the
 *   local transcript records it when remote control starts. That transcript is the author's
 *   only if it is also tied to this PR (see `matchesPr`), or if one of its own subagents is,
 *   with proof that the subagent did the PR's work (see `fromRecords`, which needs the records
 *   Docent's Claude Code hook writes). A proven subagent answers in place of its session: it
 *   wrote the code. Links are tried in order: the PR body's first, then the commits', newest
 *   first.
 */
export function localSessions(
  options: {
    explicit?: string;
    projectsDir?: string;
    /** Docent's data folder, where the hook writes its records. */
    dataDir?: string;
    /** The `owner/repo` a local checkout belongs to. Tests replace the git lookup. */
    repoOf?: (dir: string) => Promise<string | null>;
  } = {},
): SessionLocator {
  const projectsDir = options.projectsDir ?? join(homedir(), '.claude', 'projects');
  const dataDir = options.dataDir ?? defaultDataDir();
  const repoOf = options.repoOf ?? originRepo;
  return async (handoff) => {
    const transcripts = await listTranscripts(projectsDir);

    if (options.explicit !== undefined) {
      const id = options.explicit;
      if (!UUID.test(id)) return { found: false, reason: `${id} is not a Claude Code session id` };
      const path = transcripts.find((t) => t.name === `${id}.jsonl`)?.path;
      if (!path) return { found: false, reason: `Session ${id} isn't on this machine` };
      const summary = await summarize(path);
      return {
        found: true,
        id: sessionId(id),
        cwd: summary.lastCwd,
        via: 'the --session flag',
        contextTokens: summary.contextTokens,
      };
    }

    // Records only look inside a session the PR's link names. They never pick a session on
    // their own.
    return fromLinks(handoff, transcripts, repoOf, (within) =>
      fromRecords(handoff, { projectsDir, dataDir, repoOf, within }),
    );
  };
}

/**
 * The session a link in the PR names, tied to the PR as `localSessions` describes. Links are
 * tried in order: the PR body's first, then the commits', newest first.
 */
async function fromLinks(
  handoff: Handoff,
  transcripts: readonly Transcript[],
  repoOf: (dir: string) => Promise<string | null>,
  /** The linked session's subagent that wrote the PR, proven, or null. */
  subagentOf: (session: SessionId) => Promise<AuthorSession | null>,
): Promise<AuthorSession> {
  const links = [
    ...(handoff.body.match(SESSION_LINK) ?? []),
    ...[...handoff.commitMessages].reverse().flatMap((text) => text.match(SESSION_LINK) ?? []),
  ].filter((link, i, all) => all.indexOf(link) === i);
  if (links.length === 0) return { found: false, reason: 'The PR names no author session' };
  // A PR from a fork could name any session, and nothing ties a fork's branch to this repo.
  if (!handoff.headInBaseRepo) return { found: false, reason: NO_MATCH };

  const candidates = await findLinked(transcripts, new Set(links));
  if (candidates.length === 0) {
    return { found: false, reason: "The author's session isn't on this machine" };
  }
  for (const link of links) {
    const forLink = candidates
      .filter((c) => c.link === link)
      .sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));
    for (const candidate of forLink) {
      const subagent = await subagentOf(candidate.id);
      if (subagent) return subagent;
      const summary = await summarize(candidate.path);
      if (!(await matchesPr(summary, handoff, repoOf))) continue;
      return {
        found: true,
        id: candidate.id,
        cwd: candidate.cwd,
        via: 'the session link in the PR',
        contextTokens: summary.contextTokens,
      };
    }
  }
  return { found: false, reason: NO_MATCH };
}

/**
 * Docent's data folder, where the Claude Code hook writes its records. The hook
 * (packages/claude-code/hooks/record-session.mjs) computes the same path; keep the two in step.
 */
export function defaultDataDir(): string {
  if (process.env.DOCENT_DATA_DIR) return process.env.DOCENT_DATA_DIR;
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'docent');
  }
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'docent');
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'docent');
}

/** What the hook records when a session or subagent starts. */
type SessionRecord = {
  sessionId: string;
  /** Null for a top-level session. */
  agentId: string | null;
  /** `owner/repo`, from the origin URL the hook read. */
  repo: string;
  transcriptPath: string;
};

const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** At most this many records are read, newest files first. */
const MAX_RECORDS = 2000;
const MAX_RECORD_BYTES = 16 * 1024;

/**
 * Narrows the linked author session down to the subagent of it that wrote the code, through the
 * hook's records. Subagents usually write the code, and no link names them.
 *
 * Only subagents of `within`, the session the PR's link names (its own `bridge_status` record),
 * are considered, so a record can never bring in a different session. A record only says where to
 * look: anything that can write Docent's data folder can write one. Each subagent is proved from
 * Claude Code's own transcript:
 * - The transcript is under the projects folder, at the path Claude Code uses for that subagent
 *   id, and its own records carry those ids.
 * - One of those records shows it on the PR's head branch, in a checkout whose origin is the
 *   PR's repo (`matchesPr`, as for the linked session).
 * - It did work in the PR: one of its own `git commit` or `git push` commands printed one of the
 *   PR's commits (see `addCommitted`).
 *
 * Among the proven subagents, the one behind the newest PR commit wins; it wrote the code last.
 * Then evidence by SHA beats evidence by subject, then the later subagent. With no proven
 * subagent, the linked session stands.
 */
async function fromRecords(
  handoff: Handoff,
  options: {
    projectsDir: string;
    dataDir: string;
    repoOf: (dir: string) => Promise<string | null>;
    within: SessionId;
  },
): Promise<AuthorSession | null> {
  const records = (await readRecords(options.dataDir)).filter(
    (r) =>
      r.agentId !== null &&
      r.sessionId === options.within &&
      r.repo.toLowerCase() === handoff.repo.toLowerCase(),
  );
  if (records.length === 0 || handoff.commitShas.length === 0) return null;
  const projectsRoot = await realpath(options.projectsDir).catch(() => null);
  if (!projectsRoot) return null;

  let best: Ranked | null = null;
  // A transcript that never names the head branch can't pass `matchesPr`: skip it unparsed.
  const onBranch = `"gitBranch":${JSON.stringify(handoff.headRef)}`;
  for (const record of records) {
    const path = await transcriptFor(record, projectsRoot);
    if (!path || !(await mentions(path, onBranch))) continue;
    const summary = await summarize(path, (entry) => ownsEntry(entry, record));
    const found = evidence(summary.committed, handoff);
    if (!found) continue;
    if (!(await matchesPr(summary, handoff, options.repoOf))) continue;
    const candidate = { record, path, summary, ...found };
    if (!best || ranksAbove(candidate, best)) best = candidate;
  }
  if (!best) return null;

  const { record, path, summary } = best;
  const copy = await forkableCopy(path, record);
  return {
    found: true,
    id: sessionId(copy.id),
    cwd: summary.lastCwd,
    via: "the hook's record of the subagent that wrote the code",
    contextTokens: summary.contextTokens,
    transcript: copy.path,
  };
}

type Ranked = {
  record: SessionRecord;
  path: string;
  summary: Summary;
  /** The index of the newest PR commit it made or pushed. */
  newest: number;
  bySha: boolean;
};

function ranksAbove(a: Ranked, b: Ranked): boolean {
  if (a.newest !== b.newest) return a.newest > b.newest;
  if (a.bySha !== b.bySha) return a.bySha;
  return a.summary.firstSeen > b.summary.firstSeen;
}

/**
 * Commits a session made or pushed, as its own `git commit` and `git push` commands printed
 * them.
 */
type Committed = {
  /** From `git commit`: the branch it was on, the SHA (often abbreviated) and the subject. */
  commits: { branch: string; sha: string; subject: string }[];
  /** From `git push`: the SHA a ref was moved to, and the ref. */
  pushes: { sha: string; to: string }[];
  /** The session's Bash calls that ran `git commit` or `git push`, by tool-use id. */
  gitCalls: Map<string, { commit: boolean; push: boolean }>;
};

/**
 * The newest PR commit the session made or pushed, or null. A commit counts by SHA, from a
 * commit or from a push to the PR's head branch. Or it counts by subject, from a commit on the
 * head branch, for when a later rebase or amend changed the SHA.
 */
function evidence(
  committed: Committed,
  handoff: Handoff,
): { newest: number; bySha: boolean } | null {
  const shas = [
    ...committed.commits.map((c) => c.sha),
    ...committed.pushes.filter((p) => p.to === handoff.headRef).map((p) => p.sha),
  ];
  const subjects = new Set(
    committed.commits.filter((c) => c.branch === handoff.headRef).map((c) => c.subject),
  );
  for (let i = handoff.commitShas.length - 1; i >= 0; i--) {
    const full = handoff.commitShas[i]?.toLowerCase() ?? '';
    if (shas.some((sha) => full.startsWith(sha))) return { newest: i, bySha: true };
    const subject = handoff.commitMessages[i]?.split('\n')[0]?.trim();
    if (subject && subjects.has(subject)) return { newest: i, bySha: false };
  }
  return null;
}

/**
 * A commit's summary line, at the start of a line as `git commit` prints it:
 * `[branch abc1234] Subject`, `[branch (root-commit) abc1234] Subject` or
 * `[detached HEAD abc1234] Subject`. `git log` indents message text, so a commit message quoting
 * this shape doesn't match.
 */
const COMMIT_LINE = /^\[(detached HEAD|[^\]\s]+) (?:\([a-z-]+\) )?([0-9a-f]{7,40})\] ([^\n]+)/gm;
/**
 * A push's ref update, after its `To <remote>` line, exactly as git prints it: a space, the flag
 * (a space, or `+` when forced), a space, then `abc1234..def5678  branch -> branch` (or `...`
 * when forced). An indented line, as `git log` prints message text, doesn't match.
 */
const PUSH_START = /^To \S+$/m;
const PUSH_LINE = /^ [ +] [0-9a-f]{7,40}\.\.\.?([0-9a-f]{7,40}) +\S+ +-> +(\S+)/gm;
/** A shell command that runs `git commit` or `git push`, possibly wrapped (`… -- git push`). */
const GIT_COMMIT = /(?:^|[\s;&|(])git(?:\s+-{1,2}\S+(?:\s+[^\s-]\S*)?)*\s+commit\b/;
const GIT_PUSH = /(?:^|[\s;&|(])git(?:\s+-{1,2}\S+(?:\s+[^\s-]\S*)?)*\s+push\b/;
/** A push that writes nothing. */
const DRY_RUN = /\s(?:--dry-run|-n)\b/;

/**
 * Collects what the session's own `git commit` and `git push` commands printed. Only the
 * results of Bash calls that ran one count: text the session merely read (a file, `git log`, a
 * web page, a fetch) can quote the same shapes, and anyone can write that text.
 */
function addCommitted(entry: Record<string, unknown>, into: Committed): void {
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return;
  for (const block of content as {
    type?: unknown;
    id?: unknown;
    name?: unknown;
    input?: unknown;
    tool_use_id?: unknown;
    content?: unknown;
  }[]) {
    if (entry.type === 'assistant' && block?.type === 'tool_use' && block.name === 'Bash') {
      const command = (block.input as { command?: unknown } | undefined)?.command;
      if (typeof block.id !== 'string' || typeof command !== 'string') continue;
      const kind = {
        commit: GIT_COMMIT.test(command),
        push: GIT_PUSH.test(command) && !DRY_RUN.test(command),
      };
      if (kind.commit || kind.push) into.gitCalls.set(block.id, kind);
      continue;
    }
    if (entry.type !== 'user' || block?.type !== 'tool_result') continue;
    const call = typeof block.tool_use_id === 'string' && into.gitCalls.get(block.tool_use_id);
    if (!call) continue;
    const text =
      typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? (block.content as { text?: unknown }[])
              .map((part) => (typeof part?.text === 'string' ? part.text : ''))
              .join('\n')
          : '';
    if (call.commit) {
      for (const [, branch, sha, subject] of text.matchAll(COMMIT_LINE)) {
        if (branch && sha && subject) into.commits.push({ branch, sha, subject: subject.trim() });
      }
    }
    const push = call.push ? PUSH_START.exec(text) : null;
    if (push) {
      for (const [, sha, to] of text.slice(push.index).matchAll(PUSH_LINE)) {
        if (sha && to) into.pushes.push({ sha, to });
      }
    }
  }
}

/** Whether any line of a transcript contains `needle`, read without parsing. */
async function mentions(path: string, needle: string): Promise<boolean> {
  for await (const line of lines(path)) if (line.includes(needle)) return true;
  return false;
}

/** A transcript record that is the recorded session's own, not another session's or agent's. */
function ownsEntry(entry: Record<string, unknown>, record: SessionRecord): boolean {
  if (entry.sessionId !== record.sessionId) return false;
  return record.agentId === null
    ? entry.agentId === undefined && entry.isSidechain !== true
    : entry.agentId === record.agentId;
}

/**
 * The record's transcript, if it is where Claude Code keeps that session's or subagent's
 * transcript: `<projects>/<project>/<session>.jsonl`, or
 * `<projects>/<project>/<session>/subagents/agent-<id>.jsonl`. Links are resolved first, so a
 * record can't point outside the projects folder, or at another session's file.
 */
async function transcriptFor(record: SessionRecord, projectsRoot: string): Promise<string | null> {
  const path = await realpath(record.transcriptPath).catch(() => null);
  if (!path) return null;
  const parts = relative(projectsRoot, path).split(sep);
  const expected =
    record.agentId === null
      ? [`${record.sessionId}.jsonl`]
      : [record.sessionId, 'subagents', `agent-${record.agentId}.jsonl`];
  const [project, ...rest] = parts;
  if (!project || project === '..' || project.startsWith('.')) return null;
  if (rest.length !== expected.length || rest.some((part, i) => part !== expected[i])) return null;
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return null;
  if (info.size > MAX_TRANSCRIPT_BYTES) {
    console.warn(`Skipped a transcript too big to search (${info.size} bytes): ${path}`);
    return null;
  }
  return path;
}

/** The hook's records that are well formed and name a GitHub origin. Newest files first. */
async function readRecords(dataDir: string): Promise<SessionRecord[]> {
  const dir = join(dataDir, 'sessions');
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.json'));
  const dated = await Promise.all(
    names.map(async (name) => {
      const info = await stat(join(dir, name)).catch(() => null);
      return { name, info };
    }),
  );
  const files = dated
    // A record is a few hundred bytes; anything big or odd isn't one.
    .filter(({ info }) => info?.isFile() && info.size <= MAX_RECORD_BYTES)
    .sort((a, b) => (b.info?.mtimeMs ?? 0) - (a.info?.mtimeMs ?? 0));
  const records: SessionRecord[] = [];
  for (const { name } of files.slice(0, MAX_RECORDS)) {
    const value = parse(await readFile(join(dir, name), 'utf8').catch(() => ''));
    const record = value && toRecord(value);
    if (record) records.push(record);
  }
  return records;
}

function toRecord(value: Record<string, unknown>): SessionRecord | null {
  const { version, sessionId: id, agentId, origin, transcriptPath } = value;
  if (version !== 1) return null;
  if (typeof id !== 'string' || !UUID.test(id)) return null;
  if (agentId !== null && (typeof agentId !== 'string' || !AGENT_ID.test(agentId))) return null;
  if (typeof transcriptPath !== 'string' || typeof origin !== 'string') return null;
  const repo = githubRepo(origin);
  if (!repo) return null;
  return { sessionId: id, agentId, repo, transcriptPath };
}

/**
 * A copy of a subagent's transcript that forks like a top-level session: a fresh `sessionId` on
 * every record, `isSidechain` false and `agentId` dropped (docs/research/2026-11-11-session-
 * snapshots.md). Only the subagent's own records are kept. The copy is private to this user and
 * deleted when Docent exits; the original is only read.
 */
async function forkableCopy(
  path: string,
  record: SessionRecord,
): Promise<{ id: string; path: string }> {
  const dir = await copiesDir();
  const id = randomUUID();
  const copy = join(dir, `${id}.jsonl`);
  const out = createWriteStream(copy, { mode: 0o600 });
  for await (const line of lines(path)) {
    const entry = parse(line);
    if (!entry || !ownsEntry(entry, record)) continue;
    const { agentId: _dropped, ...rest } = entry;
    if (!out.write(`${JSON.stringify({ ...rest, sessionId: id, isSidechain: false })}\n`)) {
      await once(out, 'drain');
    }
  }
  out.end();
  await finished(out);
  return { id, path: copy };
}

let copies: Promise<string> | undefined;

/**
 * One private folder per Docent process for transcript copies, deleted when it exits. Folders a
 * crashed or killed Docent left behind are cleared on the way.
 */
function copiesDir(): Promise<string> {
  copies ??= removeStaleCopies().then(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docent-subagent-'));
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
    return dir;
  });
  return copies;
}

/**
 * Copies a crashed or killed Docent left behind. Older than a week, so a review still open
 * in another Docent keeps its copy.
 */
async function removeStaleCopies(): Promise<void> {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const name of await readdir(tmpdir()).catch(() => [] as string[])) {
    if (!name.startsWith('docent-subagent-')) continue;
    const dir = join(tmpdir(), name);
    const info = await stat(dir).catch(() => null);
    if (info?.isDirectory() && info.mtimeMs < weekAgo) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** A locator that always gives the same answer: for fixtures and tests. */
export const fixedSession =
  (session: AuthorSession): SessionLocator =>
  async () =>
    session;

/**
 * Ties a transcript to the PR: one of its records shows the session on the PR's head branch, in
 * a checkout of the PR's repo. Branch and checkout come from the same record, so a session that
 * was on a same-named branch in another project, and only visited this repo, doesn't match.
 * With the head branch in the PR's own repo, only someone who can push there could have made
 * that branch, so a link pasted into someone else's PR doesn't match either.
 */
async function matchesPr(
  summary: Summary,
  handoff: Handoff,
  repoOf: (dir: string) => Promise<string | null>,
): Promise<boolean> {
  const checkouts = summary.checkoutsByBranch.get(handoff.headRef) ?? new Set<string>();
  for (const cwd of [...checkouts].slice(0, 20)) {
    const repo = await repoOf(cwd).catch(() => null);
    if (repo?.toLowerCase() === handoff.repo.toLowerCase()) return true;
  }
  return false;
}

type Transcript = { name: string; path: string; size: number };

/** Top-level session transcripts. Subagent transcripts live in subfolders and are left out. */
async function listTranscripts(projectsDir: string): Promise<Transcript[]> {
  const found: Transcript[] = [];
  for (const project of await readdir(projectsDir).catch(() => [])) {
    const dir = join(projectsDir, project);
    for (const name of await readdir(dir).catch(() => [])) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(dir, name);
      const info = await stat(path).catch(() => null);
      if (info?.isFile()) found.push({ name, path, size: info.size });
    }
  }
  return found;
}

type Candidate = {
  link: string;
  path: string;
  id: SessionId;
  cwd: string | null;
  /** The transcript's first timestamp. A fork starts later than its parent. */
  firstSeen: string;
};

/**
 * Transcripts that recorded one of these links when remote control started. Only that record
 * counts: Docent's own tour sessions quote the PR body, link included, and must not match.
 */
async function findLinked(
  transcripts: readonly Transcript[],
  links: ReadonlySet<string>,
): Promise<Candidate[]> {
  const found: Candidate[] = [];
  for (const { path, size } of transcripts) {
    if (size > MAX_TRANSCRIPT_BYTES) {
      console.warn(`Skipped a transcript too big to search (${size} bytes): ${path}`);
      continue;
    }
    let firstSeen = '';
    const matches: Omit<Candidate, 'firstSeen'>[] = [];
    for await (const line of lines(path)) {
      if (!firstSeen) firstSeen = /"timestamp":"([^"]+)"/.exec(line)?.[1] ?? '';
      if (!line.includes('"bridge_status"')) continue;
      const entry = parse(line);
      if (
        entry?.type === 'system' &&
        entry.subtype === 'bridge_status' &&
        typeof entry.url === 'string' &&
        links.has(entry.url) &&
        // The record must be this transcript's own, so the session checked is the one forked.
        entry.sessionId === basename(path, '.jsonl') &&
        UUID.test(entry.sessionId)
      ) {
        matches.push({
          link: entry.url,
          path,
          id: sessionId(entry.sessionId),
          cwd: typeof entry.cwd === 'string' ? entry.cwd : null,
        });
      }
    }
    for (const match of matches) found.push({ ...match, firstSeen });
  }
  return found;
}

type Summary = {
  /** Each branch the session was on, and the checkouts it was on it in, record by record. */
  checkoutsByBranch: Map<string, Set<string>>;
  lastCwd: string | null;
  contextTokens: number | null;
  /** What the session's own commits and pushes printed. */
  committed: Committed;
  /** The first record's timestamp. A fork starts later than its original. */
  firstSeen: string;
};

/**
 * What a transcript says about where it worked, what it committed, and how big its context got.
 * `owns` picks the records that are the session's own; by default, all of them.
 */
async function summarize(
  path: string,
  owns: (entry: Record<string, unknown>) => boolean = () => true,
): Promise<Summary> {
  const summary: Summary = {
    checkoutsByBranch: new Map(),
    lastCwd: null,
    contextTokens: null,
    committed: { commits: [], pushes: [], gitCalls: new Map() },
    firstSeen: '',
  };
  for await (const line of lines(path)) {
    const entry = parse(line);
    if (!entry || !owns(entry)) continue;
    if (!summary.firstSeen && typeof entry.timestamp === 'string') {
      summary.firstSeen = entry.timestamp;
    }
    addCommitted(entry, summary.committed);
    if (typeof entry.cwd === 'string') {
      summary.lastCwd = entry.cwd;
      if (typeof entry.gitBranch === 'string') {
        const checkouts = summary.checkoutsByBranch.get(entry.gitBranch) ?? new Set<string>();
        checkouts.add(entry.cwd);
        summary.checkoutsByBranch.set(entry.gitBranch, checkouts);
      }
    }
    const usage = (entry.message as { usage?: Record<string, unknown> } | undefined)?.usage;
    if (entry.type === 'assistant' && usage) {
      const n = (key: string) => (typeof usage[key] === 'number' ? (usage[key] as number) : 0);
      summary.contextTokens =
        n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens');
    }
  }
  return summary;
}

async function* lines(path: string): AsyncGenerator<string> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  try {
    yield* createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  } catch {
    // Unreadable transcripts are skipped, like missing ones.
  } finally {
    stream.destroy();
  }
}

function parse(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The GitHub `owner/repo` of a local checkout's origin, or null. */
async function originRepo(dir: string): Promise<string | null> {
  if (!existsSync(dir)) return null;
  const { stdout } = await git(dir, ['remote', 'get-url', 'origin']);
  return githubRepo(stdout.trim());
}

/** The `owner/repo` a GitHub remote URL names, or null. */
function githubRepo(url: string): string | null {
  const match = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** The author's session is busy: too many questions are already waiting for it. */
export class Busy extends Error {}

/** How many questions may wait for one session, besides the one being answered. */
export const MAX_WAITING = 3;

const queues = new Map<SessionId, { tail: Promise<unknown>; waiting: number }>();

/**
 * One question at a time per author session. Forks of one session don't share state, but the
 * reviewer reads answers in order, and a queue keeps a burst of questions from forking a large
 * transcript many times at once. A full queue refuses, and a question whose reviewer has gone
 * is dropped before it forks. Shared across reviews in this process.
 */
export function oneAtATime<T>(
  id: SessionId,
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const queue = queues.get(id) ?? { tail: Promise.resolve(), waiting: 0 };
  if (queue.waiting >= MAX_WAITING) {
    return Promise.reject(
      new Busy(
        `${MAX_WAITING} questions are already waiting for the author's session. Ask again once one is answered.`,
      ),
    );
  }
  queue.waiting++;
  queues.set(id, queue);
  const next = queue.tail.then(() => {
    queue.waiting--;
    signal?.throwIfAborted();
    return work();
  });
  const settled = next.catch(() => undefined);
  queue.tail = settled;
  void settled.then(() => {
    if (queue.tail === settled) queues.delete(id);
  });
  return next;
}
