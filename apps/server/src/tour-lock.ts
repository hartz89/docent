// One tour, paid for once, across processes. A `--prepare` warm-up and a reviewer's own
// `docent review` of the same PR used to both write the tour and both pay (issue #65). Now the
// first takes a lock file beside the cache file and writes; any other waits, then reads its result.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/** Who holds a lock: what's written in the lock file. */
export type LockHolder = { pid: number; host: string; startedAt: number; token: string };

/** The holder touches its lock this often, so a waiter can tell it's still alive. */
const HEARTBEAT_MS = 5_000;
/** A lock untouched for this long is stale: its holder hung, or died on another machine. */
const STALE_MS = 30_000;
const POLL_MS = 500;
/** The longest a waiter waits on a live holder before writing the tour itself: a few tours' time. */
const MAX_WAIT_MS = 5 * 60_000;

/**
 * The value cached in `file`, or `write`'s, run here only if no other process is writing it.
 * While another process holds the lock, `onWait` is called on every poll with who holds it (null
 * for a lock file still being filled in). If that process stops without writing the file, this
 * one takes the lock and writes it. So it does, without the lock, after `MAX_WAIT_MS` on a holder
 * that's alive but not finishing. `cached` is true when this process didn't run `write`.
 *
 * A stale lock is broken: its holder's process is gone (same machine), or it has gone
 * `STALE_MS` without a heartbeat. Two waiters breaking the same stale lock at once could both
 * write; the holder's token is checked again just before the break to keep that window small.
 *
 * `signal` stops a wait at once. A write it stops is `write`'s to end; when `write` throws, the
 * lock is released before this rejects, so a waiting process takes over.
 */
export async function cachedOnce<T>(
  file: string,
  write: () => Promise<T>,
  onWait: (holder: LockHolder | null) => void,
  signal?: AbortSignal,
): Promise<{ value: T; cached: boolean }> {
  const lockFile = `${file}.lock`;
  await mkdir(dirname(file), { recursive: true });
  const writeAndStore = async () => {
    const value = await write();
    // Written aside, then renamed in, so a waiter never reads half a file.
    const partial = `${file}.${process.pid}.partial`;
    try {
      await writeFile(partial, JSON.stringify(value, null, 2));
      await rename(partial, file);
    } catch (error) {
      await unlink(partial).catch(() => {});
      throw error;
    }
    return { value, cached: false };
  };
  let waitingSince: number | null = null;
  for (;;) {
    signal?.throwIfAborted();
    if (existsSync(file)) return { value: await readJson<T>(file), cached: true };
    const release = await tryLock(lockFile);
    if (release) {
      try {
        // The last holder may have finished between the check above and taking the lock.
        if (existsSync(file)) return { value: await readJson<T>(file), cached: true };
        return await writeAndStore();
      } finally {
        await release();
      }
    }
    const lock = await readLock(lockFile);
    if (!lock) continue; // Released just now: look again.
    if (isStale(lock)) {
      await breakLock(lockFile, lock.holder);
      continue;
    }
    // A holder that's alive but stuck must not hold this review hostage: write it here instead.
    waitingSince ??= Date.now();
    if (Date.now() - waitingSince > MAX_WAIT_MS) return writeAndStore();
    onWait(lock.holder);
    await sleep(POLL_MS, undefined, signal ? { signal } : {});
  }
}

/** Takes the lock if it's free, and starts its heartbeat. Returns how to release it. */
async function tryLock(lockFile: string): Promise<(() => Promise<void>) | null> {
  const holder: LockHolder = {
    pid: process.pid,
    host: hostname(),
    startedAt: Date.now(),
    token: randomUUID(),
  };
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(lockFile, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify(holder));
  } finally {
    await handle.close();
  }
  const heartbeat = setInterval(() => {
    const now = new Date();
    utimes(lockFile, now, now).catch(() => {});
  }, HEARTBEAT_MS);
  heartbeat.unref();
  return async () => {
    clearInterval(heartbeat);
    // Only our own lock: if it was broken as stale, it may be someone else's by now.
    const current = await readLock(lockFile);
    if (current?.holder?.token === holder.token) await unlink(lockFile).catch(() => {});
  };
}

type Lock = { holder: LockHolder | null; ageMs: number };

/** The lock file, or null if there's none. `holder` is null while its holder is filling it in. */
async function readLock(lockFile: string): Promise<Lock | null> {
  try {
    const [text, info] = await Promise.all([readFile(lockFile, 'utf8'), stat(lockFile)]);
    let holder: LockHolder | null = null;
    try {
      holder = JSON.parse(text) as LockHolder;
    } catch {}
    return { holder, ageMs: Date.now() - info.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function isStale({ holder, ageMs }: Lock): boolean {
  if (ageMs > STALE_MS) return true;
  return holder !== null && holder.host === hostname() && !processAlive(holder.pid);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists, it just isn't ours to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Removes a stale lock, unless it changed hands since it was judged stale. */
async function breakLock(lockFile: string, stale: LockHolder | null) {
  const now = await readLock(lockFile);
  if (now && now.holder?.token === stale?.token) await unlink(lockFile).catch(() => {});
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}
