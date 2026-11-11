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
 * A named definition. `line` is the 1-based line of its name. `topLevel` is false inside a class,
 * function or block, where it can't be what a module exports.
 */
export type Definition = { name: string; kind: DefinitionKind; line: number; topLevel: boolean };

/**
 * A name an import statement brings into the file. `imported` is the export it names:
 * `'default'` for a default import, `'*'` for the whole module (`import * as ns`).
 */
export type ImportBinding = { local: string; spec: string; imported: string };

/**
 * One name a file exports. A `local` export points at a name in the file itself, or at nothing
 * for an anonymous `export default`. A `from` export passes on another module's export, with
 * `imported` as `'*'` for `export * as name from`.
 */
export type Export =
  | { kind: 'local'; name: string; line: number; local: string | null }
  | { kind: 'from'; name: string; line: number; spec: string; imported: string };

export type FileSymbols = {
  language: SourceLanguage;
  definitions: Definition[];
  imports: ImportBinding[];
  exports: Export[];
  /** Specifiers of `export * from '…'`. */
  exportsAll: string[];
};

/** One language, ready to parse: a parser set to its grammar, and its tag query. */
export type Grammar = {
  language: SourceLanguage;
  parser: TreeSitter.Parser;
  tags: TreeSitter.Query;
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

const GRAMMAR_FILES: Record<
  SourceLanguage,
  { wasm: GrammarFile; tags: GrammarFile[]; extras: string }
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
    grammars.set(language, {
      language,
      parser,
      tags: new treeSitter.Query(grammar, [...tags, files.extras].join('\n')),
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
      const key = `${line}:${name.text}`;
      const known = seen.get(key);
      if (known && known.kind !== 'constant') continue;
      if (known) known.kind = kind;
      else {
        const definition = { name: name.text, kind, line, topLevel: isTopLevel(node) };
        seen.set(key, definition);
        symbols.definitions.push(definition);
      }
    }
    if (grammar.language !== 'python' && grammar.language !== 'go') {
      readModuleStatements(tree.rootNode, symbols);
    }
    symbols.definitions.sort((a, b) => a.line - b.line);
    return symbols;
  } finally {
    tree.delete();
  }
}

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
          symbols.imports.push({ local: part.text, spec, imported: 'default' });
        } else if (part?.type === 'namespace_import') {
          const local = part.namedChildren.find((c) => c?.type === 'identifier');
          if (local) symbols.imports.push({ local: local.text, spec, imported: '*' });
        } else if (part?.type === 'named_imports') {
          for (const specifier of part.namedChildren) {
            if (specifier?.type !== 'import_specifier') continue;
            const imported = specifier.childForFieldName('name')?.text;
            const local = specifier.childForFieldName('alias')?.text ?? imported;
            if (imported && local) symbols.imports.push({ local, spec, imported });
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
