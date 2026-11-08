// Finds the PR author's Claude Code session on this machine, so a question can fork it and get an
// answer that knows why the change was built the way it was.
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { type SessionId, sessionId } from '@docent/core';

/** The author's session, or why questions go to the guide instead. */
export type AuthorSession =
  | {
      found: true;
      id: SessionId;
      /** Where the author worked, if known. The fork reads a checkout somewhere else. */
      cwd: string | null;
      /** How it was found, for the UI: "the --session flag", say. */
      via: string;
    }
  | { found: false; reason: string };

/** What the PR says about its author session: the description and the commit messages. */
export type Handoff = { body: string; commitMessages: readonly string[] };

export type SessionLocator = (handoff: Handoff) => Promise<AuthorSession>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Claude Code's links to a session, as its attribution lines put them in commits and PR bodies:
 * `Claude-Session: https://claude.ai/code/session_…`.
 */
const SESSION_LINK = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/g;

/**
 * Finds the author session among this machine's Claude Code transcripts.
 * - An explicit id (`docent review --session <id>`) wins. It must exist on this machine.
 * - Otherwise, a session link in the PR body or commits. The link names the session on
 *   claude.ai, not on disk, but the local transcript records it when the session was started
 *   with remote control on. So the transcript that recorded it is the author's.
 */
export function localSessions(
  options: { explicit?: string; projectsDir?: string } = {},
): SessionLocator {
  const projectsDir = options.projectsDir ?? join(homedir(), '.claude', 'projects');
  return async (handoff) => {
    if (options.explicit !== undefined) {
      const id = options.explicit;
      if (!UUID.test(id)) return { found: false, reason: `${id} is not a Claude Code session id` };
      const info = await getSessionInfo(id).catch(() => undefined);
      if (!info) return { found: false, reason: `Session ${id} isn't on this machine` };
      return { found: true, id: sessionId(id), cwd: info.cwd ?? null, via: 'the --session flag' };
    }

    const links = new Set(
      [handoff.body, ...handoff.commitMessages].flatMap((text) => text.match(SESSION_LINK) ?? []),
    );
    if (links.size === 0) return { found: false, reason: 'The PR names no author session' };
    const found = await findLinkedTranscript(projectsDir, links);
    if (!found) return { found: false, reason: "The author's session isn't on this machine" };
    return { ...found, found: true, via: 'the session link in the PR' };
  };
}

/** A locator that always gives the same answer: for fixtures and tests. */
export const fixedSession =
  (session: AuthorSession): SessionLocator =>
  async () =>
    session;

/**
 * The transcript that recorded one of these links when remote control started. Only that record
 * counts: Docent's own tour sessions quote the PR body, link included, and must not match.
 * Oldest transcript first, because a fork copies its parent's records, including this one.
 */
async function findLinkedTranscript(
  projectsDir: string,
  links: ReadonlySet<string>,
): Promise<{ id: SessionId; cwd: string | null } | null> {
  const files: { path: string; born: number }[] = [];
  for (const project of await readdir(projectsDir).catch(() => [])) {
    const dir = join(projectsDir, project);
    for (const name of await readdir(dir).catch(() => [])) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(dir, name);
      const info = await stat(path).catch(() => null);
      if (info?.isFile()) files.push({ path, born: info.birthtimeMs || info.mtimeMs });
    }
  }
  files.sort((a, b) => a.born - b.born);

  for (const { path } of files) {
    const text = await readFile(path, 'utf8').catch(() => '');
    if (!text.includes('"bridge_status"')) continue;
    for (const line of text.split('\n')) {
      if (!line.includes('"bridge_status"')) continue;
      const entry = parse(line);
      if (
        entry?.type === 'system' &&
        entry.subtype === 'bridge_status' &&
        typeof entry.url === 'string' &&
        links.has(entry.url) &&
        typeof entry.sessionId === 'string' &&
        UUID.test(entry.sessionId)
      ) {
        return {
          id: sessionId(entry.sessionId),
          cwd: typeof entry.cwd === 'string' ? entry.cwd : null,
        };
      }
    }
  }
  return null;
}

function parse(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * One question at a time per author session. Forks of one session don't share state, but the
 * reviewer reads answers in order, and a queue keeps a burst of questions from forking a large
 * transcript many times at once. Shared across reviews in this process.
 */
const queues = new Map<SessionId, Promise<unknown>>();

export function oneAtATime<T>(id: SessionId, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(id) ?? Promise.resolve();
  const next = previous.then(work);
  const settled = next.catch(() => undefined);
  queues.set(id, settled);
  void settled.then(() => {
    if (queues.get(id) === settled) queues.delete(id);
  });
  return next;
}
