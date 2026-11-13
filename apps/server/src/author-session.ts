// Finds the PR author's Claude Code session on this machine, so a question can fork it and get an
// answer that knows why the change was built the way it was.
import { createReadStream, existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { type SessionId, sessionId } from '@docent/core';
import { claudeProjectsDir } from './agent.ts';
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
 *   only if it is also tied to this PR (see `matchesPr`). Links are tried in order: the PR
 *   body's first, then the commits', newest first.
 */
export function localSessions(
  options: {
    explicit?: string;
    projectsDir?: string;
    /** The `owner/repo` a local checkout belongs to. Tests replace the git lookup. */
    repoOf?: (dir: string) => Promise<string | null>;
  } = {},
): SessionLocator {
  const projectsDir = options.projectsDir ?? claudeProjectsDir();
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
};

/** What a transcript says about where it worked, and how big its context got. */
async function summarize(path: string): Promise<Summary> {
  const summary: Summary = { checkoutsByBranch: new Map(), lastCwd: null, contextTokens: null };
  for await (const line of lines(path)) {
    const entry = parse(line);
    if (!entry) continue;
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
  const match = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(stdout.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * A question's place in line, taken the moment its request arrives. Setup that comes before the
 * question can join its session's queue (auth, reading the body and the stop's code, finding the
 * session) takes a different time for each question, so without a place a later question could
 * overtake an earlier one. `ready` settles once every question ahead of this one has joined its
 * queue or given up its place. Call `leave()` once this question has joined, or won't: after that
 * the next one may go. Leaving twice is harmless.
 */
export type Place = { ready: Promise<void>; leave(): void };

/** Hands out places in arrival order. */
export class Arrivals {
  #last: Promise<void> = Promise.resolve();

  take(): Place {
    const ready = this.#last;
    let leave = () => {};
    const left = new Promise<void>((resolve) => {
      leave = resolve;
    });
    // The next place waits for this one and everything ahead of it, so leaving early never lets
    // the next question overtake one further up.
    this.#last = Promise.all([ready, left]).then(() => undefined);
    return { ready, leave };
  }
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
