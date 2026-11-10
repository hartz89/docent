// What a proven skip is, and the small text helpers its detectors share (P1, P2).
import { type Brand, type CommitSha, type NonEmpty, splitLines } from './basics.ts';
import type { Diff, DiffFile, Hunk, HunkId, LineRef } from './diff.ts';

/** What a proof covers: a whole file, one hunk, or one changed line (P1). */
export type ProofTarget =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'hunk'; readonly hunk: HunkId }
  | { readonly kind: 'line'; readonly line: LineRef };

/** One substitution a rename proof relies on: an identifier, or an import path a file move explains. */
export type RenameChange = {
  readonly kind: 'identifier' | 'import_path';
  readonly from: string;
  readonly to: string;
};

/** Why a file counts as generated or vendored: a base `.gitattributes` line, or a known pattern. */
export type GeneratedRule =
  | {
      readonly source: 'gitattributes';
      readonly file: string;
      readonly line: number;
      readonly pattern: string;
    }
  | { readonly source: 'known'; readonly pattern: string };

/** The label a proven skip shows, and the evidence behind it (P3–P9). */
export type Evidence =
  | { readonly label: 'rename'; readonly changes: NonEmpty<RenameChange> }
  | { readonly label: 'whitespace' }
  | { readonly label: 'blank_line' }
  | { readonly label: 'import_in_new_file' }
  | { readonly label: 're_export' }
  /** The caller (the ledger) still has to see one of these manifests on the route (L3). */
  | { readonly label: 'lockfile'; readonly manifests: NonEmpty<string> }
  | { readonly label: 'generated' | 'vendored'; readonly rule: GeneratedRule };

/**
 * P1: a script's proof that some changed lines can't alter behavior. Only core's detectors make
 * one, so a model, a PR comment or a hand-built object can't pass for a proof.
 */
export type Proof = Brand<
  { readonly target: ProofTarget; readonly evidence: Evidence; readonly judgedAt: CommitSha },
  'Proof'
>;

export const makeProof = (diff: Diff, target: ProofTarget, evidence: Evidence): Proof =>
  ({ target, evidence, judgedAt: diff.head }) as Proof;

/**
 * File text at one side of the diff, keyed by path (P2). `null` means the file doesn't exist on
 * that side. A path the map doesn't list is unknown, and an unknown file proves nothing.
 */
export type SideTexts = ReadonlyMap<string, string | null>;
export type FileTexts = { readonly base: SideTexts; readonly head: SideTexts };

/** A file's lines at base and head (null where it doesn't exist). */
export type FileSides = {
  readonly base: readonly string[] | null;
  readonly head: readonly string[] | null;
};

/**
 * P2: the file's text at both sides, or null when either side is unknown or the text doesn't
 * agree with the diff. Agreeing means every hunk line is exactly the line at its number, so a
 * caller can't pair a diff with text from some other commit.
 */
export function sidesOf(file: DiffFile, texts: FileTexts): FileSides | null {
  const baseText = texts.base.get(file.oldPath);
  const headText = texts.head.get(file.path);
  if (baseText === undefined || headText === undefined) return null;
  // Languages may end a line where git doesn't (a lone \r, U+2028, U+2029), so detectors that
  // read lines would see different lines than the parser. Such files prove nothing.
  if (LINE_ENDS.test(`${baseText ?? ''}${headText ?? ''}`)) return null;
  const base = baseText === null ? null : splitLines(baseText);
  const head = headText === null ? null : splitLines(headText);
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      const atBase = line.kind === 'added' ? true : base?.[line.oldLine - 1] === line.text;
      const atHead = line.kind === 'removed' ? true : head?.[line.newLine - 1] === line.text;
      if (!atBase || !atHead) return null;
    }
  }
  return { base, head };
}

/** Line terminators in JS and TS that git doesn't split on: a lone CR, U+2028, U+2029. */
const LINE_ENDS = /[\r\u2028\u2029]/;

export const fileName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
export const dirName = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));

/** The lower-cased extension, or '' (dotfiles like `.npmrc` have none). */
export function extension(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

const JS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'];
/** JavaScript and TypeScript, for the syntax-specific detectors (P5, P6). */
export const JS_LIKE: ReadonlySet<string> = new Set(JS);
/** Languages where indentation and blank lines carry no meaning outside string literals (P3). */
export const INDENT_FREE: ReadonlySet<string> = new Set([
  ...JS,
  'json',
  'java',
  'c',
  'h',
  'cc',
  'cpp',
  'cxx',
  'hpp',
  'hh',
  'cs',
  'go',
  'swift',
  'kt',
  'kts',
  'css',
  'scss',
  'less',
]);
/** Where spacing between tokens is free too: no macros that stringify arguments (P3). */
export const SPACING_FREE: ReadonlySet<string> = new Set([...JS, 'json', 'java', 'cs', 'go']);
/** Where adding or removing a blank line is free. Go is out: `// +build` needs a blank line after it (P4). */
export const BLANK_FREE: ReadonlySet<string> = new Set(
  [...INDENT_FREE, 'py'].filter((ext) => ext !== 'go'),
);

/** Both of a file's paths have an extension in the set (a move can't change languages). */
export const inLanguages = (file: DiffFile, set: ReadonlySet<string>): boolean =>
  set.has(extension(file.path)) && set.has(extension(file.oldPath));

const STRING_OPENERS = /"""|'''|@\$?"|\$@"|R"/;

/**
 * True when a string literal could span lines anywhere in the text, which would make indentation,
 * blank lines or identifiers inside it meaningful: triple quotes, raw or verbatim strings, a line
 * that ends in a backslash, or a template literal left open at the end of a line. Errs toward true.
 */
export function mayHaveMultilineStrings(lines: readonly string[] | null): boolean {
  if (lines === null) return false;
  return lines.some((line) => {
    if (/\\[ \t]*$/.test(line) || STRING_OPENERS.test(line)) return true;
    if (!line.includes('`')) return false;
    // An odd count leaves a template open. Braces or `$` may hide one inside `${`, and a quote,
    // slash or backslash could hide a backtick in a string, rune, regex or comment and throw the
    // count off, so a backtick next to any of those counts as open too.
    return count(line, '`') % 2 === 1 || /['"/\\{}$]/.test(line);
  });
}

const count = (text: string, char: string): number => text.split(char).length - 1;

export const isBlank = (text: string): boolean => /^[ \t]*$/.test(text);

/** The changed lines of a hunk, split into blocks: each run of removed and added lines between context. */
export function changeBlocks(
  hunk: Hunk,
): { readonly removed: readonly string[]; readonly added: readonly string[] }[] {
  const blocks: { removed: string[]; added: string[] }[] = [];
  let current: { removed: string[]; added: string[] } | null = null;
  for (const line of hunk.lines) {
    if (line.kind === 'context') {
      current = null;
      continue;
    }
    if (current === null) {
      current = { removed: [], added: [] };
      blocks.push(current);
    }
    (line.kind === 'removed' ? current.removed : current.added).push(line.text);
  }
  return blocks;
}

export const hasChanges = (hunk: Hunk): boolean => hunk.lines.some((l) => l.kind !== 'context');
