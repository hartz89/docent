// Small shared building blocks for the core types.

/** A value of type T tagged with a name, so two kinds of id can't be mixed up (R2). */
export type Brand<T, Name extends string> = T & { readonly __brand: Name };

/** A list with at least one element. */
export type NonEmpty<T> = readonly [T, ...T[]];

/** The outcome of an operation that can be refused. */
export type Result<T, Reason extends string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: Reason };

/** A git commit SHA. */
export type CommitSha = Brand<string, 'CommitSha'>;
export const commitSha = (sha: string): CommitSha => sha as CommitSha;

/** One line of text: not blank, no line breaks (B2). Only `oneLine()` makes one. */
export type OneLine = Brand<string, 'OneLine'>;

/** Returns the trimmed text as a OneLine, or null if it's blank or spans several lines. */
export function oneLine(text: string): OneLine | null {
  const trimmed = text.trim();
  return trimmed === '' || /[\r\n]/.test(trimmed) ? null : (trimmed as OneLine);
}

/** Splits file text into lines on \n or \r\n. A final line break doesn't start a new line. */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}
