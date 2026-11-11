// Finds the PR author's Claude Code session on this machine, so a question can fork it and get an
// answer that knows why the change was built the way it was.
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream, existsSync, rmSync } from 'node:fs';
import { mkdtemp, readdir, readFile, realpath, stat } from 'node:fs/promises';
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
 * - Then the records Docent's Claude Code hook writes (packages/claude-code). They can name the
 *   subagent that wrote the code, which a link can't. See `fromRecords`.
 * - Otherwise, a session link in the PR. Links are public, so anyone can paste one into a PR,
 *   and a link alone never picks a session. The link names the session on claude.ai, and the
 *   local transcript records it when remote control starts. That transcript is the author's
 *   only if it is also tied to this PR (see `matchesPr`). Links are tried in order: the PR
 *   body's first, then the commits', newest first.
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

    // Records are only consulted when the head branch is in the PR's own repo, as links are.
    if (handoff.headInBaseRepo) {
      const recorded = await fromRecords(handoff, { projectsDir, dataDir, repoOf });
      if (recorded) return recorded;
    }

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
  };
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

/**
 * Finds the author session through the hook's records.
 *
 * A record only says where to look: anything that can write to Docent's data folder can write
 * one, so nothing in it is trusted. Each candidate is proved from Claude Code's own transcript,
 * the same way a linked session is:
 * - The transcript is under the projects folder, at the path Claude Code uses for that session
 *   or subagent id, and its own records carry those ids.
 * - One of those records shows it on the PR's head branch, in a checkout whose origin is the
 *   PR's repo (`matchesPr`).
 * - It did work in the PR: one of its own tool results shows a commit or push of one of the PR's
 *   commits. That's what a link alone never shows, so this route needs no link.
 *
 * Among the proven ones, the session that committed or pushed the newest PR commit wins: it
 * wrote the code last and knows it best. A tie goes to a subagent, which wrote the code, over
 * the coordinator that only delegated it, then to the latest active.
 */
async function fromRecords(
  handoff: Handoff,
  options: {
    projectsDir: string;
    dataDir: string;
    repoOf: (dir: string) => Promise<string | null>;
  },
): Promise<AuthorSession | null> {
  const records = (await readRecords(options.dataDir)).filter(
    (r) => r.repo.toLowerCase() === handoff.repo.toLowerCase(),
  );
  if (records.length === 0 || handoff.commitShas.length === 0) return null;
  const projectsRoot = await realpath(options.projectsDir).catch(() => null);
  if (!projectsRoot) return null;

  let best: { record: SessionRecord; path: string; summary: Summary; newest: number } | null = null;
  for (const record of records) {
    const path = await transcriptFor(record, projectsRoot);
    if (!path) continue;
    const summary = await summarize(path, (entry) => ownsEntry(entry, record));
    const newest = newestCommit(summary.committed, handoff.commitShas);
    if (newest < 0) continue;
    if (!(await matchesPr(summary, handoff, options.repoOf))) continue;
    const candidate = { record, path, summary, newest };
    if (!best || ranksAbove(candidate, best)) best = candidate;
  }
  if (!best) return null;

  const { record, path, summary } = best;
  if (record.agentId === null) {
    return {
      found: true,
      id: sessionId(record.sessionId),
      cwd: summary.lastCwd,
      via: "the hook's record of the session that worked on this branch",
      contextTokens: summary.contextTokens,
    };
  }
  const copy = await forkableCopy(path, record);
  return {
    found: true,
    id: sessionId(copy.id),
    cwd: summary.lastCwd,
    via: "the hook's record of the subagent that worked on this branch",
    contextTokens: summary.contextTokens,
    transcript: copy.path,
  };
}

type Ranked = { record: SessionRecord; summary: Summary; newest: number };

function ranksAbove(a: Ranked, b: Ranked): boolean {
  if (a.newest !== b.newest) return a.newest > b.newest;
  const aSub = a.record.agentId !== null;
  const bSub = b.record.agentId !== null;
  if (aSub !== bSub) return aSub;
  return a.summary.lastSeen > b.summary.lastSeen;
}

/** The index of the newest PR commit among `committed` (abbreviated SHAs), or -1. */
function newestCommit(committed: ReadonlySet<string>, commitShas: readonly string[]): number {
  for (let i = commitShas.length - 1; i >= 0; i--) {
    const full = commitShas[i]?.toLowerCase() ?? '';
    for (const sha of committed) if (full.startsWith(sha)) return i;
  }
  return -1;
}

/** A commit's summary line: `[branch abc1234] Subject`, or `[branch (root-commit) abc1234]`. */
const COMMIT_LINE = /\[[^\]\s]+ (?:\([a-z-]+\) )?([0-9a-f]{7,40})\]/g;
/** A push's ref update: `   abc1234..def5678  branch -> branch`, or `...` when forced. */
const PUSH_LINE = /\b[0-9a-f]{7,40}\.\.\.?([0-9a-f]{7,40})\s+\S+\s+->\s+\S+/g;

/** SHAs the session's own commands printed when they committed or pushed, from tool results. */
function committedShas(entry: Record<string, unknown>): string[] {
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  const found: string[] = [];
  for (const block of content as { type?: unknown; content?: unknown }[]) {
    if (block?.type !== 'tool_result') continue;
    const text =
      typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? (block.content as { text?: unknown }[])
              .map((part) => (typeof part?.text === 'string' ? part.text : ''))
              .join('\n')
          : '';
    for (const pattern of [COMMIT_LINE, PUSH_LINE]) {
      for (const match of text.matchAll(pattern)) if (match[1]) found.push(match[1]);
    }
  }
  return found;
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
    names.map(async (name) => ({
      name,
      mtime: (await stat(join(dir, name)).catch(() => null))?.mtimeMs ?? 0,
    })),
  );
  dated.sort((a, b) => b.mtime - a.mtime);
  const records: SessionRecord[] = [];
  for (const { name } of dated.slice(0, MAX_RECORDS)) {
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
  const dir = await mkdtemp(join(tmpdir(), 'docent-subagent-'));
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
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
  /** Commit SHAs (often abbreviated) that the session's own commits and pushes printed. */
  committed: Set<string>;
  /** The last record's timestamp. */
  lastSeen: string;
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
    committed: new Set(),
    lastSeen: '',
  };
  for await (const line of lines(path)) {
    const entry = parse(line);
    if (!entry || !owns(entry)) continue;
    if (typeof entry.timestamp === 'string') summary.lastSeen = entry.timestamp;
    if (entry.type === 'user') {
      for (const sha of committedShas(entry)) summary.committed.add(sha);
    }
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
