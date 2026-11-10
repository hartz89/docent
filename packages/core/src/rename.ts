// P9: renames, however sweeping. A hunk is a proven rename when one consistent mapping of old
// identifiers to new ones, plus import paths that the diff's own file moves explain, turns every
// removed line into its added line exactly. Conservative throughout: when unsure, no proof.
import type { NonEmpty } from './basics.ts';
import type { Diff, DiffFile, Hunk, HunkId } from './diff.ts';
import {
  dirName,
  extension,
  type FileTexts,
  hasChanges,
  inLanguages,
  JS_LIKE,
  makeProof,
  mayHaveMultilineStrings,
  type Proof,
  type RenameChange,
  sidesOf,
} from './proof.ts';

/**
 * Where names appear across the whole repository, as whole words, in any file (P9). The caller
 * answers the questions `renameLookups` asks, for example with `git grep -lw <name> <commit>`.
 */
export type RenameOccurrences = {
  /** New name → the paths that contain it at the base commit. Must be empty for a rename. */
  readonly base: ReadonlyMap<string, readonly string[]>;
  /** Old name → the paths that contain it at the head commit. Must be empty for a rename. */
  readonly head: ReadonlyMap<string, readonly string[]>;
};

/** The names to look up before proving renames: new names at base, old names at head. */
export type RenameLookups = {
  readonly atBase: readonly string[];
  readonly atHead: readonly string[];
};

/** Languages where a bare word outside a string is an identifier, not data. */
const RENAMABLE: ReadonlySet<string> = new Set([
  ...JS_LIKE,
  'py',
  'go',
  'java',
  'kt',
  'cs',
  'swift',
]);

/** Words that are syntax or built-in values in at least one of those languages. Never mapped. */
const KEYWORDS: ReadonlySet<string> = new Set(
  `abstract and any as assert async await base bool boolean break byte case catch char checked
  class cls const continue debugger decimal declare def default defer del delete do double elif
  else enum event except explicit export extends extern false fallthrough final finally fixed
  float for foreach from fun func function get global go goto guard if implements implicit import
  in infer init inout instanceof int interface internal is iota keyof lambda let lock long map
  match module namespace native never new nil none None nonlocal not null number object of operator
  or out override package params pass private protected public raise range readonly record ref
  repeat require return satisfies sbyte sealed select self Self set short sizeof static string
  struct super switch symbol synchronized this throw throws trait transient true True False try
  type typeof uint ulong undefined unknown unsafe ushort using val var virtual void volatile when
  where while with yield len cap make append panic recover copy close chan print`.split(/\s+/),
);

/** Keywords that introduce a definition of the name right after them. */
const DEFINERS: ReadonlySet<string> = new Set(
  'function const let var class interface type enum def fn fun func struct trait namespace val object'.split(
    ' ',
  ),
);

/** Asks which repository-wide lookups `proveRenames` needs (P9). */
export function renameLookups(diff: Diff, texts: FileTexts): RenameLookups {
  const renames = solve(candidates(diff, texts), localWords(diff, texts), null).flatMap(
    (c) => c.idents,
  );
  const changed = renames.filter(([from, to]) => from !== to);
  return {
    atBase: [...new Set(changed.map(([, to]) => to))].sort(),
    atHead: [...new Set(changed.map(([from]) => from))].sort(),
  };
}

/** P9: hunks that are pure renames, each with the substitutions it relies on. */
export function proveRenames(
  diff: Diff,
  texts: FileTexts,
  occurrences: RenameOccurrences,
): Proof[] {
  const proofs: Proof[] = [];
  for (const candidate of solve(candidates(diff, texts), localWords(diff, texts), occurrences)) {
    const identifiers = new Map<string, RenameChange>();
    for (const [from, to] of candidate.idents) {
      if (from !== to) identifiers.set(from, { kind: 'identifier', from, to });
    }
    const [first, ...rest] = [...identifiers.values(), ...candidate.paths];
    if (first === undefined) continue;
    const changes: NonEmpty<RenameChange> = [first, ...rest];
    proofs.push(
      makeProof(diff, { kind: 'hunk', hunk: candidate.hunk }, { label: 'rename', changes }),
    );
  }
  return proofs;
}

/** One hunk that a mapping could explain, and what the mapping would need to hold. */
type Candidate = {
  readonly hunk: HunkId;
  readonly file: DiffFile;
  /** Every identifier pair the hunk lines up, identity pairs included. */
  readonly idents: readonly (readonly [string, string])[];
  readonly paths: readonly RenameChange[];
  /** Renamed pairs whose definition (`function a` → `function b`) this hunk renames. */
  readonly defines: readonly string[];
  /** Renamed pairs on an import or re-export line, with its relative path at base and head. */
  readonly imports: readonly Import[];
  /** Old names this hunk renames where a property or object key sits, which a rename can't prove. */
  readonly risky: readonly string[];
};

type Import = { readonly pair: string; readonly from: string; readonly to: string };

/**
 * Keeps the candidates whose mapping holds across the whole PR. The mapping must be one to one,
 * map no name both to itself and to another, and for each real rename: never sit in a property
 * position; be licensed in every file that uses it (see `licensed`); and (when occurrences are
 * given) leave the old name nowhere at head and find the new name nowhere at base. Dropping a
 * hunk can break another's proof (its definition was there), so this repeats until nothing
 * changes.
 */
function solve(
  all: readonly Candidate[],
  words: LocalWords,
  occurrences: RenameOccurrences | null,
): Candidate[] {
  let live = [...all];
  for (;;) {
    const targets = new Map<string, Set<string>>();
    const sources = new Map<string, Set<string>>();
    for (const [from, to] of live.flatMap((c) => c.idents)) {
      targets.set(from, (targets.get(from) ?? new Set()).add(to));
      sources.set(to, (sources.get(to) ?? new Set()).add(from));
    }
    const provides = licensed(live);
    const risky = new Set(live.flatMap((c) => c.risky));
    const bad = new Set<string>();
    for (const [from, to] of targets) {
      if (to.size > 1) bad.add(from);
    }
    for (const from of sources.values()) {
      if (from.size > 1) for (const name of from) bad.add(name);
    }
    for (const c of live) {
      for (const [from, to] of c.idents) {
        if (from !== to && !provides.get(c.file.path)?.has(pairKey(from, to))) bad.add(from);
      }
    }
    for (const [from, to] of live.flatMap((c) => c.idents)) {
      if (from === to) continue;
      // The diff's own files are checked here too, so a wrong answer from the caller can't
      // prove a swap (a → b, b → a) or a merge into a name that already exists.
      const fresh =
        !words.base.has(to) &&
        !words.head.has(from) &&
        (occurrences === null ||
          (occurrences.base.get(to)?.length === 0 && occurrences.head.get(from)?.length === 0));
      if (!fresh || risky.has(from)) bad.add(from);
    }
    const next = live.filter((c) => c.idents.every(([from]) => !bad.has(from)));
    if (next.length === live.length) return next;
    live = next;
  }
}

/**
 * Which renamed pairs each file may use: those whose definition it renames itself, and those it
 * imports (or re-exports) by a relative path from a diff file that may use them in turn. So a
 * rename in one file never licenses renaming a global, a built-in or another package's export
 * somewhere else.
 */
function licensed(live: readonly Candidate[]): Map<string, Set<string>> {
  const provides = new Map<string, Set<string>>();
  const add = (path: string, pair: string) =>
    provides.set(path, (provides.get(path) ?? new Set()).add(pair));
  for (const c of live) for (const pair of c.defines) add(c.file.path, pair);
  const files = [...new Map(live.map((c) => [c.file.path, c.file])).values()];
  for (let changed = true; changed; ) {
    changed = false;
    for (const file of files) {
      const imports = live.filter((c) => c.file === file).flatMap((c) => c.imports);
      for (const pair of new Set(imports.map((i) => i.pair))) {
        if (provides.get(file.path)?.has(pair)) continue;
        const resolved = imports
          .filter((i) => i.pair === pair)
          .every((i) =>
            files.some(
              (source) =>
                provides.get(source.path)?.has(pair) &&
                reaches(file.oldPath, i.from, source.oldPath) &&
                reaches(file.path, i.to, source.path),
            ),
          );
        if (resolved) {
          add(file.path, pair);
          changed = true;
        }
      }
    }
  }
  return provides;
}

type LocalWords = { readonly base: ReadonlySet<string>; readonly head: ReadonlySet<string> };

/** Every word in the known text of the diff's files, at each side. */
function localWords(diff: Diff, texts: FileTexts): LocalWords {
  const base = new Set<string>();
  const head = new Set<string>();
  for (const file of diff.files) {
    for (const word of (texts.base.get(file.oldPath) ?? '').match(WORDS) ?? []) base.add(word);
    for (const word of (texts.head.get(file.path) ?? '').match(WORDS) ?? []) head.add(word);
  }
  return { base, head };
}

const WORDS = /[A-Za-z_$][\w$]*/g;

const pairKey = (from: string, to: string): string => JSON.stringify([from, to]);

function candidates(diff: Diff, texts: FileTexts): Candidate[] {
  const found: Candidate[] = [];
  for (const file of diff.files) {
    if (!inLanguages(file, RENAMABLE)) continue;
    const sides = sidesOf(file, texts);
    if (sides?.base == null || sides.head === null) continue; // A new or deleted file isn't a rename.
    if (mayHaveMultilineStrings(sides.base) || mayHaveMultilineStrings(sides.head)) continue;
    for (const hunk of file.hunks) {
      if (!hasChanges(hunk)) continue;
      const candidate = readHunk(diff, file, hunk, sides.base, sides.head);
      if (candidate) found.push(candidate);
    }
  }
  return found;
}

type Numbered = { readonly text: string; readonly at: number };

/** Lines up each block's removed and added lines one to one. Null if any pair doesn't line up. */
function readHunk(
  diff: Diff,
  file: DiffFile,
  hunk: Hunk,
  base: readonly string[],
  head: readonly string[],
): Candidate | null {
  const idents: (readonly [string, string])[] = [];
  const paths: RenameChange[] = [];
  const defines: string[] = [];
  const imports: Import[] = [];
  const risky: string[] = [];
  const jsx = ['jsx', 'tsx'].includes(extension(file.path));
  const blocks: { removed: Numbered[]; added: Numbered[] }[] = [];
  let open = false;
  for (const line of hunk.lines) {
    if (line.kind === 'context') {
      open = false;
      continue;
    }
    if (!open) blocks.push({ removed: [], added: [] });
    open = true;
    const block = blocks.at(-1);
    if (line.kind === 'removed') block?.removed.push({ text: line.text, at: line.oldLine - 1 });
    else block?.added.push({ text: line.text, at: line.newLine - 1 });
  }
  for (const { removed, added } of blocks) {
    if (removed.length !== added.length) return null;
    for (const [i, before] of removed.entries()) {
      const after = added[i];
      if (after === undefined) return null;
      const a = tokenize(before.text, jsx);
      const b = tokenize(after.text, jsx);
      if (a === null || b === null || a.length !== b.length) return null;
      const oldLine: Line = { tokens: a, lines: base, at: before.at, jsx };
      const newLine: Line = { tokens: b, lines: head, at: after.at, jsx };
      for (const [k, x] of a.entries()) {
        const y = b[k];
        if (y === undefined) return null;
        if (x.kind === 'ident' && y.kind === 'ident') {
          idents.push([x.text, y.text]);
          if (x.text === y.text) continue;
          if (KEYWORDS.has(x.text) || KEYWORDS.has(y.text)) return null;
          // Case can carry meaning (Go exports and serializes capitalized names).
          if (isUpper(x.text) !== isUpper(y.text)) return null;
          const pair = pairKey(x.text, y.text);
          if (definesAt(a, k) && definesAt(b, k)) defines.push(pair);
          if (propertyAt(oldLine, k) || propertyAt(newLine, k)) risky.push(x.text);
          const from = importedFrom(base, before.at);
          const to = importedFrom(head, after.at);
          if (from === 'local' && to === 'local') continue;
          // An import from a package, or one this can't read, may name anything: never renamed.
          if (from === 'local' || to === 'local' || from === null || to === null) {
            risky.push(x.text);
          } else {
            imports.push({ pair, from, to });
          }
        } else if (x.kind === 'string' && y.kind === 'string' && x.quote === y.quote) {
          if (x.body === y.body) continue;
          if (!movedImport(diff, file, x.body, y.body)) return null;
          paths.push({ kind: 'import_path', from: x.body, to: y.body });
        } else if (x.kind !== y.kind || x.text !== y.text) {
          return null;
        }
      }
    }
  }
  return { hunk: hunk.id, file, idents, paths, defines, imports, risky };
}

type Token =
  | { readonly kind: 'ident'; readonly text: string }
  | {
      readonly kind: 'string';
      readonly text: string;
      readonly quote: string;
      readonly body: string;
    }
  | { readonly kind: 'other'; readonly text: string };

/**
 * Splits a line into identifiers, single-line string literals and single other characters
 * (spaces included, so spacing must match exactly). Numbers are one token, never an identifier.
 * A `//` comment is one token, so it must match exactly. Null for anything it can't read
 * safely: a quote left open, any non-ASCII character, or any other `/`, which could start a
 * regex whose body would look like code (in JSX files, `</` and `/>` are tags).
 */
export function tokenize(line: string, jsx = false): Token[] | null {
  if (/[^\x20-\x7e\t]/.test(line)) return null;
  const tokens: Token[] = [];
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    const word = /^[A-Za-z_$][\w$]*/.exec(rest) ?? /^[0-9][\w.]*/.exec(rest);
    const char = line[i] ?? '';
    if (word) {
      const text = word[0];
      tokens.push(/^[0-9]/.test(text) ? { kind: 'other', text } : { kind: 'ident', text });
      i += text.length;
    } else if (char === '"' || char === "'" || char === '`') {
      let end = i + 1;
      while (end < line.length && line[end] !== char) end += line[end] === '\\' ? 2 : 1;
      if (end >= line.length) return null;
      tokens.push({
        kind: 'string',
        text: line.slice(i, end + 1),
        quote: char,
        body: line.slice(i + 1, end),
      });
      i = end + 1;
    } else if (char === '/' && line[i + 1] === '/') {
      tokens.push({ kind: 'other', text: line.slice(i) });
      i = line.length;
    } else if (char === '/' && !(jsx && (line[i - 1] === '<' || line[i + 1] === '>'))) {
      return null;
    } else {
      tokens.push({ kind: 'other', text: char });
      i++;
    }
  }
  return tokens;
}

const isUpper = (name: string): boolean => /^[A-Z]/.test(name);
const isSpace = (token: Token | undefined): boolean =>
  token?.kind === 'other' && (token.text === ' ' || token.text === '\t');

function neighbor(tokens: readonly Token[], k: number, step: 1 | -1): number {
  let j = k + step;
  while (isSpace(tokens[j])) j += step;
  return j;
}

const textAt = (tokens: readonly Token[], j: number): string | undefined => tokens[j]?.text;

/** The identifier at k is being defined: `const k`, `function* k`, or a Go method `func (r T) k`. */
function definesAt(tokens: readonly Token[], k: number): boolean {
  let j = neighbor(tokens, k, -1);
  if (textAt(tokens, j) === '*') j = neighbor(tokens, j, -1); // function* name
  const before = tokens[j];
  if (before?.kind === 'ident' && DEFINERS.has(before.text)) return true;
  if (before?.text !== ')') return false;
  let depth = 0;
  for (; j >= 0; j--) {
    const text = textAt(tokens, j);
    if (text === ')') depth++;
    if (text === '(' && --depth === 0) break;
  }
  return textAt(tokens, neighbor(tokens, j, -1)) === 'func';
}

type Line = {
  readonly tokens: readonly Token[];
  readonly lines: readonly string[];
  readonly at: number;
  readonly jsx: boolean;
};

/** Words that may come before a method name in a class or object literal. */
const MODIFIERS: ReadonlySet<string> = new Set(
  'get set async static public private protected override readonly abstract *'.split(' '),
);

/**
 * The identifier at k sits where a rename could change data or what outside code calls, not
 * just a name. Unless it's being defined (`const k: T = …`), that's: after `.` (a property);
 * before `:` (an object key); before a single `=` after `{`, `,`, `(` or a word (a destructuring
 * default, keyword argument or JSX attribute); a method (`k() {` at the start of a line, after
 * `{`, `,` or a modifier like `get`); alone between `{`/`,` and `,`/`}` (shorthand, so a key),
 * except in an import or export list; and in JSX, right after a word or string (an attribute).
 */
function propertyAt({ tokens, lines, at, jsx }: Line, k: number): boolean {
  const before = neighbor(tokens, k, -1);
  let after = neighbor(tokens, k, 1);
  const prev = textAt(tokens, before) ?? '';
  if (prev === '.') return true;
  if (definesAt(tokens, k)) return false;
  if (textAt(tokens, after) === '?') after = neighbor(tokens, after, 1);
  const next = textAt(tokens, after) ?? '';
  const prevIsWord = tokens[before]?.kind === 'ident';
  if (next === ':' && textAt(tokens, after + 1) !== ':') return true;
  const assigns = next === '=' && !['=', '>'].includes(textAt(tokens, after + 1) ?? '');
  if (assigns && (['{', ',', '('].includes(prev) || prevIsWord)) return true;
  if (next === '(' || next === '<') {
    if (['{', ','].includes(prev) || MODIFIERS.has(prev)) return true;
    if (before < 0 && (lines[at] ?? '').trimEnd().endsWith('{')) return true;
  }
  if (jsx && ((prevIsWord && !KEYWORDS.has(prev)) || tokens[before]?.kind === 'string')) {
    return true;
  }
  const opens = before < 0 || ['{', ','].includes(prev);
  const closes = after >= tokens.length || ['}', ','].includes(next);
  return opens && closes && !inImportList(lines, at);
}

/**
 * Where line `at` (0-based) imports its names from: `'local'` if it isn't an import or export
 * list at all, the path for a relative JS or TS import (`from './x'`, single or multi-line), and
 * null for anything else (a package, a Python `from x import`, or a shape this can't read).
 */
function importedFrom(lines: readonly string[], at: number): string | 'local' | null {
  if (!inImportList(lines, at)) return 'local';
  for (let j = at; j < Math.min(lines.length, at + 100); j++) {
    const line = lines[j] ?? '';
    const from = /\bfrom\s*(['"])([^'"]*)\1\s*;?\s*$/.exec(line);
    if (from) {
      const path = from[2] ?? '';
      return path.startsWith('./') || path.startsWith('../') ? path : null;
    }
    if (j > at && !LIST_ITEM.test(line) && !/^\s*\}/.test(line)) break;
  }
  // An export list with no `from` re-exports local names.
  return /^\s*export\s+(?:type\s+)?\{[^}]*\}\s*;?\s*$/.test(lines[at] ?? '') ? 'local' : null;
}

const LIST_ITEM = /^\s*(?:type\s+)?[A-Za-z_$][\w$]*(?:\s+as\s+[A-Za-z_$][\w$]*)?\s*,?\s*$/;

/** Line `at` (0-based) is part of an import or export statement's name list. */
function inImportList(lines: readonly string[], at: number): boolean {
  const line = lines[at] ?? '';
  if (/^\s*(?:import\s|export\s+(?:type\s+)?\{|from\s+\S+\s+import\s)/.test(line)) return true;
  if (!LIST_ITEM.test(line)) return false;
  let j = at - 1;
  while (j >= 0 && LIST_ITEM.test(lines[j] ?? '')) j--;
  return /^\s*(?:import|export)\s+(?:type\s+)?\{\s*$/.test(lines[j] ?? '');
}

/**
 * An import path changed only because the diff moves the file it points at: the old path,
 * read from the importing file's old place, reaches the moved file's old path, and the new one,
 * from its new place, reaches the new path. Relative paths only; no index files or guessing.
 */
function movedImport(diff: Diff, importer: DiffFile, from: string, to: string): boolean {
  return diff.files.some(
    (moved) =>
      moved.oldPath !== moved.path &&
      reaches(importer.oldPath, from, moved.oldPath) &&
      reaches(importer.path, to, moved.path),
  );
}

function reaches(importer: string, specifier: string, target: string): boolean {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return false;
  const parts = dirName(importer).split('/').filter(Boolean);
  for (const segment of specifier.split('/')) {
    if (segment === '') return false;
    if (segment === '.') continue;
    if (segment === '..') {
      if (parts.pop() === undefined) return false;
    } else {
      parts.push(segment);
    }
  }
  const path = parts.join('/');
  if (path === target) return true;
  // `./thing` may name `thing.ts`, but only when it has no extension of its own.
  return (
    extension(path) === '' &&
    JS_LIKE.has(extension(target)) &&
    target.slice(0, target.lastIndexOf('.')) === path
  );
}
