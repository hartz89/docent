import { type CommitSha, type NonEmpty, splitLines } from './basics.ts';

/** Where an anchor's text starts, at a commit. The end line comes from the text (A1). */
export type Location = {
  readonly commit: CommitSha;
  readonly path: string;
  readonly startLine: number;
};

/** Up to two lines just before and just after an anchor's text, to tell copies apart (A1, A4). */
export type Context = { readonly before: readonly string[]; readonly after: readonly string[] };

const CONTEXT_LINES = 2;

type Cited = { readonly lines: NonEmpty<string>; readonly context: Context };

/**
 * The exact code a claim cites, and where it is (A1, A2). An out-of-date anchor keeps only the
 * place it was last seen, under a different name, so it can't be read as a current location.
 */
export type Anchor =
  | (Cited & { readonly state: 'current'; readonly at: Location })
  | (Cited & { readonly state: 'out_of_date'; readonly lastSeen: Location });

/** A version of one file: what re-anchoring checks against. */
export type FileVersion = {
  readonly commit: CommitSha;
  readonly path: string;
  readonly text: string;
};

/** The last line an anchor covers at its location. */
export const endLine = (location: Location, lines: NonEmpty<string>): number =>
  location.startLine + lines.length - 1;

/** Cites `count` lines of a file starting at `startLine` (A3). Null if the range is outside it. */
export function anchorAt(file: FileVersion, startLine: number, count: number): Anchor | null {
  const fileLines = splitLines(file.text);
  if (!Number.isInteger(startLine) || !Number.isInteger(count) || startLine < 1 || count < 1) {
    return null;
  }
  const [first, ...rest] = fileLines.slice(startLine - 1, startLine - 1 + count);
  if (first === undefined || rest.length !== count - 1) return null;
  return {
    state: 'current',
    lines: [first, ...rest],
    context: contextAt(fileLines, startLine, count),
    at: { commit: file.commit, path: file.path, startLine },
  };
}

/**
 * Checks an anchor against a new version of its file, or `null` if the file was deleted.
 * It follows the code or flags it out of date, and never points at the wrong lines (A4–A6).
 */
export function reanchor(anchor: Anchor, file: FileVersion | null): Anchor {
  const { lines, context } = anchor;
  const previous = anchor.state === 'current' ? anchor.at : anchor.lastSeen;
  const outOfDate: Anchor = { state: 'out_of_date', lines, context, lastSeen: previous };
  if (file === null) return outOfDate;

  const fileLines = splitLines(file.text);
  let starts = matchesAt(fileLines, lines);
  if (starts.length > 1) {
    const want = JSON.stringify(context);
    starts = starts.filter(
      (start) => JSON.stringify(contextAt(fileLines, start, lines.length)) === want,
    );
  }
  const [startLine, ...others] = starts;
  if (startLine === undefined || others.length > 0) return outOfDate;
  return {
    state: 'current',
    lines,
    // The code's new surroundings, so the next re-anchoring compares against them.
    context: contextAt(fileLines, startLine, lines.length),
    at: { commit: file.commit, path: file.path, startLine },
  };
}

function contextAt(fileLines: readonly string[], startLine: number, count: number): Context {
  const start = startLine - 1;
  return {
    before: fileLines.slice(Math.max(0, start - CONTEXT_LINES), start),
    after: fileLines.slice(start + count, start + count + CONTEXT_LINES),
  };
}

/** Every 1-based start line where `needle` appears as whole, consecutive lines. */
function matchesAt(haystack: readonly string[], needle: readonly string[]): number[] {
  const starts: number[] = [];
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((line, j) => haystack[i + j] === line)) starts.push(i + 1);
  }
  return starts;
}
