// Builds the symbol index for jump to definition and imports, from the PR's files at head.
// The PR's code is untrusted: it's only ever parsed, by WASM grammars, and never run. Indexing is
// capped in files, bytes and time, so a huge or hostile repo gets a partial index, not a hang.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import {
  extractSymbols,
  type FileSymbols,
  type GrammarFile,
  type Grammars,
  loadGrammars,
  SymbolIndex,
  sourceLanguage,
  tsconfigPaths,
} from '@docent/core';
import * as treeSitter from 'web-tree-sitter';
import type { HeadFile, HeadFiles } from './head-files.ts';

export type IndexLimits = {
  /** Files parsed at most. */
  files: number;
  /** A bigger file isn't parsed. */
  fileBytes: number;
  /** Bytes parsed in all. */
  totalBytes: number;
  /** Time for the whole index, from listing to the last file. */
  ms: number;
  /** Time for one file; a slower one is skipped. */
  fileMs: number;
};

export const INDEX_LIMITS: IndexLimits = {
  files: 25_000,
  fileBytes: 512 * 1024,
  totalBytes: 64 * 1024 * 1024,
  ms: 20_000,
  fileMs: 1_000,
};

/** Why an index stopped early. */
export type PartialReason = 'time' | 'files' | 'bytes' | 'listing';

/**
 * How much of the repo the index covers. `skipped` counts files in a known language that weren't
 * indexed. Partial means the index stopped early, so a candidate may be missing.
 */
export type IndexStatus = { files: number; skipped: number; ms: number } & (
  | { state: 'complete' }
  | { state: 'partial'; reason: PartialReason }
);

export type BuiltIndex = { index: SymbolIndex; status: IndexStatus };

/** Vendored, generated and build output folders: not the code under review. */
const SKIPPED_FOLDERS = new Set([
  'node_modules',
  'bower_components',
  'vendor',
  'third_party',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '__pycache__',
  '.venv',
  'venv',
]);
const SKIPPED_NAMES = /\.(min|bundle)\.[cm]?js$|\.pb\.go$|_pb2\.py$|\.generated\.\w+$/;
/** A line this long means minified or generated code. */
const LONGEST_LINE = 10_000;
const MAX_TSCONFIG_BYTES = 256 * 1024;

/** Not vendored or generated, judging by its path. */
function ownCode({ path }: HeadFile): boolean {
  if (SKIPPED_NAMES.test(path)) return false;
  return !path.split('/').some((part) => SKIPPED_FOLDERS.has(part));
}

let grammars: Promise<Grammars> | null = null;

/** The grammars, loaded once per process from their npm packages' WASM and query files. */
export function serverGrammars(): Promise<Grammars> {
  const locate = ({ packages, path }: GrammarFile) => {
    let from = import.meta.filename;
    for (const name of packages) from = createRequire(from).resolve(`${name}/package.json`);
    return join(dirname(from), path);
  };
  grammars ??= loadGrammars(treeSitter, {
    bytes: (file) => readFile(locate(file)),
    text: (file) => readFile(locate(file), 'utf8'),
  }).catch((error: unknown) => {
    grammars = null;
    throw error;
  });
  return grammars;
}

/** Indexes the files at head within `limits`. `now` is the clock, for tests. */
export async function buildIndex(
  listFiles: () => Promise<HeadFiles>,
  limits: IndexLimits = INDEX_LIMITS,
  now: () => number = Date.now,
): Promise<BuiltIndex> {
  const started = now();
  const deadline = started + limits.ms;
  const [head, loaded] = await Promise.all([listFiles(), serverGrammars()]);
  let reason: PartialReason | null = head.truncated ? 'listing' : null;

  const sources = head.entries.filter((e) => sourceLanguage(e.path));
  const chosen: string[] = [];
  let bytes = 0;
  for (const file of sources) {
    if (!ownCode(file) || file.bytes > limits.fileBytes) continue;
    if (chosen.length === limits.files || bytes + file.bytes > limits.totalBytes) {
      reason ??= chosen.length === limits.files ? 'files' : 'bytes';
      break;
    }
    chosen.push(file.path);
    bytes += file.bytes;
  }
  const tsconfigFile = head.entries.find(
    (e) => e.path === 'tsconfig.json' && e.bytes <= MAX_TSCONFIG_BYTES,
  );

  const symbols = new Map<string, FileSymbols>();
  let tsconfig = '';
  const toRead = tsconfigFile ? [tsconfigFile.path, ...chosen] : chosen;
  let read = 0;
  // Stops a stalled read too, not just slow parsing.
  const stop = new AbortController();
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      stop.abort();
    },
    Math.max(0, deadline - now()),
  );
  let lastYield = now();
  try {
    for await (const { path, text } of head.read(toRead, stop.signal)) {
      read++;
      if (now() > deadline) {
        reason ??= 'time';
        break;
      }
      const language = sourceLanguage(path);
      const grammar = language ? loaded.get(language) : undefined;
      if (!grammar) {
        tsconfig = text ?? ''; // The only file read that isn't source.
        continue;
      }
      if (text === null || longestLineOver(text, LONGEST_LINE)) continue;
      const parsed = extractSymbols(grammar, text, Math.min(deadline, now() + limits.fileMs));
      if (parsed) symbols.set(path, parsed);
      // Parsing is synchronous; let the server answer other requests between files.
      if (now() - lastYield > 20) {
        await yieldToEventLoop();
        lastYield = now();
      }
    }
  } finally {
    clearTimeout(timer);
    stop.abort();
  }
  if (read < toRead.length && reason === null) {
    // The reader ended early: out of time, or git failed. A failed index isn't cached.
    if (!timedOut) throw new Error(`Read ${read} of ${toRead.length} files at head`);
    reason = 'time';
  }

  const index = new SymbolIndex(
    new Set(head.entries.map((e) => e.path)),
    symbols,
    tsconfig ? tsconfigPaths(tsconfig) : [],
  );
  const counts = {
    files: symbols.size,
    skipped: sources.length - symbols.size,
    ms: Math.round(now() - started),
  };
  return {
    index,
    status: reason ? { ...counts, state: 'partial', reason } : { ...counts, state: 'complete' },
  };
}

function longestLineOver(text: string, limit: number): boolean {
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    if (end - start > limit) return true;
    start = end + 1;
  }
  return false;
}
