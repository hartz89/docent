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

/** An index of the given files (path → text), parsing the ones in a known language. */
export async function indexOf(files: Record<string, string>): Promise<SymbolIndex> {
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
