// Real Tree-sitter grammars for core's tests, and an index built from in-memory files.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as treeSitter from 'web-tree-sitter';
import { SymbolIndex, tsconfigPaths } from './symbol-index.ts';
import {
  extractSymbols,
  type FileSymbols,
  type GrammarFile,
  type Grammars,
  loadGrammars,
  sourceLanguage,
} from './symbols.ts';

let loaded: Promise<Grammars> | null = null;

export function testGrammars(): Promise<Grammars> {
  const locate = ({ packages, path }: GrammarFile) => {
    let from = import.meta.filename;
    for (const name of packages) from = createRequire(from).resolve(`${name}/package.json`);
    return join(dirname(from), path);
  };
  loaded ??= loadGrammars(treeSitter, {
    bytes: (file) => readFile(locate(file)),
    text: (file) => readFile(locate(file), 'utf8'),
  });
  return loaded;
}

/** The real index of the given files (path → text), parsing the ones in a known language. */
export async function symbolIndexOf(files: Record<string, string>): Promise<SymbolIndex> {
  const grammars = await testGrammars();
  const symbols = new Map<string, FileSymbols>();
  for (const [path, text] of Object.entries(files)) {
    const language = sourceLanguage(path);
    const grammar = language ? grammars.get(language) : undefined;
    const parsed = grammar ? extractSymbols(grammar, text) : null;
    if (parsed) symbols.set(path, parsed);
  }
  const tsconfig = files['tsconfig.json'];
  return new SymbolIndex(
    new Set(Object.keys(files)),
    symbols,
    tsconfig ? tsconfigPaths(tsconfig) : [],
  );
}

/** An index of the given files, with lookups that return just the candidates. */
export async function indexOf(files: Record<string, string>) {
  const index = await symbolIndexOf(files);
  return {
    definitions: (symbol: string, from?: { path: string; line?: number }) =>
      index.definitions(symbol, from).candidates,
    limited: (symbol: string, limit: number, from?: { path: string }) =>
      index.definitions(symbol, from, limit),
    resolveImport: (from: string, spec: string) => index.resolveImport(from, spec),
    references: (symbol: string, first?: (path: string) => boolean, limit?: number) =>
      index.references(symbol, first, limit),
  };
}
