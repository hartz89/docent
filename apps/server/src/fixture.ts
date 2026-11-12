// Recorded reviews: a saved PR, its diff, the files read, and the guide's replies. `--record`
// saves one from a real run; `--fixture` replays it with no GitHub or model calls. A review
// submitted in fixture mode is printed, never posted.
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { Job } from '@docent/core';
import type { AgentReply, AgentRunner } from './agent.ts';
import { isSafeRepoPath, type PrInfo, type PrSource, type ReviewPost } from './github.ts';
import type { HeadFile, HeadFiles } from './head-files.ts';

type RecordedJob = 'tour' | 'question' | 'answer_check';
type RecordedReplies = Partial<Record<RecordedJob, AgentReply[]>>;

/** Questions and answer checks are recorded on their own; every other job is the tour's. */
const recordedJob = (job: Job): RecordedJob =>
  job === 'question' || job === 'answer_check' ? job : 'tour';

const fileAt = (dir: string, side: 'old' | 'new', path: string) =>
  join(dir, 'files', side === 'new' ? 'head' : 'base', path);

/** Where fixture mode sends a submitted review instead of GitHub. The CLI prints it. */
export type ReviewRecorder = (review: ReviewPost) => void;

export const printReview: ReviewRecorder = (review) =>
  console.log(`Recorded a review, not sent to GitHub: ${JSON.stringify(review)}`);

export function fixtureSource(dir: string, record: ReviewRecorder = printReview): PrSource {
  return async (onStep) => {
    onStep('Loading the recorded pull request');
    const pr = JSON.parse(await readFile(join(dir, 'pr.json'), 'utf8')) as PrInfo;
    return {
      pr,
      diffText: await readFile(join(dir, 'diff.patch'), 'utf8'),
      // Not recorded: a replay names its author session with --session, or has none.
      commitMessages: [],
      headInBaseRepo: false,
      dir: join(dir, 'files', 'head'),
      readFile: async (side, path) => {
        const file = fileAt(dir, side, path);
        return isSafeRepoPath(path) && existsSync(file) ? readFile(file, 'utf8') : null;
      },
      currentHead: async () => pr.head,
      postReview: async (review) => {
        record(review);
        return { url: `${pr.url}#pullrequestreview-0` };
      },
      headFiles: () => recordedHeadFiles(join(dir, 'files', 'head')),
    };
  };
}

/** The recorded head files, from disk: a fixture is trusted test data, not a PR's code. */
async function recordedHeadFiles(root: string): Promise<HeadFiles> {
  const entries: HeadFile[] = [];
  const found = existsSync(root)
    ? await readdir(root, { recursive: true, withFileTypes: true })
    : [];
  for (const entry of found) {
    if (!entry.isFile()) continue;
    const path = relative(root, join(entry.parentPath, entry.name)).split(sep).join('/');
    entries.push({ path, bytes: (await stat(join(root, path))).size });
  }
  return {
    entries,
    truncated: false,
    read: async function* (paths) {
      for (const path of paths) {
        yield { path, text: await readFile(join(root, path), 'utf8').catch(() => null) };
      }
    },
  };
}

/** Replays the recorded replies for each job in order, repeating the last one. */
export function fixtureRunner(dir: string): AgentRunner {
  let replies: RecordedReplies | undefined;
  const used: Record<RecordedJob, number> = { tour: 0, question: 0, answer_check: 0 };
  return async (request) => {
    replies ??= JSON.parse(await readFile(join(dir, 'replies.json'), 'utf8')) as RecordedReplies;
    const job = recordedJob(request.job);
    const list = replies[job] ?? [];
    const reply = list[Math.min(used[job]++, list.length - 1)];
    if (!reply) throw new Error(`The fixture has no recorded ${job} reply.`);
    return reply;
  };
}

/** Wraps a real source and runner so everything they return is saved as a fixture. */
export function recording(
  dir: string,
  source: PrSource,
  runner: AgentRunner,
): { source: PrSource; runner: AgentRunner } {
  const save = async (path: string, text: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  };
  const replies: RecordedReplies = {};
  return {
    source: async (onStep) => {
      const workspace = await source(onStep);
      await save(join(dir, 'pr.json'), `${JSON.stringify(workspace.pr, null, 2)}\n`);
      await save(join(dir, 'diff.patch'), workspace.diffText);
      return {
        ...workspace,
        readFile: async (side, path) => {
          const text = await workspace.readFile(side, path);
          if (text !== null) await save(fileAt(dir, side, path), text);
          return text;
        },
      };
    },
    runner: async (request) => {
      const reply = await runner(request);
      const job = recordedJob(request.job);
      replies[job] = [...(replies[job] ?? []), reply];
      await save(join(dir, 'replies.json'), `${JSON.stringify(replies, null, 2)}\n`);
      return reply;
    },
  };
}
