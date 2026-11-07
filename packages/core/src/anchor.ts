import { type CommitSha, type NonEmpty, splitLines } from './basics.ts';

/** Where an anchor's text starts, at a commit. The end line comes from the text (A1). */
export type Location = {
  readonly commit: CommitSha;
  readonly path: string;
  readonly startLine: number;
};

/**
 * The exact code a claim cites, and where it is (A1, A2). An out-of-date anchor keeps only the
 * place it was last seen, under a different name, so it can't be read as a current location.
 */
export type Anchor =
  | { readonly state: 'current'; readonly lines: NonEmpty<string>; readonly at: Location }
  | {
      readonly state: 'out_of_date';
      readonly lines: NonEmpty<string>;
      readonly lastSeen: Location;
    };

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
    at: { commit: file.commit, path: file.path, startLine },
  };
}

/** Checks an anchor against a new version of its file, following the code or flagging it (A4–A6). */
export function reanchor(anchor: Anchor, file: FileVersion): Anchor {
  const previous = anchor.state === 'current' ? anchor.at : anchor.lastSeen;
  const fileLines = splitLines(file.text);
  const starts = matchesAt(fileLines, anchor.lines);
  const startLine = starts.includes(previous.startLine)
    ? previous.startLine
    : starts.length === 1
      ? starts[0]
      : undefined;
  if (startLine === undefined) {
    return { state: 'out_of_date', lines: anchor.lines, lastSeen: previous };
  }
  return {
    state: 'current',
    lines: anchor.lines,
    at: { commit: file.commit, path: file.path, startLine },
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
