// P9: renames, however sweeping. A hunk is a proven rename when one consistent mapping of old
// identifiers to new ones, plus import paths that the diff's own file moves explain, turns every
// removed line into its added line exactly.
//
// It works by allowlist: JS and TS only (not JSX, whose text looks like code), top-level
// definitions only, and each renamed word must
// sit in a position known to be safe (a definition, a plain import item, or a reference after
// an operator). Anything else, however harmless it looks, leaves the hunk unproven.
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

/** JS and TS words that are syntax or built-in values. Never mapped. */
const KEYWORDS: ReadonlySet<string> = new Set(
  `abstract any as async await bigint boolean break case catch class const constructor continue
  debugger declare default delete do else enum export extends false finally for from function get
  global if implements import in infer instanceof interface is keyof let module namespace never new
  null number object of override package private protected public readonly require return
  satisfies set static string super switch symbol this throw true try type typeof undefined unique
  unknown var void while with yield arguments eval`.split(/\s+/),
);

/** Words after which a renamed name is a plain reference to a value or type. */
const SAFE_AFTER_WORDS: ReadonlySet<string> = new Set(
  'return new extends implements await typeof keyof instanceof in of yield throw void delete as satisfies default'.split(
    ' ',
  ),
);
/** Characters after which a renamed name is a plain reference (`,` is checked separately). */
const SAFE_AFTER_CHARS: ReadonlySet<string> = new Set([
  '=',
  '(',
  '[',
  ':',
  '?',
  '!',
  '<',
  '>',
  '|',
  '&',
  '+',
  '-',
  '%',
  '^',
  '~',
]);

/** A definition at column 0, optionally exported. `declare` binds nothing, so it never counts. */
const DEFINITION =
  /^(export\s+(?:default\s+)?)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)\b/;

/** Asks which repository-wide lookups `proveRenames` needs (P9). */
export function renameLookups(diff: Diff, texts: FileTexts): RenameLookups {
  const renames = solve(diff, candidates(diff, texts), localWords(diff, texts), null).flatMap(
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
  const live = solve(diff, candidates(diff, texts), localWords(diff, texts), occurrences);
  for (const candidate of live) {
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

/** A renamed name imported or re-exported by a relative path: `import { a } from './x'`. */
type Import = { readonly pair: string; readonly from: string; readonly to: string };

/** One hunk that a mapping could explain, and what the mapping would need to hold. */
type Candidate = {
  readonly hunk: HunkId;
  readonly file: DiffFile;
  /** The file has an `export *` at base or head, so what it exports can't be read off its lines. */
  readonly starExports: boolean;
  /** Every identifier pair the hunk lines up, identity pairs included. */
  readonly idents: readonly (readonly [string, string])[];
  readonly paths: readonly RenameChange[];
  /** Renamed pairs whose top-level definition this hunk renames, and whether it's exported. */
  readonly defines: readonly { readonly pair: string; readonly exported: boolean }[];
  readonly imports: readonly Import[];
  /** Old names this hunk renames somewhere outside the safe positions. */
  readonly unsafe: readonly string[];
};

/**
 * Keeps the candidates whose mapping holds across the whole PR. The mapping must be one to one,
 * map no name both to itself and to another, and for each real rename: sit only in safe
 * positions; be licensed in every file that uses it (see `licensed`); and leave the old name
 * nowhere at head and find the new name nowhere at base, in the diff's files and (when given)
 * the whole repository. Dropping a hunk can break another's license, so this repeats until
 * nothing changes.
 */
function solve(
  diff: Diff,
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
    const { local } = licensed(diff, live);
    const unsafe = new Set(live.flatMap((c) => c.unsafe));
    const bad = new Set<string>();
    for (const [from, to] of targets) {
      if (to.size > 1) bad.add(from);
    }
    for (const from of sources.values()) {
      if (from.size > 1) for (const name of from) bad.add(name);
    }
    for (const c of live) {
      for (const [from, to] of c.idents) {
        if (from === to) continue;
        // The diff's own files are checked here too, so a wrong answer from the caller can't
        // prove a swap (a → b, b → a) or a merge into a name that already exists.
        const fresh =
          !words.base.has(to) &&
          !words.head.has(from) &&
          (occurrences === null ||
            (occurrences.base.get(to)?.length === 0 && occurrences.head.get(from)?.length === 0));
        const allowed = local.get(c.file.path)?.has(pairKey(from, to)) ?? false;
        if (!fresh || !allowed || unsafe.has(from)) bad.add(from);
      }
    }
    const next = live.filter((c) => c.idents.every(([from]) => !bad.has(from)));
    if (next.length === live.length) return next;
    live = next;
  }
}

/**
 * Which renamed pairs each file may use (`local`) and offer to importers (`exported`). A file may
 * use a pair whose top-level definition it renames, or one it imports by a relative path from a
 * diff file that exports it. It exports a pair whose definition it renames with `export`, or one
 * it re-exports by name, and only when it has no `export *`, which could supply the name instead.
 * So a rename never reaches a global, a built-in, or another package's export.
 */
function licensed(
  diff: Diff,
  live: readonly Candidate[],
): { local: Map<string, Set<string>>; exported: Map<string, Set<string>> } {
  const local = new Map<string, Set<string>>();
  const exported = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, path: string, pair: string) =>
    map.set(path, (map.get(path) ?? new Set()).add(pair));
  const starred = new Set(live.filter((c) => c.starExports).map((c) => c.file.path));
  for (const c of live) {
    for (const { pair, exported: isExported } of c.defines) {
      add(local, c.file.path, pair);
      if (isExported && !starred.has(c.file.path)) add(exported, c.file.path, pair);
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const file of new Set(live.map((c) => c.file))) {
      const imports = live.filter((c) => c.file === file).flatMap((c) => c.imports);
      for (const pair of new Set(imports.map((i) => i.pair))) {
        if (local.get(file.path)?.has(pair)) continue;
        const resolved = imports
          .filter((i) => i.pair === pair)
          .every((i) =>
            diff.files.some(
              (source) =>
                exported.get(source.path)?.has(pair) &&
                reaches(file.oldPath, i.from, source.oldPath) &&
                reaches(file.path, i.to, source.path),
            ),
          );
        if (!resolved) continue;
        add(local, file.path, pair);
        if (!starred.has(file.path)) add(exported, file.path, pair);
        changed = true;
      }
    }
  }
  return { local, exported };
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

/** JS and TS without JSX. */
const RENAMABLE: ReadonlySet<string> = new Set([...JS_LIKE].filter((ext) => !ext.endsWith('x')));

const STAR_EXPORT = /^\s*export\s+(?:type\s+)?\*\s*from/;

function candidates(diff: Diff, texts: FileTexts): Candidate[] {
  const found: Candidate[] = [];
  for (const file of diff.files) {
    if (!inLanguages(file, RENAMABLE)) continue;
    const sides = sidesOf(file, texts);
    if (sides?.base == null || sides.head === null) continue; // A new or deleted file isn't a rename.
    if (mayHaveMultilineStrings(sides.base) || mayHaveMultilineStrings(sides.head)) continue;
    const starExports = [...sides.base, ...sides.head].some((line) => STAR_EXPORT.test(line));
    // `with` turns a plain reference into a property lookup.
    if ([...sides.base, ...sides.head].some((line) => /\bwith\s*\(/.test(line))) continue;
    for (const hunk of file.hunks) {
      if (!hasChanges(hunk)) continue;
      const before = readSource(sides.base);
      const after = readSource(sides.head);
      const candidate = readHunk(diff, file, hunk, before, after, starExports);
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
  base: Source,
  head: Source,
  starExports: boolean,
): Candidate | null {
  const idents: (readonly [string, string])[] = [];
  const paths: RenameChange[] = [];
  const defines: { pair: string; exported: boolean }[] = [];
  const imports: Import[] = [];
  const unsafe: string[] = [];
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
      const a = tokenize(before.text);
      const b = tokenize(after.text);
      if (a === null || b === null || a.length !== b.length) return null;
      for (const [k, x] of a.entries()) {
        const y = b[k];
        if (y === undefined) return null;
        if (x.kind === 'ident' && y.kind === 'ident') {
          idents.push([x.text, y.text]);
          if (x.text === y.text) continue;
          if (KEYWORDS.has(x.text) || KEYWORDS.has(y.text)) return null;
          if (isUpper(x.text) !== isUpper(y.text)) return null;
          const pair = pairKey(x.text, y.text);
          const was = role(base, before.at, a, k);
          const is = role(head, after.at, b, k);
          if (was.kind !== is.kind) {
            unsafe.push(x.text);
          } else if (was.kind === 'definition' && is.kind === 'definition') {
            defines.push({ pair, exported: was.exported && is.exported });
          } else if (was.kind === 'import' && is.kind === 'import') {
            // A local export list (`export { a }`) is a plain use; one from a path is an import.
            if ((was.from === null) !== (is.from === null)) unsafe.push(x.text);
            else if (was.from !== null && is.from !== null) {
              imports.push({ pair, from: was.from, to: is.from });
            }
          } else if (was.kind === 'unsafe') {
            unsafe.push(x.text);
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
  return { hunk: hunk.id, file, starExports, idents, paths, defines, imports, unsafe };
}

type Role =
  | { readonly kind: 'definition'; readonly exported: boolean }
  /** `from` is the relative path it comes from, or null for a local export list. */
  | { readonly kind: 'import'; readonly from: string | null }
  | { readonly kind: 'reference' }
  | { readonly kind: 'unsafe' };

/**
 * What the renamed word at token k of line `at` (0-based) is doing. Only three roles are safe:
 * the name of a top-level definition; a plain item (no `as`) in an import or export list, read
 * as a whole statement; and a reference right after an operator or a few keywords. Everything
 * else, including any word at the start of a line, is unsafe.
 */
function role(
  { lines, comments, topLevel }: Source,
  at: number,
  tokens: readonly Token[],
  k: number,
): Role {
  // Nothing in a block comment counts, so a commented-out definition licenses nothing.
  if (comments.has(at)) return { kind: 'unsafe' };
  const line = lines[at] ?? '';
  const name = tokens[k]?.text ?? '';
  const definition = DEFINITION.exec(line);
  const before = neighbor(tokens, k, -1);
  const prevToken = tokens[before];
  if (definition && definition[2] === name && topLevel.has(at) && prevToken?.kind === 'ident') {
    // The name right after the defining keyword, not a later word on the line.
    if (
      ['function', 'class', 'const', 'let', 'var', 'type', 'interface', 'enum'].includes(
        prevToken.text,
      )
    ) {
      return { kind: 'definition', exported: definition[1] !== undefined };
    }
  }
  const statement = importStatement(lines, at, comments);
  if (statement !== null) {
    if (!statement.items.includes(name)) return { kind: 'unsafe' };
    if (statement.from === null) return { kind: 'import', from: null };
    const relative = statement.from.startsWith('./') || statement.from.startsWith('../');
    return relative ? { kind: 'import', from: statement.from } : { kind: 'unsafe' };
  }
  const after = neighbor(tokens, k, 1);
  const prev = prevToken?.text ?? '';
  const next = tokens[after]?.text ?? '';
  const nextNext = tokens[neighbor(tokens, after, 1)]?.text ?? '';
  // Never a key, a parameter default, a keyword argument or an attribute.
  if (next === ':' || (next === '?' && nextNext === ':')) return { kind: 'unsafe' };
  if (next === '=' && tokens[after + 1]?.text !== '=' && tokens[after + 1]?.text !== '>') {
    return { kind: 'unsafe' };
  }
  if (prevToken?.kind === 'ident' && SAFE_AFTER_WORDS.has(prev)) return { kind: 'reference' };
  if (prevToken?.kind === 'other' && SAFE_AFTER_CHARS.has(prev)) return { kind: 'reference' };
  // A call's or array's comma, with its bracket on this line: an object's could be a key.
  if (prev === ',' && ['(', '['].includes(enclosing(tokens, before))) return { kind: 'reference' };
  return { kind: 'unsafe' };
}

/** The nearest unclosed bracket left of token j on the same line, or '' if there is none. */
function enclosing(tokens: readonly Token[], j: number): string {
  let depth = 0;
  for (let i = j - 1; i >= 0; i--) {
    const text = tokens[i]?.text ?? '';
    if (')]}'.includes(text) && text !== '') depth++;
    else if ('([{'.includes(text) && text !== '') {
      if (depth === 0) return text;
      depth--;
    }
  }
  return '';
}

const NAME = String.raw`[A-Za-z_$][\w$]*`;
const ITEM = String.raw`(?:type\s+)?${NAME}(?:\s+as\s+${NAME})?`;
const LIST_STATEMENT = new RegExp(
  String.raw`^(import|export)\s+(?:type\s+)?\{\s*(${ITEM}(?:\s*,\s*${ITEM})*)\s*,?\s*\}\s*(?:from\s*(?:'([^'\\]*)'|"([^"\\]*)"))?\s*;?$`,
);

/**
 * The import or export list statement that line `at` belongs to, read whole from its first
 * line (`import` or `export` at column 0) to its last. Its items are the plain names in it;
 * an aliased item (`a as b`) is not plain. Null when the line isn't part of such a statement,
 * or the statement holds anything else, a comment included.
 */
function importStatement(
  lines: readonly string[],
  at: number,
  comments: ReadonlySet<number>,
): { items: readonly string[]; from: string | null } | null {
  let start = at;
  while (start > 0 && start > at - 200 && !/^(?:import|export)\b/.test(lines[start] ?? '')) start--;
  if (!/^(?:import|export)\s+(?:type\s+)?\{/.test(lines[start] ?? '')) return null;
  const end = lines.findIndex((line, i) => i >= start && line.includes('}'));
  if (end < at) return null;
  for (let i = start; i <= end; i++) if (comments.has(i)) return null;
  const text = lines
    .slice(start, end + 1)
    .map((l) => l.trim())
    .join(' ');
  const match = LIST_STATEMENT.exec(text);
  if (!match) return null;
  const [, keyword, list = '', single, double] = match;
  const from = single ?? double ?? null;
  if (keyword === 'import' && from === null) return null;
  const items = list
    .split(',')
    .map((item) => item.trim().replace(/^type\s+/, ''))
    .filter((item) => /^[A-Za-z_$][\w$]*$/.test(item));
  return { items, from };
}

/** A file's lines, which of them a block comment touches, and which start at the top level. */
type Source = {
  readonly lines: readonly string[];
  readonly comments: ReadonlySet<number>;
  readonly topLevel: ReadonlySet<number>;
};

/**
 * Finds block comments and bracket depth in one left-to-right scan that also steps over strings
 * and `//` comments, so a `/*` or a bracket inside either never counts. If anything can't be read
 * that way (a quote left open, any other `/`, which could be a regex or a division), or the
 * brackets don't balance, no line counts as top level: the PR controls indentation, so column 0
 * alone proves nothing.
 */
function readSource(lines: readonly string[]): Source {
  const comments = new Set<number>();
  const topLevel = new Set<number>();
  let inComment = false;
  let depth = 0;
  let readable = true;
  for (const [n, line] of lines.entries()) {
    if (depth === 0 && !inComment) topLevel.add(n);
    if (inComment) comments.add(n);
    // Script code also treats `<!--` and `-->` as line comments (Annex B). Don't guess where.
    if (line.includes('<!--') || line.includes('-->')) readable = false;
    let i = 0;
    while (i < line.length) {
      const char = line[i] ?? '';
      if (inComment) {
        const end = line.indexOf('*/', i);
        if (end === -1) break;
        inComment = false;
        i = end + 2;
      } else if (char === '/' && line[i + 1] === '/') {
        break;
      } else if (char === '/' && line[i + 1] === '*') {
        comments.add(n);
        inComment = true;
        i += 2;
      } else if (char === '/') {
        readable = false;
        break;
      } else if (char === '"' || char === "'" || char === '`') {
        let end = i + 1;
        while (end < line.length && line[end] !== char) end += line[end] === '\\' ? 2 : 1;
        if (end >= line.length) readable = false;
        i = end + 1;
      } else {
        if ('{(['.includes(char)) depth++;
        if ('})]'.includes(char)) depth--;
        i++;
      }
    }
  }
  const balanced = readable && depth === 0 && !inComment;
  return { lines, comments, topLevel: balanced ? topLevel : new Set() };
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
 * regex whose body would look like code.
 */
export function tokenize(line: string): Token[] | null {
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
    } else if (char === '/') {
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
