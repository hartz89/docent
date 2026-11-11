// The reviewer's line comments, from what the browser sends to what GitHub receives. The browser
// names only a file, a side, a line and the text. Everything else in the review (where each
// comment lands, the links, the commit) is worked out here from the review's own PR and diff.
import { type Diff, diffPosition, githubLineUrl, lineCount, type Side } from '@docent/core';
import { isSafeRepoPath, type PrInfo, type ReviewLineComment } from './github.ts';

/** One comment as the reviewer wrote it: on a line of a file, at head ("new") or base ("old"). */
export type DraftComment = { path: string; side: Side; line: number; body: string };

/** How many comments one review may carry. */
export const MAX_COMMENTS = 50;
/** How long one comment may be. GitHub allows more; a line comment this long is a mistake. */
export const MAX_COMMENT_CHARS = 10_000;

/**
 * The comments in a submit request, checked for shape, or why they aren't valid. Leaving them
 * out means none. Paths here are only well-formed; `placeComments` checks they're real.
 */
export function parseComments(input: unknown): DraftComment[] | string {
  if (input === undefined) return [];
  if (!Array.isArray(input)) return 'Send comments as a list.';
  if (input.length > MAX_COMMENTS) return `A review can carry up to ${MAX_COMMENTS} comments.`;
  const comments: DraftComment[] = [];
  for (const item of input as unknown[]) {
    const { path, side, line, body } = (item ?? {}) as Record<string, unknown>;
    if (typeof path !== 'string' || !isCommentPath(path)) {
      return 'Each comment needs the path of a file in the repository.';
    }
    if (side !== 'old' && side !== 'new') return 'Each comment needs a side: old or new.';
    if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1) {
      return 'Each comment needs a line number.';
    }
    const text = typeof body === 'string' ? body.trim() : '';
    if (!text) return 'A comment can’t be empty.';
    if (text.length > MAX_COMMENT_CHARS) {
      return `A comment can be up to ${MAX_COMMENT_CHARS.toLocaleString('en-US')} characters.`;
    }
    comments.push({ path, side, line, body: text });
  }
  return comments;
}

/** A comment on a line outside the diff: GitHub can't hold it on the line, so it goes in the body. */
type BodyNote = DraftComment;

/**
 * Sorts each comment to where it can land. A line inside the diff becomes a GitHub line comment,
 * at the position GitHub uses. A line outside it becomes a linked note in the review body; it is
 * never moved to the nearest changed line. Refuses, with a reason, a file that doesn't exist on
 * that side or a line past its end.
 */
export async function placeComments(
  comments: readonly DraftComment[],
  diff: Diff,
  readFile: (side: Side, path: string) => Promise<string | null>,
): Promise<{ lineComments: ReviewLineComment[]; notes: BodyNote[] } | string> {
  const lineComments: ReviewLineComment[] = [];
  const notes: BodyNote[] = [];
  const lineCounts = new Map<string, number | null>();
  for (const comment of comments) {
    const key = `${comment.side}:${comment.path}`;
    if (!lineCounts.has(key)) {
      const text = await readFile(comment.side, comment.path);
      lineCounts.set(key, text === null || text.includes('\0') ? null : lineCount(text));
    }
    const count = lineCounts.get(key) ?? null;
    const at = comment.side === 'new' ? 'head' : 'base';
    if (count === null) return `${comment.path} isn't a text file at ${at}.`;
    if (comment.line > count) {
      return `${comment.path} has ${count} lines at ${at}, so there's no line ${comment.line}.`;
    }
    const position = diffPosition(diff, comment);
    if (position) {
      lineComments.push({
        path: position.path,
        line: position.line,
        side: position.side === 'new' ? 'RIGHT' : 'LEFT',
        body: comment.body,
      });
    } else {
      notes.push(comment);
    }
  }
  return { lineComments, notes };
}

/**
 * The review body: the reviewer's summary, then each note on a line outside the diff as a link
 * to that line on GitHub, with the comment quoted under it.
 */
export function composeBody(summary: string, notes: readonly BodyNote[], pr: PrInfo): string {
  const blocks = notes.map((note) => {
    const sha = note.side === 'new' ? pr.head : pr.base;
    const url = githubLineUrl(pr.repo, sha, note.path, note.line);
    const where = `${note.path}:${note.line}${note.side === 'old' ? ' (base)' : ''}`;
    const quoted = note.body
      .split(/\r?\n/)
      .map((line) => (line ? `> ${line}` : '>'))
      .join('\n');
    return `[${codeSpan(where)}](${url})\n${quoted}`;
  });
  return [summary, ...blocks].filter(Boolean).join('\n\n');
}

/**
 * A path a comment can name: inside the repo, and printable, so it can't break the review body's
 * markdown with a line break.
 */
function isCommentPath(path: string): boolean {
  return (
    isSafeRepoPath(path) &&
    // `./a.ts` names `a.ts` when read, but wouldn't match the diff.
    !path.split('/').includes('.') &&
    // Control characters could break the body's markdown; bidi and zero-width ones could make
    // the `path:line` label read as another file.
    !/[\p{Cc}\p{Cf}]/u.test(path)
  );
}

/** Markdown inline code that holds any text, backticks included. */
function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}
