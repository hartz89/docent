// What one source file defines, imports and exports, read with Tree-sitter (N1). Search-based
// navigation, the approach GitHub's code view takes: parsing only, so no project code ever runs.
//
// Core takes no runtime dependency on Tree-sitter. The caller passes in the `web-tree-sitter`
// module and the grammar files, and only its types are imported here.
import type * as TreeSitter from 'web-tree-sitter';

export type SourceLanguage = 'typescript' | 'tsx' | 'javascript' | 'python' | 'go';

/** The language a path is parsed as, by its extension, or null when it isn't indexed. */
export function sourceLanguage(path: string): SourceLanguage | null {
  const dot = path.lastIndexOf('.');
  if (dot <= path.lastIndexOf('/')) return null;
  switch (path.slice(dot + 1)) {
    case 'ts':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'tsx':
      return 'tsx';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'py':
    case 'pyi':
      return 'python';
    case 'go':
      return 'go';
    default:
      return null;
  }
}

export const DEFINITION_KINDS = [
  'function',
  'method',
  'class',
  'interface',
  'type',
  'enum',
  'module',
  'constant',
] as const;
export type DefinitionKind = (typeof DEFINITION_KINDS)[number];

/**
 * A named definition. `line` is the 1-based line of its name, and `endLine` the last line of the
 * definition it names. `topLevel` is false inside a class, function or block, where it can't be
 * what a module exports.
 */
export type Definition = {
  name: string;
  kind: DefinitionKind;
  line: number;
  endLine: number;
  topLevel: boolean;
};

/**
 * A name an import statement brings into the file. `imported` is the export it names:
 * `'default'` for a default import, `'*'` for the whole module (`import * as ns`). `line` is the
 * line the local name is on.
 */
export type ImportBinding = { local: string; spec: string; imported: string; line: number };

/**
 * One name a file exports. A `local` export points at a name in the file itself, or at nothing
 * for an anonymous `export default`. A `from` export passes on another module's export, with
 * `imported` as `'*'` for `export * as name from`.
 */
export type Export =
  | { kind: 'local'; name: string; line: number; local: string | null }
  | { kind: 'from'; name: string; line: number; spec: string; imported: string };

/**
 * Every line where one name is used as an identifier in a file: called, read, typed, imported or
 * defined. Never in a comment or a string. `lines` ascend, each once.
 */
export type Use = { name: string; lines: number[] };

export type FileSymbols = {
  language: SourceLanguage;
  definitions: Definition[];
  imports: ImportBinding[];
  exports: Export[];
  /** Specifiers of `export * from '…'`. */
  exportsAll: string[];
  /** Where each name is used, for find references. */
  uses: Use[];
};

/**
 * One language, ready to parse: a parser set to its grammar, its tag query, and the node types
 * that are names in it.
 */
export type Grammar = {
  language: SourceLanguage;
  parser: TreeSitter.Parser;
  tags: TreeSitter.Query;
  names: ReadonlySet<number>;
};
export type Grammars = ReadonlyMap<SourceLanguage, Grammar>;

/**
 * A file inside a grammar's npm package. `packages` is a resolution chain: the first is resolved
 * from the caller, and each next one from the package before it, so TypeScript reads the
 * JavaScript queries of the exact `tree-sitter-javascript` it was built against.
 */
export type GrammarFile = { packages: readonly [string, ...string[]]; path: string };

const TYPESCRIPT_TAGS: GrammarFile[] = [
  { packages: ['tree-sitter-typescript'], path: 'queries/tags.scm' },
  { packages: ['tree-sitter-typescript', 'tree-sitter-javascript'], path: 'queries/tags.scm' },
];

/** Definitions the grammars' own `tags.scm` leave out: type aliases, enums, top-level consts. */
const JS_EXTRAS = `
(program (lexical_declaration (variable_declarator name: (identifier) @name) @definition.constant))
(program (variable_declaration (variable_declarator name: (identifier) @name) @definition.constant))
(program (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name) @definition.constant)))
(program (export_statement declaration: (variable_declaration (variable_declarator name: (identifier) @name) @definition.constant)))
`;
const TS_EXTRAS = `${JS_EXTRAS}
(type_alias_declaration name: (type_identifier) @name) @definition.type
(enum_declaration name: (identifier) @name) @definition.enum
(internal_module name: (identifier) @name) @definition.module
`;
const GO_EXTRAS = `
(const_spec name: (identifier) @name) @definition.constant
(source_file (var_declaration (var_spec name: (identifier) @name) @definition.constant))
`;

/** Every file the grammars are loaded from. The npm package carries just these (scripts/pack.ts). */
export const GRAMMAR_FILES: Readonly<
  Record<SourceLanguage, { wasm: GrammarFile; tags: GrammarFile[]; extras: string }>
> = {
  typescript: {
    wasm: { packages: ['tree-sitter-typescript'], path: 'tree-sitter-typescript.wasm' },
    tags: TYPESCRIPT_TAGS,
    extras: TS_EXTRAS,
  },
  tsx: {
    wasm: { packages: ['tree-sitter-typescript'], path: 'tree-sitter-tsx.wasm' },
    tags: TYPESCRIPT_TAGS,
    extras: TS_EXTRAS,
  },
  javascript: {
    wasm: { packages: ['tree-sitter-javascript'], path: 'tree-sitter-javascript.wasm' },
    tags: [{ packages: ['tree-sitter-javascript'], path: 'queries/tags.scm' }],
    extras: JS_EXTRAS,
  },
  python: {
    wasm: { packages: ['tree-sitter-python'], path: 'tree-sitter-python.wasm' },
    tags: [{ packages: ['tree-sitter-python'], path: 'queries/tags.scm' }],
    extras: '',
  },
  go: {
    wasm: { packages: ['tree-sitter-go'], path: 'tree-sitter-go.wasm' },
    tags: [{ packages: ['tree-sitter-go'], path: 'queries/tags.scm' }],
    extras: GO_EXTRAS,
  },
};

/** Each of a file's definitions, imports and exports is kept up to this many. */
export const MAX_ENTRIES = 5_000;
/** A file's uses are kept up to this many lines in all, summed over its names. */
export const MAX_USE_LINES = 50_000;
/** A longer name is never looked up (the API's limit), so its uses aren't kept. */
const LONGEST_NAME = 200;

/**
 * The node types that are a name, in any of the grammars. A grammar may alias one type to
 * another, so each is matched by its name, through every id it has.
 */
const NAME_TYPES = new Set([
  'identifier',
  'type_identifier',
  'property_identifier',
  'shorthand_property_identifier',
  'shorthand_property_identifier_pattern',
  'field_identifier',
  'package_identifier',
]);

/** Reads one file of a grammar package: the WASM grammar as bytes, a query as text. */
export type GrammarReader = {
  bytes: (file: GrammarFile) => Promise<Uint8Array>;
  text: (file: GrammarFile) => Promise<string>;
};

/**
 * The grammars' tags capture the comments before a definition as `@doc`. Docent doesn't use
 * them, and matching `(comment)*` takes time quadratic in a run of comments: 4,000 comment lines
 * took 0.3 s, so a hostile file could stall the index. So those parts are taken out.
 */
export function withoutDocComments(query: string): string {
  return query
    .replace(/\(comment\)\*\s*@doc\s*\.\s*/g, '')
    .replace(/\(#[\w-]+!\s+@doc\b[^)]*\)/g, '');
}

/** Loads every grammar. Only the files named in this module are read. */
export async function loadGrammars(
  treeSitter: typeof TreeSitter,
  read: GrammarReader,
): Promise<Grammars> {
  await treeSitter.Parser.init();
  const grammars = new Map<SourceLanguage, Grammar>();
  for (const [language, files] of Object.entries(GRAMMAR_FILES) as [
    SourceLanguage,
    (typeof GRAMMAR_FILES)[SourceLanguage],
  ][]) {
    const grammar = await treeSitter.Language.load(await read.bytes(files.wasm));
    const tags = (await Promise.all(files.tags.map(read.text))).map(withoutDocComments);
    const parser = new treeSitter.Parser();
    parser.setLanguage(grammar);
    const names = new Set<number>();
    for (let id = 0; id < grammar.nodeTypeCount; id++) {
      if (NAME_TYPES.has(grammar.nodeTypeForId(id) ?? '')) names.add(id);
    }
    grammars.set(language, {
      language,
      parser,
      tags: new treeSitter.Query(grammar, [...tags, files.extras].join('\n')),
      names,
    });
  }
  return grammars;
}

/**
 * Reads one file's symbols. Returns null when parsing or the query runs past `deadline`
 * (a `Date.now()` time), so one pathological file can't stall the index.
 */
export function extractSymbols(
  grammar: Grammar,
  source: string,
  deadline = Number.POSITIVE_INFINITY,
): FileSymbols | null {
  // Returning true from a progress callback cancels the parse or the query.
  const overdue = () => Date.now() > deadline;
  const tree = grammar.parser.parse(source, null, { progressCallback: overdue });
  if (!tree) {
    // A cancelled parse would otherwise resume on the next call, with the next file's text.
    grammar.parser.reset();
    return null;
  }
  try {
    const symbols: FileSymbols = {
      language: grammar.language,
      definitions: [],
      imports: [],
      exports: [],
      exportsAll: [],
      uses: [],
    };
    const matches = grammar.tags.matches(tree.rootNode, { progressCallback: overdue });
    if (overdue()) return null;
    // A name can match two patterns, like `const f = () => {}`: function and constant.
    // The more specific kind wins.
    const seen = new Map<string, Definition>();
    for (const match of matches) {
      let kind: DefinitionKind | null = null;
      let name: TreeSitter.Node | null = null;
      let node: TreeSitter.Node | null = null;
      for (const capture of match.captures) {
        if (capture.name === 'name') name = capture.node;
        else if (capture.name.startsWith('definition.')) {
          kind = definitionKind(capture.name.slice('definition.'.length));
          node = capture.node;
        }
      }
      if (!kind || !name || !node) continue;
      const line = name.startPosition.row + 1;
      const endLine = Math.max(line, node.endPosition.row + 1);
      const key = `${line}:${name.text}`;
      const known = seen.get(key);
      if (known) known.endLine = Math.max(known.endLine, endLine);
      if (known && known.kind !== 'constant') continue;
      if (known) known.kind = kind;
      else {
        const definition = { name: name.text, kind, line, endLine, topLevel: isTopLevel(node) };
        seen.set(key, definition);
        symbols.definitions.push(definition);
      }
    }
    if (grammar.language !== 'python' && grammar.language !== 'go') {
      readModuleStatements(tree.rootNode, symbols);
    }
    symbols.definitions.sort((a, b) => a.line - b.line);
    // A real file has hundreds of these at most. Past the cap, the rest are dropped, so a file
    // built to be dense can't make the index hold hundreds of MB.
    symbols.definitions.length = Math.min(symbols.definitions.length, MAX_ENTRIES);
    symbols.imports.length = Math.min(symbols.imports.length, MAX_ENTRIES);
    symbols.exports.length = Math.min(symbols.exports.length, MAX_ENTRIES);
    symbols.exportsAll = [...new Set(symbols.exportsAll)].slice(0, MAX_ENTRIES);
    const uses = readUses(tree, grammar.names, overdue);
    if (uses === null) return null;
    symbols.uses = uses;
    return symbols;
  } finally {
    tree.delete();
  }
}

/**
 * Every name in the tree, with the lines it's on. Comments and strings hold no name nodes, so
 * they're left out. Null when it runs past the deadline. Past `MAX_USE_LINES`, the rest of the
 * file's uses are dropped, as its other entries are past their cap.
 */
function readUses(
  tree: TreeSitter.Tree,
  names: ReadonlySet<number>,
  overdue: () => boolean,
): Use[] | null {
  const byName = new Map<string, number[]>();
  let kept = 0;
  let steps = 0;
  const cursor = tree.walk();
  try {
    for (;;) {
      // The clock is read every few thousand nodes: often enough for a deadline, cheap enough.
      if (++steps % 4096 === 0 && overdue()) return null;
      if (names.has(cursor.nodeTypeId)) {
        // A name is a leaf, so there's nothing below it to visit.
        const name = cursor.nodeText;
        const line = cursor.startPosition.row + 1;
        const lines = byName.get(name);
        // Nodes come in source order, so a repeat on the same line is the last one kept.
        if (name.length <= LONGEST_NAME && lines?.at(-1) !== line) {
          if (lines) lines.push(line);
          else byName.set(name, [line]);
          if (++kept === MAX_USE_LINES) break;
        }
      } else if (cursor.gotoFirstChild()) continue;
      while (!cursor.gotoNextSibling()) if (!cursor.gotoParent()) return usesOf(byName);
    }
    return usesOf(byName);
  } finally {
    cursor.delete();
  }
}

const usesOf = (byName: Map<string, number[]>): Use[] =>
  [...byName].map(([name, lines]) => ({ name, lines }));

/** Statements that wrap a module-level definition without nesting it in a scope. */
const MODULE_LEVEL = new Set([
  'program',
  'export_statement',
  'lexical_declaration',
  'variable_declaration',
  'ambient_declaration',
  'expression_statement',
  'decorated_definition',
  'module',
  'source_file',
  'type_declaration',
  'const_declaration',
  'var_declaration',
]);

/** Whether a definition sits at the top of its file, not inside a class, function or block. */
function isTopLevel(node: TreeSitter.Node): boolean {
  for (let up = node.parent; up; up = up.parent) {
    if (!MODULE_LEVEL.has(up.type)) return false;
  }
  return true;
}

function definitionKind(tag: string): DefinitionKind | null {
  return (DEFINITION_KINDS as readonly string[]).includes(tag) ? (tag as DefinitionKind) : null;
}

/** The import and export statements at the top of a JavaScript or TypeScript module. */
function readModuleStatements(root: TreeSitter.Node, symbols: FileSymbols): void {
  for (const statement of root.namedChildren) {
    if (!statement) continue;
    const line = statement.startPosition.row + 1;
    const spec = sourceOf(statement);
    if (statement.type === 'import_statement') {
      if (spec === null) continue;
      const clause = statement.namedChildren.find((c) => c?.type === 'import_clause');
      for (const part of clause?.namedChildren ?? []) {
        if (part?.type === 'identifier') {
          symbols.imports.push({ local: part.text, spec, imported: 'default', line: lineOf(part) });
        } else if (part?.type === 'namespace_import') {
          const local = part.namedChildren.find((c) => c?.type === 'identifier');
          if (local) {
            symbols.imports.push({ local: local.text, spec, imported: '*', line: lineOf(local) });
          }
        } else if (part?.type === 'named_imports') {
          for (const specifier of part.namedChildren) {
            if (specifier?.type !== 'import_specifier') continue;
            const name = specifier.childForFieldName('name');
            const local = specifier.childForFieldName('alias') ?? name;
            if (name && local) {
              symbols.imports.push({
                local: local.text,
                spec,
                imported: name.text,
                line: lineOf(local),
              });
            }
          }
        }
      }
      continue;
    }
    if (statement.type !== 'export_statement') continue;

    const clause = statement.namedChildren.find((c) => c?.type === 'export_clause');
    if (clause) {
      for (const specifier of clause.namedChildren) {
        if (specifier?.type !== 'export_specifier') continue;
        const local = specifier.childForFieldName('name')?.text;
        if (!local) continue;
        const name = specifier.childForFieldName('alias')?.text ?? local;
        symbols.exports.push(
          spec === null
            ? { kind: 'local', name, line, local }
            : { kind: 'from', name, line, spec, imported: local },
        );
      }
      continue;
    }
    if (spec !== null) {
      // `export * as ns from '…'` or `export * from '…'`.
      const namespace = statement.namedChildren.find((c) => c?.type === 'namespace_export');
      const name = namespace?.namedChildren.find((c) => c?.type !== 'string')?.text;
      if (name) symbols.exports.push({ kind: 'from', name, line, spec, imported: '*' });
      else symbols.exportsAll.push(spec);
      continue;
    }

    const isDefault = statement.children.some((c) => c?.type === 'default');
    const declaration = statement.childForFieldName('declaration');
    const value = statement.childForFieldName('value');
    if (isDefault) {
      const named = declaration?.childForFieldName('name') ?? value?.childForFieldName('name');
      const local = value?.type === 'identifier' ? value.text : (named?.text ?? null);
      symbols.exports.push({ kind: 'local', name: 'default', line, local });
    } else if (declaration) {
      for (const name of declaredNames(declaration)) {
        symbols.exports.push({ kind: 'local', name, line, local: name });
      }
    }
  }
}

const lineOf = (node: TreeSitter.Node) => node.startPosition.row + 1;

/** The names a declaration introduces: one, or each simple variable of a `const a = …, b = …`. */
function declaredNames(declaration: TreeSitter.Node): string[] {
  if (declaration.type === 'lexical_declaration' || declaration.type === 'variable_declaration') {
    return declaration.namedChildren
      .map((d) => (d?.type === 'variable_declarator' ? d.childForFieldName('name') : null))
      .filter((n) => n?.type === 'identifier')
      .map((n) => n?.text ?? '');
  }
  const name = declaration.childForFieldName('name');
  return name ? [name.text] : [];
}

/** The module specifier of an import or `export … from`, or null when there's none. */
function sourceOf(statement: TreeSitter.Node): string | null {
  const source = statement.childForFieldName('source');
  if (source?.type !== 'string') return null;
  return source.namedChildren.find((c) => c?.type === 'string_fragment')?.text ?? '';
}
