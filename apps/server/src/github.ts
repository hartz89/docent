// The boundary to GitHub and git: PR metadata and diff through `gh`, and a read-only checkout of
// the head commit in Docent's cache folder, so the guide can read real code.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type CommitSha, commitSha } from '@docent/core';
import { gitHeadFiles, type HeadFiles } from './head-files.ts';

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
  /** The PR's head commit right now, which moves when the author pushes. */
  currentHead: () => Promise<CommitSha>;
  /** Posts one review on this PR as the reviewer, and returns its link on GitHub. */
  postReview: (review: ReviewPost) => Promise<{ url: string }>;
  /** The files at head, for the symbol index: read from git's objects, never the working tree. */
  headFiles: () => Promise<HeadFiles>;
};

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

    const show = async (sha: string, path: string) => {
      if (!isSafeRepoPath(path)) return null;
      try {
        const { stdout } = await git(dir, ['show', `${sha}:${path}`], {
          maxBuffer: 64 * 1024 * 1024,
        });
        return stdout;
      } catch {
        return null;
      }
    };
    const pull = `repos/${repo}/pulls/${pr.number}`;
    // The PR is on github.com; GH_HOST or a default Enterprise host must not redirect the write.
    const onGitHub = ['--hostname', 'github.com'];
    return {
      pr,
      diffText,
      commitMessages: commitPages.flat().map((c) => c.commit.message),
      headInBaseRepo: !view.isCrossRepository,
      dir,
      readFile: (side, path) => show(side === 'new' ? pr.head : pr.base, path),
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
      headFiles: () => gitHeadFiles(dir, pr.head),
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
  await git(dir, [
    'fetch',
    '--quiet',
    '--depth=1',
    '--filter=blob:none',
    '--no-recurse-submodules',
    'origin',
    pr.base,
    pr.head,
  ]);
  await git(dir, ['checkout', '--quiet', '--detach', pr.head]);
  await writeFile(ready, `${new Date().toISOString()}\n`);
}

/**
 * Git over code we don't trust. The checkout is read by an agent and served to the browser, so:
 * - no user or system config (no aliases, hooks, filters or helpers from the machine), except
 *   `gh` as the credential helper, so private repos still fetch;
 * - no hooks, no submodules, no LFS downloads, no file:// transport;
 * - symlinks check out as plain files holding the link text, so nothing points out of the
 *   checkout.
 */
export function git(dir: string, args: readonly string[], options: { maxBuffer?: number } = {}) {
  return run('git', hardenedGitArgs(dir, args), {
    maxBuffer: options.maxBuffer ?? 1 << 26,
    env: hardenedGitEnv(),
  });
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
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...(offline ? { GIT_NO_LAZY_FETCH: '1' } : {}),
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
