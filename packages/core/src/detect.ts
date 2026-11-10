// Detectors for proven skips (P3–P8; renames are in rename.ts). Each one reads only the parsed
// diff and the data it is given, and proves nothing when unsure.
import type { NonEmpty } from './basics.ts';
import type { Diff, DiffFile, Hunk } from './diff.ts';
import { attributeFor, type LinguistAttribute } from './gitattributes.ts';
import {
  BLANK_FREE,
  changeBlocks,
  dirName,
  type FileSides,
  type FileTexts,
  fileName,
  type GeneratedRule,
  hasChanges,
  INDENT_FREE,
  inLanguages,
  isBlank,
  JS_LIKE,
  makeProof,
  mayHaveMultilineStrings,
  type Proof,
  SPACING_FREE,
  sidesOf,
} from './proof.ts';
import { proveRenames, type RenameOccurrences } from './rename.ts';

/** Everything the detectors may read, all of it plain data the caller fetched (P2). */
export type ProofInputs = {
  readonly texts: FileTexts;
  /** Every `.gitattributes` file at the base commit, by path. Never the PR's head (P8). */
  readonly baseGitattributes: ReadonlyMap<string, string>;
  /** Repository-wide lookups for rename candidates; see `renameLookups` (P9). */
  readonly renameOccurrences: RenameOccurrences;
};

/** Runs every detector. A line may be proven by several; the ledger keeps them all. */
export function proveSkips(diff: Diff, inputs: ProofInputs): Proof[] {
  return [
    ...proveWhitespace(diff, inputs.texts),
    ...proveBlankLines(diff, inputs.texts),
    ...proveImportsInNewFiles(diff, inputs.texts),
    ...proveReExports(diff, inputs.texts),
    ...proveLockfiles(diff),
    ...proveGenerated(diff, inputs.baseGitattributes),
    ...proveRenames(diff, inputs.texts, inputs.renameOccurrences),
  ];
}

/** Text both sides agree on, in a file where no string literal can span lines. */
function safeSides(file: DiffFile, texts: FileTexts): FileSides | null {
  const sides = sidesOf(file, texts);
  if (sides === null) return null;
  if (mayHaveMultilineStrings(sides.base) || mayHaveMultilineStrings(sides.head)) return null;
  return sides;
}

// ---------------------------------------------------------------------------------------------
// P3: whitespace only.

/** P3: hunks whose old and new lines are the same once whitespace is set aside, safely. */
export function proveWhitespace(diff: Diff, texts: FileTexts): Proof[] {
  const proofs: Proof[] = [];
  for (const file of diff.files) {
    if (!inLanguages(file, INDENT_FREE) || safeSides(file, texts) === null) continue;
    const spacingFree = inLanguages(file, SPACING_FREE);
    const blankFree = inLanguages(file, BLANK_FREE);
    for (const hunk of file.hunks) {
      if (hasChanges(hunk) && whitespaceOnly(hunk, spacingFree, blankFree)) {
        proofs.push(makeProof(diff, { kind: 'hunk', hunk: hunk.id }, { label: 'whitespace' }));
      }
    }
  }
  return proofs;
}

function whitespaceOnly(hunk: Hunk, spacingFree: boolean, blankFree: boolean): boolean {
  return changeBlocks(hunk).every(({ removed, added }) => {
    const before = blankFree ? removed.filter((l) => !isBlank(l)) : removed;
    const after = blankFree ? added.filter((l) => !isBlank(l)) : added;
    return (
      before.length === after.length &&
      before.every((line, i) => sameApartFromSpace(line, after[i] ?? '', spacingFree))
    );
  });
}

const trimSpace = (text: string): string => text.replace(/^[ \t]+|[ \t]+$/g, '');
/** Directives that must sit exactly where they are (Go build and compiler directives, cgo). */
const DIRECTIVE = /^\/\/(?:go:|line |export |\s*\+build)/;

function sameApartFromSpace(before: string, after: string, spacingFree: boolean): boolean {
  if (before === after) return true;
  const [a, b] = [trimSpace(before), trimSpace(after)];
  if (DIRECTIVE.test(a) || DIRECTIVE.test(b)) return false;
  if (a === b) return true; // Only indentation or trailing space changed.
  if (!spacingFree) return false;
  // Spacing inside a string, regex, comment or preprocessor line can matter, and so can any
  // character outside plain ASCII. Leave those lines alone.
  if (/["'`/#\\]|[^\x20-\x7e\t]/.test(a + b)) return false;
  return glued(a) === glued(b);
}

/**
 * Drops the spaces that can't matter: those between a word and punctuation. A space between two
 * word characters, or two punctuation characters, is kept as one, since removing it would join
 * tokens (`return x`, `a + +b`). `.` counts as a word character, so `1 .e3` never becomes `1.e3`.
 */
function glued(text: string): string {
  return text.replace(/[ \t]+/g, (space: string, at: number) => {
    const left = text[at - 1] ?? '';
    const right = text[at + space.length] ?? '';
    return isWordChar(left) === isWordChar(right) ? ' ' : '';
  });
}

const isWordChar = (char: string): boolean => /[A-Za-z0-9_$.]/.test(char);

// ---------------------------------------------------------------------------------------------
// P4: blank lines.

/** P4: changed blank lines, in a language where a blank line outside a string means nothing. */
export function proveBlankLines(diff: Diff, texts: FileTexts): Proof[] {
  const proofs: Proof[] = [];
  for (const file of diff.files) {
    if (!inLanguages(file, BLANK_FREE) || safeSides(file, texts) === null) continue;
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === 'context' || !isBlank(line.text)) continue;
        const ref =
          line.kind === 'added'
            ? { path: file.path, side: 'new' as const, line: line.newLine }
            : { path: file.oldPath, side: 'old' as const, line: line.oldLine };
        proofs.push(makeProof(diff, { kind: 'line', line: ref }, { label: 'blank_line' }));
      }
    }
  }
  return proofs;
}

// ---------------------------------------------------------------------------------------------
// P5: named and type-only imports in a new file.

const NAME = String.raw`[A-Za-z_$][\w$]*`;
const SPECIFIER = String.raw`(?:'[^'\\]*'|"[^"\\]*")`;
const IMPORT_ITEM = String.raw`(?:type\s+)?${NAME}(?:\s+as\s+${NAME})?`;
const IMPORT_LIST = String.raw`\{\s*${IMPORT_ITEM}(?:\s*,\s*${IMPORT_ITEM})*\s*,?\s*\}`;
/** `import { a, type B, c as d } from 'x'`, `import type { A } from 'x'`, `import type A from 'x'`. */
const NAMED_IMPORT = new RegExp(
  String.raw`^import\s+(?:type\s+(?:${IMPORT_LIST}|${NAME})|${IMPORT_LIST})\s*from\s*${SPECIFIER}\s*;?$`,
);
/** Any other complete import: default, namespace, side-effect. Recognized only to step over. */
const OTHER_IMPORT = new RegExp(
  String.raw`^import\s+(?:${SPECIFIER}|[^;'"]*?\s+from\s*${SPECIFIER})\s*;?$`,
);
const STATEMENT_END = new RegExp(String.raw`from\s*${SPECIFIER}\s*;?$`);

/**
 * P5: the named and type-only imports at the top of a newly added JS or TS file. The file's
 * opening is read statement by statement (comments, directives, imports); the first thing that
 * isn't one of those ends it. Side-effect, default and namespace imports are never proven.
 */
export function proveImportsInNewFiles(diff: Diff, texts: FileTexts): Proof[] {
  const proofs: Proof[] = [];
  for (const file of diff.files) {
    if (!inLanguages(file, JS_LIKE)) continue;
    const sides = sidesOf(file, texts);
    if (sides === null || sides.base !== null || sides.head === null) continue; // New files only.
    for (const line of namedImportLines(sides.head)) {
      const ref = { path: file.path, side: 'new' as const, line };
      proofs.push(makeProof(diff, { kind: 'line', line: ref }, { label: 'import_in_new_file' }));
    }
  }
  return proofs;
}

/** 1-based numbers of the lines holding named or type-only imports in the file's opening. */
function namedImportLines(lines: readonly string[]): number[] {
  const found: number[] = [];
  let i = lines[0]?.startsWith('#!') ? 1 : 0;
  while (i < lines.length) {
    const text = (lines[i] ?? '').trim();
    if (text === '' || text.startsWith('//') || /^(['"])use [a-z ]+\1;?$/.test(text)) {
      i++;
    } else if (text.startsWith('/*')) {
      const end = lines.findIndex((l, j) => j >= i && l.includes('*/'));
      // The comment must close at the end of a line, with nothing after it.
      if (end === -1 || !(lines[end] ?? '').trimEnd().endsWith('*/')) break;
      if ((lines[end] ?? '').indexOf('*/') !== (lines[end] ?? '').trimEnd().length - 2) break;
      i = end + 1;
    } else if (/^import\b/.test(text)) {
      const end = statementEnd(lines, i);
      if (end === null) break;
      const statement = lines
        .slice(i, end + 1)
        .map((l) => l.trim())
        .join(' ');
      if (NAMED_IMPORT.test(statement)) {
        for (let n = i; n <= end; n++) found.push(n + 1);
      } else if (!OTHER_IMPORT.test(statement)) {
        break;
      }
      i = end + 1;
    } else {
      break;
    }
  }
  return found;
}

/** The index of the line that ends the import starting at `start`, within a short window. */
function statementEnd(lines: readonly string[], start: number): number | null {
  const first = (lines[start] ?? '').trim();
  if (new RegExp(String.raw`^import\s+${SPECIFIER}\s*;?$`).test(first)) return start;
  for (let i = start; i < Math.min(lines.length, start + 100); i++) {
    if (STATEMENT_END.test((lines[i] ?? '').trim())) return i;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// P6: re-exports.

const EXPORT_NAME = `(?:${NAME}|default)`;
const EXPORT_ITEM = String.raw`(type\s+)?(${EXPORT_NAME})(?:\s+as\s+(${EXPORT_NAME}))?`;
const EXPORT_NAMED = new RegExp(
  String.raw`^export\s+(type\s+)?\{\s*((?:type\s+)?${EXPORT_NAME}(?:\s+as\s+${EXPORT_NAME})?(?:\s*,\s*(?:type\s+)?${EXPORT_NAME}(?:\s+as\s+${EXPORT_NAME})?)*)\s*,?\s*\}\s*from\s*(${SPECIFIER})\s*;?$`,
);
const EXPORT_STAR = new RegExp(
  String.raw`^export\s+(type\s+)?\*(?:\s+as\s+(${NAME}))?\s+from\s*(${SPECIFIER})\s*;?$`,
);

/** A barrel: its modules in load order, each public name's source, and its bare `export *` lines. */
type Barrel = {
  readonly specifiers: ReadonlySet<string>;
  readonly names: ReadonlyMap<string, string>;
  readonly stars: ReadonlySet<string>;
};

/**
 * Reads a file made only of single-line re-exports, `//` comments and blank lines. Null if any
 * line is anything else, or a public name is exported twice.
 */
function readBarrel(lines: readonly string[]): Barrel | null {
  const specifiers = new Set<string>();
  const names = new Map<string, string>();
  const stars = new Set<string>();
  const bind = (name: string, binding: string): boolean => {
    if (names.has(name)) return false;
    names.set(name, binding);
    return true;
  };
  for (const raw of lines) {
    const text = raw.trim();
    if (text === '' || text.startsWith('//')) continue;
    const star = EXPORT_STAR.exec(text);
    const named = EXPORT_NAMED.exec(text);
    if (star) {
      const [, typeOnly = '', alias, spec = ''] = star;
      specifiers.add(spec.slice(1, -1));
      const binding = JSON.stringify([spec.slice(1, -1), '*', typeOnly !== '']);
      if (alias === undefined) stars.add(binding);
      else if (!bind(alias, binding)) return null;
    } else if (named) {
      const [, typeOnly = '', list = '', spec = ''] = named;
      specifiers.add(spec.slice(1, -1));
      const items = list.split(',').map((item) => item.trim());
      for (const item of items.filter((item) => item !== '')) {
        const parts = new RegExp(`^${EXPORT_ITEM}$`).exec(item);
        if (!parts) return null;
        const [, itemType = '', imported = '', alias] = parts;
        const binding = JSON.stringify([spec.slice(1, -1), imported, typeOnly + itemType !== '']);
        if (!bind(alias ?? imported, binding)) return null;
      }
    } else {
      return null;
    }
  }
  return { specifiers, names, stars };
}

/**
 * P6: a JS or TS barrel file whose change can't change what any existing name means. Both
 * versions must be pure barrels. A new or deleted barrel is proven. A changed one must load the
 * same modules, keep its `export *` lines, and keep every existing name bound to the same source;
 * it may add names, unless an `export *` could be shadowed by them.
 */
export function proveReExports(diff: Diff, texts: FileTexts): Proof[] {
  const proofs: Proof[] = [];
  for (const file of diff.files) {
    if (!inLanguages(file, JS_LIKE) || !file.hunks.some(hasChanges)) continue;
    const sides = sidesOf(file, texts);
    if (sides === null) continue;
    const before = sides.base === null ? null : readBarrel(sides.base);
    const after = sides.head === null ? null : readBarrel(sides.head);
    if ((sides.base !== null && before === null) || (sides.head !== null && after === null)) {
      continue;
    }
    if (before === null || after === null || unchangedMeaning(before, after)) {
      proofs.push(makeProof(diff, { kind: 'file', path: file.path }, { label: 're_export' }));
    }
  }
  return proofs;
}

function unchangedMeaning(before: Barrel, after: Barrel): boolean {
  // Modules evaluate in the order they first appear, so that order must hold too.
  const order = (barrel: Barrel) => JSON.stringify([...barrel.specifiers]);
  if (order(before) !== order(after) || !sameSet(before.stars, after.stars)) {
    return false;
  }
  for (const [name, binding] of before.names) {
    if (after.names.get(name) !== binding) return false; // Removed or rebound.
  }
  const added = [...after.names.keys()].some((name) => !before.names.has(name));
  return !(added && after.stars.size > 0);
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  a.size === b.size && [...a].every((x) => b.has(x));

// ---------------------------------------------------------------------------------------------
// P7: lockfiles.

type LockKind = { readonly manifests: readonly string[]; readonly nested: boolean };
const npm: LockKind = { manifests: ['package.json'], nested: true };
const LOCKFILES: ReadonlyMap<string, LockKind> = new Map([
  ['pnpm-lock.yaml', { manifests: ['package.json', 'pnpm-workspace.yaml'], nested: true }],
  ['package-lock.json', npm],
  ['npm-shrinkwrap.json', npm],
  ['yarn.lock', npm],
  ['bun.lock', npm],
  ['Cargo.lock', { manifests: ['Cargo.toml'], nested: true }],
  ['poetry.lock', { manifests: ['pyproject.toml'], nested: false }],
  ['uv.lock', { manifests: ['pyproject.toml'], nested: true }],
  ['Pipfile.lock', { manifests: ['Pipfile'], nested: false }],
  ['go.sum', { manifests: ['go.mod'], nested: false }],
  ['Gemfile.lock', { manifests: ['Gemfile'], nested: false }],
  ['composer.lock', { manifests: ['composer.json'], nested: false }],
  ['mix.lock', { manifests: ['mix.exs'], nested: false }],
  ['pubspec.lock', { manifests: ['pubspec.yaml'], nested: false }],
  ['Podfile.lock', { manifests: ['Podfile'], nested: false }],
  ['flake.lock', { manifests: ['flake.nix'], nested: false }],
  ['Package.resolved', { manifests: ['Package.swift'], nested: false }],
]);

/** Package sources a lockfile may point at without suspicion. Anything else stays unproven. */
const REGISTRIES = new Set([
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'registry.npmmirror.com',
  'github.com/rust-lang/crates.io-index',
  'index.crates.io',
  'static.crates.io',
  'files.pythonhosted.org',
  'pypi.org',
  'rubygems.org',
  'repo.packagist.org',
  'hex.pm',
  'pub.dev',
  'cdn.cocoapods.org',
]);

/**
 * P7: lockfiles, by file name, when a manifest beside them (or, for workspaces, below them)
 * changed too. The evidence names those manifests; the ledger checks one is on the route (L3).
 * Never proven: a lockfile that was created, deleted or moved, or one whose changed lines point
 * at a source outside the known registries (a git URL, a tarball, a local file).
 */
export function proveLockfiles(diff: Diff): Proof[] {
  const proofs: Proof[] = [];
  for (const file of diff.files) {
    const kind = LOCKFILES.get(fileName(file.path));
    if (kind === undefined || file.path !== file.oldPath) continue;
    const lines = file.hunks.flatMap((h) => h.lines);
    const changed = lines.filter((l) => l.kind !== 'context');
    // No context and one-sided: probably the whole file was created or deleted.
    if (changed.length === 0 || !lines.some((l) => l.kind === 'context')) continue;
    if (changed.some((l) => unknownSource(l.text))) continue;
    const dir = dirName(file.path);
    const manifests = diff.files
      .filter((other) => other !== file && other.hunks.some(hasChanges))
      .map((other) => other.path)
      .filter((path) => {
        if (!kind.manifests.includes(fileName(path))) return false;
        const at = dirName(path);
        return at === dir || (kind.nested && (dir === '' || at.startsWith(`${dir}/`)));
      });
    const [first, ...rest] = manifests;
    if (first === undefined) continue;
    const named: NonEmpty<string> = [first, ...rest];
    proofs.push(
      makeProof(diff, { kind: 'file', path: file.path }, { label: 'lockfile', manifests: named }),
    );
  }
  return proofs;
}

function unknownSource(text: string): boolean {
  if (/\b(?:git\+|git@|github:|gitlab:|bitbucket:|file:|tarball)/i.test(text)) return true;
  for (const match of text.matchAll(/[a-z][a-z0-9+.-]*:\/\/([^\s"'`,;)]+)/gi)) {
    const where = (match[1] ?? '').toLowerCase();
    const known = [...REGISTRIES].some((r) => where === r || where.startsWith(`${r}/`));
    if (!known) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// P8: generated and vendored files.

const KNOWN: readonly { label: 'generated' | 'vendored'; pattern: string; regex: RegExp }[] = [
  { label: 'vendored', pattern: 'vendor/', regex: /(^|\/)vendor\// },
  { label: 'vendored', pattern: 'node_modules/', regex: /(^|\/)node_modules\// },
  { label: 'vendored', pattern: 'third_party/', regex: /(^|\/)third_party\// },
  { label: 'generated', pattern: 'dist/', regex: /(^|\/)dist\// },
  { label: 'generated', pattern: '__generated__/', regex: /(^|\/)__generated__\// },
  { label: 'generated', pattern: '*.min.js', regex: /\.min\.js$/ },
  { label: 'generated', pattern: '*.min.css', regex: /\.min\.css$/ },
  { label: 'generated', pattern: '*.js.map', regex: /\.js\.map$/ },
  { label: 'generated', pattern: '*.pb.go', regex: /\.pb\.go$/ },
  { label: 'generated', pattern: '*_pb2.py', regex: /_pb2\.py$/ },
];

/**
 * P8: files that base's `.gitattributes` marks `linguist-generated` or `linguist-vendored`, or
 * that already existed at base and match the known patterns, unless base's `.gitattributes`
 * unsets the attribute. Only base text counts: a PR can't mark its own files, or vouch for a new
 * file by choosing its folder. A moved file must qualify at both paths.
 */
export function proveGenerated(
  diff: Diff,
  baseGitattributes: ReadonlyMap<string, string>,
): Proof[] {
  const proofs: Proof[] = [];
  for (const file of diff.files) {
    if (!file.hunks.some(hasChanges)) continue;
    for (const label of ['generated', 'vendored'] as const) {
      const attribute: LinguistAttribute = `linguist-${label}`;
      const rule = ruleFor(baseGitattributes, attribute, label, file.path, existedAtBase(file));
      if (rule === null) continue;
      if (
        file.oldPath !== file.path &&
        ruleFor(baseGitattributes, attribute, label, file.oldPath, true) === null
      ) {
        continue;
      }
      proofs.push(makeProof(diff, { kind: 'file', path: file.path }, { label, rule }));
      break;
    }
  }
  return proofs;
}

/** Any removed or context line means the file existed at base. Only added lines: maybe not. */
const existedAtBase = (file: DiffFile): boolean =>
  file.hunks.some((hunk) => hunk.lines.some((line) => line.kind !== 'added'));

function ruleFor(
  gitattributes: ReadonlyMap<string, string>,
  attribute: LinguistAttribute,
  label: 'generated' | 'vendored',
  path: string,
  existed: boolean,
): GeneratedRule | null {
  const match = attributeFor(gitattributes, attribute, path);
  if (match === 'unusable' || match?.value === false) return null;
  if (match?.value === true) {
    return { source: 'gitattributes', file: match.file, line: match.line, pattern: match.pattern };
  }
  // The PR chooses where a new file goes, so a known folder only vouches for files already there.
  if (!existed) return null;
  const known = KNOWN.find((k) => k.label === label && k.regex.test(path));
  return known ? { source: 'known', pattern: known.pattern } : null;
}
