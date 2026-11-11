// Recorded reviews: a saved PR, its diff, the files read, and the guide's replies. `--record`
// saves one from a real run; `--fixture` replays it with no GitHub or model calls. A review
// submitted in fixture mode is printed, never posted.
import { existsSync } from 'node:fs';
import { mkdir, readFile as readFileText, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentReply, AgentRunner } from './agent.ts';
import {
  fileFromText,
  isSafeRepoPath,
  type PrInfo,
  type PrSource,
  type RepoTree,
  type ReviewPost,
} from './github.ts';

type RecordedReplies = Partial<Record<'tour' | 'question', AgentReply[]>>;

const fileAt = (dir: string, side: 'old' | 'new', path: string) =>
  join(dir, 'files', side === 'new' ? 'head' : 'base', path);

/** Where fixture mode sends a submitted review instead of GitHub. The CLI prints it. */
export type ReviewRecorder = (review: ReviewPost) => void;

export const printReview: ReviewRecorder = (review) =>
  console.log(`Recorded a review, not sent to GitHub: ${JSON.stringify(review)}`);

export function fixtureSource(dir: string, record: ReviewRecorder = printReview): PrSource {
  return async (onStep) => {
    onStep('Loading the recorded pull request');
    const pr = JSON.parse(await readFileText(join(dir, 'pr.json'), 'utf8')) as PrInfo;
    // Recorded files are trusted test data, so they're read from disk.
    const readFile = async (side: 'old' | 'new', path: string) => {
      const file = fileAt(dir, side, path);
      return isSafeRepoPath(path) && existsSync(file) ? readFileText(file, 'utf8') : null;
    };
    return {
      pr,
      diffText: await readFileText(join(dir, 'diff.patch'), 'utf8'),
      // Not recorded: a replay names its author session with --session, or has none.
      commitMessages: [],
      headInBaseRepo: false,
      dir: join(dir, 'files', 'head'),
      readFile,
      open: async (side, path) => fileFromText(await readFile(side, path)),
      // The recorded tree, or none: older fixtures didn't record one.
      tree: async () => {
        const file = join(dir, 'tree.json');
        return existsSync(file)
          ? (JSON.parse(await readFileText(file, 'utf8')) as RepoTree)
          : { entries: [], truncated: false };
      },
      currentHead: async () => pr.head,
      postReview: async (review) => {
        record(review);
        return { url: `${pr.url}#pullrequestreview-0` };
      },
    };
  };
}

/** Replays the recorded replies for each job in order, repeating the last one. */
export function fixtureRunner(dir: string): AgentRunner {
  let replies: RecordedReplies | undefined;
  const used = { tour: 0, question: 0 };
  return async (request) => {
    replies ??= JSON.parse(
      await readFileText(join(dir, 'replies.json'), 'utf8'),
    ) as RecordedReplies;
    const job = request.job === 'question' ? 'question' : 'tour';
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
        open: async (side, path) => {
          const file = await workspace.open(side, path);
          if (file.kind === 'text') await save(fileAt(dir, side, path), file.text);
          return file;
        },
        tree: async () => {
          const tree = await workspace.tree();
          await save(join(dir, 'tree.json'), `${JSON.stringify(tree, null, 1)}\n`);
          return tree;
        },
      };
    },
    runner: async (request) => {
      const reply = await runner(request);
      const job = request.job === 'question' ? 'question' : 'tour';
      replies[job] = [...(replies[job] ?? []), reply];
      await save(join(dir, 'replies.json'), `${JSON.stringify(replies, null, 2)}\n`);
      return reply;
    },
  };
}
