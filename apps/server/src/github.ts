// The boundary to GitHub and git: PR metadata and diff through `gh`, and a read-only checkout of
// the head commit in Docent's cache folder, so the guide can read real code.
import { type ChildProcess, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type CommitSha, commitSha } from '@docent/core';
import { type CommitListing, type HeadFiles, headFilesFrom, listCommit } from './head-files.ts';

const run = promisify(execFile);

export type PrInfo = {
  url: string;
  repo: `${string}/${string}`;
  number: number;
  title: string;
  body: string;
  author: string;
  /** The merge base: what the diff is taken against. */
  base: CommitSha;
  head: CommitSha;
  baseRef: string;
  headRef: string;
};

/** The reviewer's verdict, in GitHub's terms. */
export const REVIEW_EVENTS = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'] as const;
export type ReviewEvent = (typeof REVIEW_EVENTS)[number];

/** One review to post. The PR it goes on is fixed by the workspace, never by the caller. */
export type ReviewPost = { commitId: CommitSha; event: ReviewEvent; body: string };

/** A PR opened for review: its metadata, its diff, and a way to read its files. */
export type Workspace = {
  pr: PrInfo;
  diffText: string;
  /** Full commit messages, oldest first: where agents leave their session links. */
  commitMessages: string[];
  /** The head branch is in the PR's own repo, not a fork. */
  headInBaseRepo: boolean;
  /** The checkout at head, where the guide runs. */
  dir: string;
  /** A file's text at the base or head commit, or null if it doesn't exist there. */
  readFile: (side: 'old' | 'new', path: string) => Promise<string | null>;
  /** One file for the reviewer's code view: its text, or why it isn't shown. */
  open: (side: 'old' | 'new', path: string) => Promise<RepoFile>;
  /** Many files at once, each exactly as `open` gives it. Skip proofs read every changed file. */
  openAll: (side: 'old' | 'new', paths: readonly string[]) => Promise<Map<string, RepoFile>>;
  /** Every file in the repo at head, for browsing. */
  tree: () => Promise<RepoTree>;
  /** The PR's head commit right now, which moves when the author pushes. */
  currentHead: () => Promise<CommitSha>;
  /** Posts one review on this PR as the reviewer, and returns its link on GitHub. */
  postReview: (review: ReviewPost) => Promise<{ url: string }>;
  /** The files at head, for the symbol index: read from git's objects, never the working tree. */
  headFiles: () => Promise<HeadFiles>;
  /**
   * Every `.gitattributes` file at the base commit, by path. Generated-file proofs read these,
   * never the PR's own (core's P8). Null when git couldn't list or read every one of them.
   */
  baseGitattributes: () => Promise<Map<string, string> | null>;
  /**
   * The paths where each word appears as a whole word, at the base or head commit, across the
   * whole repo (`git grep -lw`). Rename proofs ask these (core's P9). A word the answer leaves
   * out is unknown, and proves nothing.
   */
  findWords: (
    side: 'old' | 'new',
    words: readonly string[],
    signal?: AbortSignal,
  ) => Promise<Map<string, string[]>>;
};

/** One path in the repo at head. Folders are implied by the paths under them. */
export type TreeEntry = { path: string; kind: 'file' | 'symlink' | 'submodule' };
export type RepoTree = { entries: TreeEntry[]; truncated: boolean };

/** A file as the code view gets it. Only text is ever sent; the rest says why not. */
export type RepoFile =
  | { kind: 'text'; text: string }
  | { kind: 'binary' }
  | { kind: 'too_large'; bytes: number }
  | { kind: 'symlink'; target: string }
  | { kind: 'missing' };

/** The code view shows text files up to this size. */
export const MAX_FILE_BYTES = 2_000_000;
/** The file tree lists at most this many paths. */
export const MAX_TREE_ENTRIES = 50_000;

/** Classifies text already in hand (fixtures and tests) the way the git reader does. */
export function fileFromText(text: string | null): RepoFile {
  if (text === null) return { kind: 'missing' };
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_FILE_BYTES) return { kind: 'too_large', bytes };
  return text.includes('\0') ? { kind: 'binary' } : { kind: 'text', text };
}

/** `openAll` for a workspace that has only `open`: fixtures and tests, whose reads are cheap. */
export function openEach(open: Workspace['open']): Workspace['openAll'] {
  return async (side, paths) =>
    new Map(await Promise.all(paths.map(async (path) => [path, await open(side, path)] as const)));
}

/** GitHub turned the review down, or couldn't be reached. The message is fit to show. */
export class GitHubRefusal extends Error {}

/** Opens a PR. Real ones come from GitHub; tests and the e2e flow use recorded fixtures. */
export type PrSource = (onStep: (step: string) => void) => Promise<Workspace>;

export function parsePrUrl(url: string): { owner: string; name: string; number: number } | null {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?(?:[?#].*)?$/.exec(
    url,
  );
  if (!match?.[1] || !match[2] || !match[3]) return null;
  if ([match[1], match[2]].some((part) => /^\.+$/.test(part))) return null;
  return { owner: match[1], name: match[2], number: Number(match[3]) };
}

/** Where Docent keeps checkouts and finished tours: the OS cache folder, never the repo. */
export function defaultCacheDir(): string {
  if (process.env.DOCENT_CACHE_DIR) return process.env.DOCENT_CACHE_DIR;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'docent');
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'docent');
}

/**
 * Where Docent keeps what it wants to hold on to, like run logs: the OS data folder. The same
 * rules as the author-session hook's records (PR #55); whichever lands second shares this one.
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

export function githubSource(url: string, cacheDir: string): PrSource {
  const ref = parsePrUrl(url);
  if (!ref) throw new Error(`Not a GitHub pull request URL: ${url}`);
  const repo = `${ref.owner}/${ref.name}` as const;

  return async (onStep) => {
    onStep('Fetching the pull request');
    const view = JSON.parse(
      await gh([
        'pr',
        'view',
        url,
        '--json',
        'number,title,body,author,baseRefOid,headRefOid,baseRefName,headRefName,url,isCrossRepository',
      ]),
    ) as {
      isCrossRepository: boolean;
      number: number;
      title: string;
      body: string;
      author: { login: string };
      baseRefOid: string;
      headRefOid: string;
      baseRefName: string;
      headRefName: string;
      url: string;
    };
    // GitHub's PR diff is against the merge base, not the base branch's tip.
    const [diffText, mergeBase, commitPages] = await Promise.all([
      gh(['pr', 'diff', url]),
      gh([
        'api',
        `repos/${repo}/compare/${view.baseRefOid}...${view.headRefOid}`,
        '--jq',
        '.merge_base_commit.sha',
      ]).then((out) => out.trim()),
      // Every commit, not just the first 100 that `gh pr view` lists. Oldest first.
      gh(['api', `repos/${repo}/pulls/${view.number}/commits`, '--paginate', '--slurp']).then(
        (out) => JSON.parse(out) as { commit: { message: string } }[][],
      ),
    ]);
    const pr: PrInfo = {
      url: view.url,
      repo,
      number: view.number,
      title: view.title,
      body: view.body,
      author: view.author.login,
      base: commitSha(mergeBase),
      head: commitSha(view.headRefOid),
      baseRef: view.baseRefName,
      headRef: view.headRefName,
    };

    onStep('Checking out the code');
    const dir = join(cacheDir, 'repos', `${ref.owner}__${ref.name}`, pr.head);
    await ensureCheckout(dir, repo, pr);
    await prefetchBlobs(dir, [pr.base, pr.head]);

    const pull = `repos/${repo}/pulls/${pr.number}`;
    // The PR is on github.com; GH_HOST or a default Enterprise host must not redirect the write.
    const onGitHub = ['--hostname', 'github.com'];
    return {
      pr,
      diffText,
      commitMessages: commitPages.flat().map((c) => c.commit.message),
      headInBaseRepo: !view.isCrossRepository,
      dir,
      ...commitReader(dir, pr.base, pr.head),
      currentHead: async () =>
        commitSha((await ghForReview(['api', ...onGitHub, pull, '--jq', '.head.sha'])).trim()),
      postReview: async ({ commitId, event, body }) => {
        // The review goes in as JSON on stdin, so the reviewer's text is never an argument.
        const out = await ghForReview(
          ['api', ...onGitHub, '--method', 'POST', `${pull}/reviews`, '--input', '-'],
          JSON.stringify({ commit_id: commitId, event, body }),
        );
        // gh exited 0, so the review is posted. Never fail from here, or a retry would post twice.
        let url: unknown;
        try {
          url = (JSON.parse(out) as { html_url?: unknown }).html_url;
        } catch {}
        // The link is shown to the reviewer, so it must be GitHub's.
        return { url: typeof url === 'string' && url.startsWith(`${pr.url}#`) ? url : pr.url };
      },
    };
  };
}

/**
 * A shallow, blobless fetch of exactly the two commits, by SHA, checked out detached at head.
 * GitHub serves a fork PR's head commit from the base repo too, so fork PRs work.
 */
async function ensureCheckout(dir: string, repo: string, pr: PrInfo): Promise<void> {
  const ready = join(dir, '.git', 'docent-ready-v2'); // v2: hardened checkout
  if (existsSync(ready)) return;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await git(dir, ['init', '--quiet']);
  await git(dir, ['remote', 'add', 'origin', `https://github.com/${repo}.git`]);
  // A big repo's first fetch and checkout can take minutes, so they get longer than a read.
  await git(
    dir,
    [
      'fetch',
      '--quiet',
      '--depth=1',
      '--filter=blob:none',
      '--no-recurse-submodules',
      'origin',
      pr.base,
      pr.head,
    ],
    { timeout: CHECKOUT_TIMEOUT_MS },
  );
  await git(dir, ['checkout', '--quiet', '--detach', pr.head], { timeout: CHECKOUT_TIMEOUT_MS });
  await writeFile(ready, `${new Date().toISOString()}\n`);
}

/**
 * Fetches, in one request, every blob at these commits that the blobless checkout doesn't have
 * yet. The checkout already brought head's; this is mostly the base side of the PR's changed
 * files. Without it, git fetches each missing blob alone the first time anything reads it (about
 * 250 ms apiece), which makes skip proofs slow on a large PR. It changes when blobs arrive, never
 * which ones or what they hold: the same remote, by object id, through the same hardened git.
 * Best effort: whatever it misses is still fetched on demand, as before. Returns how many blobs
 * it asked for, whether or not the fetch went through.
 */
export async function prefetchBlobs(dir: string, commits: readonly CommitSha[]): Promise<number> {
  let missing: string[];
  try {
    // `--missing=print` lists what's absent (`?<oid>`) and never fetches it.
    const { stdout } = await git(dir, [
      'rev-list',
      '--objects',
      '--no-object-names',
      '--missing=print',
      ...commits,
      '--',
    ]);
    missing = stdout
      .split('\n')
      .filter((line) => /^\?[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(line))
      .map((line) => line.slice(1));
  } catch {
    return 0;
  }
  if (missing.length === 0) return 0;
  try {
    // The same request git's own on-demand fetch makes, for all of them at once. Ids go on stdin,
    // so there's no argument-length limit and nothing from the repo lands in argv.
    await git(
      dir,
      [
        '-c',
        'fetch.negotiationAlgorithm=noop',
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-write-fetch-head',
        '--no-recurse-submodules',
        '--filter=blob:none',
        '--stdin',
        'origin',
      ],
      { input: `${missing.join('\n')}\n`, timeout: PREFETCH_TIMEOUT_MS },
    );
  } catch {}
  return missing.length;
}

/** How long the batched blob fetch may take before reads fall back to fetching on demand. */
const PREFETCH_TIMEOUT_MS = 120_000;
/** How long the checkout's fetch, and the checkout itself, may each take. */
const CHECKOUT_TIMEOUT_MS = 10 * 60_000;
/**
 * How long any other git call may take, unless its caller says otherwise. A read can fetch a
 * missing blob from GitHub, so a stalled network would otherwise hang it, and the request
 * waiting on it, for good.
 */
const GIT_TIMEOUT_MS = 60_000;

/**
 * Reads files and the tree from git's objects at two pinned commits, never from the working tree.
 * A symlink is only ever its link text, so nothing outside the repo can be reached. Paths match
 * literally, and only regular files are read, after their size is checked.
 */
export function commitReader(
  dir: string,
  base: CommitSha,
  head: CommitSha,
  maxTreeEntries = MAX_TREE_ENTRIES,
): Pick<
  Workspace,
  'readFile' | 'open' | 'openAll' | 'tree' | 'headFiles' | 'baseGitattributes' | 'findWords'
> {
  const blob = async (sha: CommitSha, path: string, maxBytes: number): Promise<RepoFile> => {
    if (!isSafeRepoPath(path)) return { kind: 'missing' };
    let listing: string;
    try {
      // `<mode> blob <oid> <size>\t<path>\0` for exactly this path, or nothing.
      ({ stdout: listing } = await git(dir, [...LS_TREE, sha, '--', path]));
    } catch {
      return { kind: 'missing' };
    }
    const entry = listing.endsWith('\0') ? listedBlob(listing.slice(0, -1)) : null;
    const read = toRead(entry?.path === path ? entry : null, maxBytes);
    if ('kind' in read) return read;
    const { stdout } = await git(
      dir,
      ['cat-file', 'blob', read.oid],
      read.symlink ? {} : { maxBuffer: maxBytes + 1 },
    );
    return asRepoFile(read, stdout);
  };
  /**
   * `blob()` for many paths at one commit, in one `ls-tree` and one `cat-file --batch` instead of
   * two git processes per path. Each answer goes through the same checks, so it's what `blob()`
   * gives for that path. Whatever the batch can't answer in full is read one path at a time, the
   * old way, so its answer (or its failure) is exactly the old one too.
   */
  const blobs = async (
    sha: CommitSha,
    paths: readonly string[],
    maxBytes: number,
  ): Promise<Map<string, RepoFile>> => {
    const files = new Map<string, RepoFile>();
    const safe: string[] = [];
    for (const path of new Set(paths)) {
      if (isSafeRepoPath(path)) safe.push(path);
      else files.set(path, { kind: 'missing' });
    }
    // Names are matched as raw bytes, never as decoded text: a name that isn't UTF-8 decodes
    // onto another, and a folder asked for lists every name inside it. `byName` keys are the
    // bytes, one char each (latin1), so two different names never share a key.
    const byName = new Map<string, ListedBlob>();
    const listings = new Map<string, number>();
    const oneByOne = new Set<string>();
    for (const chunk of chunks(safe, (path) => Buffer.byteLength(path) + 1, MAX_ARGV_BYTES)) {
      try {
        const { stdout } = await gitBytes(dir, [...LS_TREE, sha, '--', ...chunk]);
        for (const record of splitRecords(stdout)) {
          const name = record.subarray(record.indexOf(0x09) + 1).toString('latin1');
          listings.set(name, (listings.get(name) ?? 0) + 1);
          const entry = listedBlob(record.toString('latin1'));
          if (entry) byName.set(name, entry);
        }
      } catch {
        for (const path of chunk) oneByOne.add(path);
      }
    }
    const reads = new Map<string, Read>();
    for (const path of safe) {
      if (oneByOne.has(path)) continue;
      const name = Buffer.from(path).toString('latin1');
      // A name listed twice (a malformed tree), or a path with no exact bytes (a lone
      // surrogate), is left to the one-path read, whose answer for it is the old one.
      if ((listings.get(name) ?? 0) > 1 || !path.isWellFormed()) {
        oneByOne.add(path);
        continue;
      }
      const read = toRead(byName.get(name) ?? null, maxBytes);
      if ('kind' in read) files.set(path, read);
      else reads.set(path, read);
    }
    const contents = await catBlobs(dir, [...reads.values()]);
    for (const [path, read] of reads) {
      const file = contents.get(readKey(read));
      if (file !== undefined) files.set(path, file);
      else oneByOne.add(path);
    }
    // The old reader's pace: a few files at a time.
    const queue = [...oneByOne];
    const worker = async () => {
      for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
        files.set(path, await blob(sha, path, maxBytes));
      }
    };
    await Promise.all(Array.from({ length: FALLBACK_CONCURRENCY }, worker));
    return files;
  };
  const at = (side: 'old' | 'new') => (side === 'new' ? head : base);
  // One listing of head, for both the file browser and the symbol index. A failed one isn't
  // kept, so the next request tries again.
  let headListing: Promise<CommitListing> | null = null;
  const listHead = () => {
    headListing ??= listCommit(dir, head).catch((error: unknown) => {
      headListing = null;
      throw error;
    });
    return headListing;
  };
  return {
    // The guide's own reads may be bigger than what the browser is sent.
    readFile: async (side, path) => {
      const file = await blob(at(side), path, 64 * 1024 * 1024);
      if (file.kind === 'text') return file.text;
      return file.kind === 'symlink' ? file.target : null;
    },
    open: (side, path) => blob(at(side), path, MAX_FILE_BYTES),
    openAll: (side, paths) => blobs(at(side), paths, MAX_FILE_BYTES),
    tree: async () => treeOf(await listHead(), maxTreeEntries),
    headFiles: async () => headFilesFrom(dir, await listHead()),
    baseGitattributes: async () => {
      // A listing cut short, or one that can't be read as text, might hide the file that opts a
      // folder back into review, so the whole answer is unknown.
      const listed = treeOf(await listCommit(dir, base), maxTreeEntries);
      if (listed.truncated) return null;
      const found = new Map<string, string>();
      for (const { path } of listed.entries) {
        if (path !== '.gitattributes' && !path.endsWith('/.gitattributes')) continue;
        const file = await blob(base, path, MAX_FILE_BYTES);
        if (file.kind !== 'text') return null;
        found.set(path, file.text);
      }
      return found;
    },
    findWords: async (side, words, signal) => {
      const found = new Map<string, string[]>();
      if (words.length > MAX_WORD_LOOKUPS) return found;
      const queue = [...words];
      const worker = async () => {
        for (let word = queue.shift(); word !== undefined; word = queue.shift()) {
          if (signal?.aborted) return;
          const paths = await grepWord(dir, at(side), word, signal);
          if (paths !== null) found.set(word, paths);
        }
      };
      await Promise.all(Array.from({ length: GREP_CONCURRENCY }, worker));
      return found;
    },
  };
}

/** `ls-tree` for exact paths, as listed: modes, object ids and sizes, NUL-separated. */
const LS_TREE = [
  '-c',
  'core.precomposeunicode=false',
  '--literal-pathspecs',
  'ls-tree',
  '-z',
  '--long',
];

/** One blob as `ls-tree --long` lists it. Trees, submodules and anything else aren't blobs. */
type ListedBlob = { path: string; mode: string; oid: string; bytes: number };

function listedBlob(record: string): ListedBlob | null {
  const match = /^(\d{6}) blob ([0-9a-f]{40,64}) +(\d+)\t([^\0]*)$/.exec(record);
  if (!match) return null;
  const [, mode = '', oid = '', size = '', path = ''] = match;
  return { path, mode, oid, bytes: Number(size) };
}

/** A blob worth reading, once its mode and size have passed. */
type Read = { oid: string; bytes: number; symlink: boolean };

/**
 * The mode and size checks, before anything is read: only regular files up to `maxBytes`, and
 * symlinks up to 4096 bytes of link text. Everything else is answered without reading it.
 */
function toRead(entry: ListedBlob | null, maxBytes: number): Read | RepoFile {
  if (!entry) return { kind: 'missing' };
  const { mode, oid, bytes } = entry;
  if (mode === '120000') return bytes > 4096 ? { kind: 'missing' } : { oid, bytes, symlink: true };
  if (mode !== '100644' && mode !== '100755') return { kind: 'missing' };
  if (bytes > maxBytes) return { kind: 'too_large', bytes };
  return { oid, bytes, symlink: false };
}

/** The text check, once a blob is read: a symlink is its link text; a NUL means binary. */
function asRepoFile(read: Read, text: string): RepoFile {
  if (read.symlink) return { kind: 'symlink', target: text };
  return text.includes('\0') ? { kind: 'binary' } : { kind: 'text', text };
}

/** Paths per `ls-tree`, in bytes, well under any system's argument limit. */
const MAX_ARGV_BYTES = 64 * 1024;
/** Blob bytes per `cat-file --batch`, so no one process buffers too much. */
const MAX_BATCH_BYTES = 64 * 1024 * 1024;

/** Splits `items` into runs whose sizes add up to at most `budget`, each holding at least one. */
function chunks<T>(items: readonly T[], size: (item: T) => number, budget: number): T[][] {
  const runs: T[][] = [];
  let current: T[] = [];
  let used = 0;
  for (const item of items) {
    if (current.length > 0 && used + size(item) > budget) {
      runs.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += size(item);
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/** Files read one at a time, at once, when a batch couldn't answer for them. */
const FALLBACK_CONCURRENCY = 8;

/** The same blob can be a symlink at one path and a file at another, and answers differently. */
const readKey = (read: Read) => `${read.symlink ? 'link' : 'file'} ${read.oid}`;

/** `ls-tree -z` output as records, each still raw bytes. */
function splitRecords(stdout: Buffer): Buffer[] {
  const records: Buffer[] = [];
  for (let at = 0; at < stdout.length; ) {
    const end = stdout.indexOf(0, at);
    const record = stdout.subarray(at, end === -1 ? stdout.length : end);
    if (record.includes(0x09)) records.push(record);
    at = end === -1 ? stdout.length : end + 1;
  }
  return records;
}

/**
 * Blobs read through `cat-file --batch`, answered as `blob()` would answer them, by `readKey`.
 * Ids go in on stdin; each blob comes out as `<oid> blob <size>\n<bytes>\n`, in order. A batch
 * counts only if every blob in it comes back whole, as a blob of the size `ls-tree` gave; the
 * reads of a batch that doesn't are left out, for the caller to read one at a time. Each batch is
 * answered before the next is read, so only one batch's raw output is held at once.
 */
async function catBlobs(dir: string, reads: readonly Read[]): Promise<Map<string, RepoFile>> {
  const unique = [...new Map(reads.map((read) => [readKey(read), read])).values()];
  const found = new Map<string, RepoFile>();
  const header = (read: Read) => Buffer.from(`${read.oid} blob ${read.bytes}\n`);
  for (const batch of chunks(unique, (read) => read.bytes, MAX_BATCH_BYTES)) {
    const expected = batch.reduce((sum, read) => sum + header(read).length + read.bytes + 1, 0);
    let stdout: Buffer;
    try {
      ({ stdout } = await gitBytes(dir, ['cat-file', '--batch'], {
        maxBuffer: expected,
        input: batch.map((read) => `${read.oid}\n`).join(''),
      }));
    } catch {
      continue;
    }
    const answers = new Map<string, RepoFile>();
    let at = 0;
    for (const read of batch) {
      const head = header(read);
      const start = at + head.length;
      const end = start + read.bytes;
      if (!stdout.subarray(at, start).equals(head) || stdout[end] !== 0x0a) break;
      answers.set(readKey(read), asRepoFile(read, stdout.toString('utf8', start, end)));
      at = end + 1;
    }
    if (answers.size !== batch.length || at !== stdout.length) continue;
    for (const [key, file] of answers) found.set(key, file);
  }
  return found;
}

/** More rename candidates than this aren't looked up at all, so they prove nothing. */
const MAX_WORD_LOOKUPS = 200;
/** Word lookups run at once. */
const GREP_CONCURRENCY = 4;

/**
 * The paths that contain `word` as a whole word at a commit, or null when git couldn't say (a
 * timeout, say), which callers must treat as unknown. The word is a fixed string, never a pattern.
 */
async function grepWord(
  dir: string,
  sha: CommitSha,
  word: string,
  signal?: AbortSignal,
): Promise<string[] | null> {
  if (!/^[\w$]+$/.test(word)) return null;
  try {
    const { stdout } = await git(
      dir,
      ['grep', '-l', '-z', '-w', '-F', '--no-color', '-e', word, sha, '--'],
      { timeout: 30_000, ...(signal ? { signal } : {}) },
    );
    // `-l` with a commit names each file `<sha>:<path>`.
    return stdout
      .split('\0')
      .filter(Boolean)
      .map((name) => (name.startsWith(`${sha}:`) ? name.slice(sha.length + 1) : name));
  } catch (error) {
    // git grep exits 1, with no output, when nothing matches. It also exits 1 when it can't read
    // a blob, but then it says so on stderr: that's unknown, never "found nowhere".
    const failure = error as {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      killed?: unknown;
    };
    const quiet = failure.stdout === '' && failure.stderr === '' && !failure.killed;
    return failure.code === 1 && quiet ? [] : null;
  }
}

/** A listing as the file browser shows it: every file, symlink and submodule, up to `max`. */
function treeOf(listing: CommitListing, max: number): RepoTree {
  const entries: TreeEntry[] = listing.entries.slice(0, max).map(({ path, mode }) => ({
    path,
    kind: mode === '160000' ? 'submodule' : mode === '120000' ? 'symlink' : 'file',
  }));
  return { entries, truncated: listing.truncated || listing.entries.length > max };
}

/**
 * Git over code we don't trust. The checkout is read by an agent and served to the browser, so:
 * - no user or system config (no aliases, hooks, filters or helpers from the machine), except
 *   `gh` as the credential helper, so private repos still fetch;
 * - no hooks, no submodules, no LFS downloads, no file:// transport;
 * - symlinks check out as plain files holding the link text, so nothing points out of the
 *   checkout.
 */
export function git(
  dir: string,
  args: readonly string[],
  options: { maxBuffer?: number; timeout?: number; signal?: AbortSignal; input?: string } = {},
) {
  const pending = run('git', hardenedGitArgs(dir, args), {
    maxBuffer: options.maxBuffer ?? 1 << 26,
    env: hardenedGitEnv(),
    timeout: options.timeout ?? GIT_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (options.input !== undefined) feed(pending.child, options.input);
  return pending;
}

/** `git()`, with its output as raw bytes: for blob contents and names that may not be UTF-8. */
function gitBytes(
  dir: string,
  args: readonly string[],
  options: { maxBuffer?: number; input?: string } = {},
) {
  const pending = run('git', hardenedGitArgs(dir, args), {
    encoding: 'buffer',
    maxBuffer: options.maxBuffer ?? 1 << 26,
    env: hardenedGitEnv(),
    timeout: GIT_TIMEOUT_MS,
  });
  if (options.input !== undefined) feed(pending.child, options.input);
  return pending;
}

/**
 * Writes `input` to a child's stdin. git may exit before reading all of it. That's its exit
 * status to report, through the promise; an unhandled EPIPE here would take the whole server
 * down.
 */
function feed(child: ChildProcess, input: string): void {
  child.stdin?.on('error', () => {});
  child.stdin?.end(input);
}

/** `git()`'s arguments, for callers that need to stream its output. */
export function hardenedGitArgs(dir: string, args: readonly string[]): string[] {
  return [
    '-C',
    dir,
    '-c',
    'core.symlinks=false',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'submodule.recurse=false',
    '-c',
    'protocol.file.allow=never',
    '-c',
    'advice.detachedHead=false',
    '-c',
    'credential.helper=',
    '-c',
    'credential.helper=!gh auth git-credential',
    ...args,
  ];
}

/** `git()`'s environment. `offline` forbids fetching missing objects, so nothing is downloaded. */
export function hardenedGitEnv({ offline = false } = {}): NodeJS.ProcessEnv {
  // These would override `-C` and point git at another repository or object store.
  const {
    GIT_DIR: _dir,
    GIT_WORK_TREE: _workTree,
    GIT_INDEX_FILE: _index,
    GIT_OBJECT_DIRECTORY: _objects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: _alternates,
    GIT_COMMON_DIR: _common,
    GIT_NAMESPACE: _namespace,
    ...inherited
  } = process.env;
  return {
    ...inherited,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...(offline ? { GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' } : {}),
  };
}

async function gh(args: string[]): Promise<string> {
  try {
    const { stdout } = await run('gh', args, { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${stderr || String(error)}`);
  }
}

/** `gh` for posting a review: feeds `input` on stdin, and turns failures into GitHubRefusals. */
async function ghForReview(args: string[], input?: string): Promise<string> {
  try {
    // A hung gh would hold the post lock forever; give up after a minute.
    const pending = run('gh', args, { maxBuffer: 1 << 20, timeout: 60_000 });
    pending.child.stdin?.end(input ?? '');
    const { stdout } = await pending;
    return stdout;
  } catch (error) {
    throw new GitHubRefusal(explainGhFailure(error));
  }
}

/** A plain-language reason for a failed `gh` call, with GitHub's own words when it gave some. */
export function explainGhFailure(error: unknown): string {
  const failure = error as { code?: unknown; stdout?: string; stderr?: string };
  if (failure.code === 'ENOENT') {
    return "The GitHub CLI (gh) isn't installed. Install it, run `gh auth login`, then try again.";
  }
  const output = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`;
  if (/gh auth login|HTTP 401|Bad credentials/i.test(output)) {
    return "The GitHub CLI isn't signed in. Run `gh auth login`, then try again.";
  }
  if (/can ?not approve your own pull request/i.test(output)) {
    return "GitHub doesn't let you approve your own pull request. Choose Comment instead.";
  }
  if (/can ?not request changes on your own pull request/i.test(output)) {
    return "GitHub doesn't let you request changes on your own pull request. Choose Comment instead.";
  }
  if (/HTTP 40[34]/.test(output)) {
    return "GitHub refused: your gh login can't review this pull request. Check that it has access to the repository.";
  }
  const said =
    githubErrors(failure.stdout).join('; ') || /^gh: (.+)$/m.exec(failure.stderr ?? '')?.[1];
  return `GitHub didn't accept the review${said ? `: ${said.trim()}` : '.'}`;
}

/** The `errors` GitHub listed in a failed response body, when they're plain strings. */
function githubErrors(body: string | undefined): string[] {
  try {
    const { errors } = JSON.parse(body ?? '') as { errors?: unknown };
    return Array.isArray(errors) ? errors.filter((e) => typeof e === 'string') : [];
  } catch {
    return [];
  }
}

/** A relative path inside the repo: no absolute paths, no `.` or `..`, no NUL, no option-like names. */
export function isSafeRepoPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length < 4096 &&
    !path.startsWith('/') &&
    !path.startsWith('-') &&
    !path.includes('\0') &&
    !path.split('/').some((part) => part === '..' || part === '.' || part === '')
  );
}
