// The PR's files at its head commit, for the symbol index. Everything comes from git's objects at
// that one commit, by blob id: never the working tree, so edits on disk, later pushes and
// untracked files can't get in. Git runs offline here, so a missing object is skipped, not fetched.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { CommitSha } from '@docent/core';
import { hardenedGitArgs, hardenedGitEnv } from './github.ts';

const run = promisify(execFile);

/** A regular file at head, with its size in bytes. */
export type HeadFile = { path: string; bytes: number };

export type HeadFiles = {
  /** Every regular file at head, in git's order. Symlinks and submodules are left out. */
  entries: HeadFile[];
  /** The listing stopped at its cap, so some files are missing from `entries`. */
  truncated: boolean;
  /**
   * The text of the given files, in order, or null for one that's missing or binary. Stops when
   * the signal aborts.
   */
  read: (paths: readonly string[], signal: AbortSignal) => AsyncGenerator<HeadText>;
};
export type HeadText = { path: string; text: string | null };

/** The listing keeps at most this many files. */
export const MAX_LISTED_FILES = 200_000;

export async function gitHeadFiles(
  dir: string,
  head: CommitSha,
  maxEntries = MAX_LISTED_FILES,
): Promise<HeadFiles> {
  let stdout: string;
  let truncated = false;
  try {
    ({ stdout } = await run(
      'git',
      hardenedGitArgs(dir, [
        '-c',
        'core.precomposeunicode=false',
        'ls-tree',
        '-r',
        '-z',
        '--long',
        '--full-tree',
        head,
      ]),
      { maxBuffer: 64 * 1024 * 1024, env: hardenedGitEnv({ offline: true }) },
    ));
  } catch (error) {
    // A listing too big to buffer is cut short: what arrived is kept.
    const failure = error as { code?: unknown; stdout?: unknown };
    if (failure.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || typeof failure.stdout !== 'string')
      throw error;
    stdout = failure.stdout.slice(0, failure.stdout.lastIndexOf('\0') + 1);
    truncated = true;
  }
  const entries: HeadFile[] = [];
  const blobs = new Map<string, string>();
  for (const record of stdout.split('\0')) {
    // `<mode> <type> <oid> <size>\t<path>`, sizes padded with spaces.
    const match = /^(100644|100755) blob ([0-9a-f]{40,64}) +(\d+)\t(.+)$/s.exec(record);
    if (!match) continue;
    const [, , oid = '', size = '', path = ''] = match;
    if (entries.length === maxEntries) {
      truncated = true;
      break;
    }
    entries.push({ path, bytes: Number(size) });
    blobs.set(path, oid);
  }
  return {
    entries,
    truncated,
    read: (paths, signal) =>
      readBlobs(
        dir,
        paths.flatMap((path) => {
          const oid = blobs.get(path);
          return oid ? [{ path, oid }] : [];
        }),
        signal,
      ),
  };
}

/** Streams blobs through one `git cat-file --batch`, parsing its `<oid> <type> <size>` headers. */
async function* readBlobs(
  dir: string,
  wanted: readonly { path: string; oid: string }[],
  signal: AbortSignal,
): AsyncGenerator<HeadText> {
  if (wanted.length === 0 || signal.aborted) return;
  const child = spawn('git', hardenedGitArgs(dir, ['cat-file', '--batch']), {
    env: hardenedGitEnv({ offline: true }),
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const stop = () => child.kill();
  signal.addEventListener('abort', stop);
  child.stdin.on('error', () => {}); // The child may be stopped before it reads everything.
  child.stdin.end(`${wanted.map((w) => w.oid).join('\n')}\n`);
  let buffer: Buffer = Buffer.alloc(0);
  let next = 0;
  try {
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      while (next < wanted.length) {
        const newline = buffer.indexOf(10);
        if (newline === -1) break;
        const header = buffer.subarray(0, newline).toString('latin1');
        const path = wanted[next]?.path ?? '';
        const found = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
        if (!found) {
          // `<oid> missing`: not in this clone, and git may not fetch it.
          buffer = buffer.subarray(newline + 1);
          next++;
          yield { path, text: null };
          continue;
        }
        const size = Number(found[2]);
        if (buffer.length < newline + 1 + size + 1) break;
        const content = buffer.subarray(newline + 1, newline + 1 + size);
        buffer = buffer.subarray(newline + 2 + size);
        next++;
        const text = found[1] === 'blob' && !content.includes(0) ? content.toString('utf8') : null;
        yield { path, text };
      }
      if (next === wanted.length || signal.aborted) break;
    }
  } finally {
    signal.removeEventListener('abort', stop);
    child.kill();
  }
}
