// Parses one file at a time for the symbol index, off the server's main thread. A hostile file
// can exhaust the WASM parser's memory, and a parser that has failed once stays broken. So any
// failure ends this worker, and the server starts a fresh one for the next file.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import {
  extractSymbols,
  type FileSymbols,
  type GrammarFile,
  type Grammars,
  loadGrammars,
  type SourceLanguage,
} from '@docent/core';
import * as treeSitter from 'web-tree-sitter';

export type ParseRequest = { language: SourceLanguage; text: string; deadline: number };
export type ParseReply = { symbols: FileSymbols | null };

const locate = ({ packages, path }: GrammarFile) => {
  let from = import.meta.filename;
  for (const name of packages) from = createRequire(from).resolve(`${name}/package.json`);
  return join(dirname(from), path);
};

let grammars: Grammars;
try {
  grammars = await loadGrammars(treeSitter, {
    bytes: (file) => readFile(locate(file)),
    text: (file) => readFile(locate(file), 'utf8'),
  });
} catch {
  process.exit(1);
}
parentPort?.postMessage('ready');

parentPort?.on('message', ({ language, text, deadline }: ParseRequest) => {
  try {
    const grammar = grammars.get(language);
    const reply: ParseReply = { symbols: grammar ? extractSymbols(grammar, text, deadline) : null };
    parentPort?.postMessage(reply);
  } catch {
    // Out of memory, or a broken parser: nothing more can be trusted to this one.
    process.exit(1);
  }
});
