// The boundary to GitHub and git: PR metadata and diff through `gh`, and a read-only checkout of
// the head commit in Docent's cache folder, so the guide can read real code.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type CommitSha, commitSha } from '@docent/core';

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

/** A PR opened for review: its metadata, its diff, and a way to read its files. */
export type Workspace = {
  pr: PrInfo;
  diffText: string;
  /** The checkout at head, where the guide runs. */
  dir: string;
  /** A file's text at the base or head commit, or null if it doesn't exist there. */
  readFile: (side: 'old' | 'new', path: string) => Promise<string | null>;
};

/** Opens a PR. Real ones come from GitHub; tests and the e2e flow use recorded fixtures. */
export type PrSource = (onStep: (step: string) => void) => Promise<Workspace>;

export function parsePrUrl(url: string): { owner: string; name: string; number: number } | null {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?(?:[?#].*)?$/.exec(
    url,
  );
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return { owner: match[1], name: match[2], number: Number(match[3]) };
}

/** Where Docent keeps checkouts and finished tours: the OS cache folder, never the repo. */
export function defaultCacheDir(): string {
  if (process.env.DOCENT_CACHE_DIR) return process.env.DOCENT_CACHE_DIR;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'docent');
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'docent');
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
        'number,title,body,author,baseRefOid,headRefOid,baseRefName,headRefName,url',
      ]),
    ) as {
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
    const [diffText, mergeBase] = await Promise.all([
      gh(['pr', 'diff', url]),
      gh([
        'api',
        `repos/${repo}/compare/${view.baseRefOid}...${view.headRefOid}`,
        '--jq',
        '.merge_base_commit.sha',
      ]).then((out) => out.trim()),
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

    const show = async (sha: string, path: string) => {
      if (!isSafeRepoPath(path)) return null;
      try {
        const { stdout } = await run('git', ['-C', dir, 'show', `${sha}:${path}`], {
          maxBuffer: 64 * 1024 * 1024,
        });
        return stdout;
      } catch {
        return null;
      }
    };
    return {
      pr,
      diffText,
      dir,
      readFile: (side, path) => show(side === 'new' ? pr.head : pr.base, path),
    };
  };
}

/**
 * A shallow, blobless fetch of just the two commits, checked out detached at head. Fork PRs work
 * because GitHub serves every PR's head as refs/pull/N/head on the base repo.
 */
async function ensureCheckout(dir: string, repo: string, pr: PrInfo): Promise<void> {
  const ready = join(dir, '.git', 'docent-ready');
  if (existsSync(ready)) return;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const git = (...args: string[]) => run('git', ['-C', dir, ...args], { maxBuffer: 1 << 26 });
  await git('init', '--quiet');
  await git('remote', 'add', 'origin', `https://github.com/${repo}.git`);
  await git(
    'fetch',
    '--quiet',
    '--depth=1',
    '--filter=blob:none',
    'origin',
    pr.base,
    `refs/pull/${pr.number}/head`,
  );
  await git('-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', pr.head);
  await writeFile(ready, `${new Date().toISOString()}\n`);
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

/** A relative path inside the repo: no absolute paths, no `..`, no NUL, no option-like names. */
export function isSafeRepoPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length < 4096 &&
    !path.startsWith('/') &&
    !path.startsWith('-') &&
    !path.includes('\0') &&
    !path.split('/').some((part) => part === '..' || part === '')
  );
}
