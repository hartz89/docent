// Builds the symbol index for jump to definition, imports and find references, from the PR's
// files at head.
// The PR's code is untrusted: it's only ever parsed, by WASM grammars, and never run. Parsing
// happens in a worker thread that's thrown away if a file breaks it, so the server stays up and
// responsive. Indexing is capped in files, bytes and time, so a huge or hostile repo gets a
// partial index, not a hang.
import { Worker } from 'node:worker_threads';
import { type FileSymbols, SymbolIndex, sourceLanguage, tsconfigPaths } from '@docent/core';
import type { HeadFile, HeadFiles } from './head-files.ts';
import type { ParseReply, ParseRequest } from './symbol-worker.ts';

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
  /**
   * Memory held for definitions, imports and exports across files, as estimated by
   * `symbolBytes`. Past it, the index stops.
   */
  symbolBytes: number;
  /**
   * Memory held for uses (find references) across files, as estimated by `useBytes`. Past it,
   * later files keep their definitions but not their uses.
   */
  useBytes: number;
};

export const INDEX_LIMITS: IndexLimits = {
  files: 25_000,
  fileBytes: 512 * 1024,
  totalBytes: 64 * 1024 * 1024,
  ms: 20_000,
  fileMs: 1_000,
  symbolBytes: 64 * 1024 * 1024,
  useBytes: 128 * 1024 * 1024,
};

/**
 * Why an index stopped early. `wary`: files kept breaking the parser, so larger ones after them
 * were skipped. `memory`: the symbols held reached `symbolBytes`.
 */
export type PartialReason = 'time' | 'files' | 'bytes' | 'memory' | 'listing' | 'wary';

/**
 * How much of the repo the index covers. `skipped` counts files in a known language that weren't
 * indexed. Partial means the index stopped early, so a candidate may be missing. `usesFiles`
 * counts the indexed files whose uses are kept: fewer than `files` once uses reach `useBytes`,
 * so references may be missing then too.
 */
export type IndexStatus = { files: number; skipped: number; usesFiles: number; ms: number } & (
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
/** How long past its own deadline a parse may run before its worker is stopped. */
const GRACE_MS = 250;
/** Files that fail or take over half their time before the rest are parsed warily. */
const MAX_STRIKES = 3;
/** Once wary, a bigger file is skipped. */
const WARY_FILE_CHARS = 16 * 1024;
/** How long a worker may take to load its grammars. */
const STARTUP_MS = 10_000;

/** Not vendored or generated, judging by its path. */
function ownCode({ path }: HeadFile): boolean {
  if (SKIPPED_NAMES.test(path)) return false;
  return !path.split('/').some((part) => SKIPPED_FOLDERS.has(part));
}

/** Indexes the files at head within `limits`. */
export async function buildIndex(
  listFiles: () => Promise<HeadFiles>,
  limits: IndexLimits = INDEX_LIMITS,
): Promise<BuiltIndex> {
  const started = Date.now();
  const deadline = started + limits.ms;
  const head = await listFiles();
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
    Math.max(0, deadline - Date.now()),
  );
  const parser = new ParserWorker();
  let strikes = 0;
  let heldSymbols = 0;
  let heldUses = 0;
  let usesFiles = 0;
  try {
    for await (const { path, text } of head.read(toRead, stop.signal)) {
      read++;
      if (Date.now() > deadline) {
        reason ??= 'time';
        break;
      }
      const language = sourceLanguage(path);
      if (!language) {
        tsconfig = text ?? ''; // The only file read that isn't source.
        continue;
      }
      if (text === null || longestLineOver(text, LONGEST_LINE)) continue;
      // After a few files that broke the parser or were very slow, the PR is treated as hostile:
      // only small files are parsed, on a short clock, so it can't spend the whole budget.
      const wary = strikes >= MAX_STRIKES;
      if (wary && text.length > WARY_FILE_CHARS) {
        reason ??= 'wary';
        continue;
      }
      const ms = wary ? limits.fileMs / 4 : limits.fileMs;
      const began = Date.now();
      const parsed = await parser.parse(path, language, text, ms, deadline);
      if (parsed) {
        // Many small, dense files could otherwise hold hundreds of MB between them. Uses are by
        // far the most, so they run out first, and later files still get jump to definition.
        heldSymbols += symbolBytes(parsed);
        if (heldSymbols > limits.symbolBytes) {
          reason ??= 'memory';
          break;
        }
        const uses = useBytes(parsed);
        if (heldUses + uses <= limits.useBytes) {
          heldUses += uses;
          usesFiles++;
        } else {
          // Once one file's uses don't fit, none after it are kept, so references cover a
          // clear set of files rather than whichever happened to be small.
          heldUses = Number.POSITIVE_INFINITY;
          parsed.uses = [];
        }
        symbols.set(path, parsed);
      }
      if (!parsed || Date.now() - began > limits.fileMs / 2) strikes++;
    }
  } finally {
    clearTimeout(timer);
    stop.abort();
    await parser.close();
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
    usesFiles,
    ms: Math.round(Date.now() - started),
  };
  return {
    index,
    status: reason ? { ...counts, state: 'partial', reason } : { ...counts, state: 'complete' },
  };
}

// Rough sizes of what V8 holds: an object with its fields, and a string's header. Only the
// order of magnitude matters, so a dense file can't slip under a cap meant for real code.
const OBJECT_BYTES = 64;
const STRING_BYTES = 24;
const text = (s: string) => STRING_BYTES + 2 * s.length;

/** About how much memory a file's definitions, imports and exports hold. */
export function symbolBytes(file: FileSymbols): number {
  let bytes = 0;
  for (const d of file.definitions) bytes += OBJECT_BYTES + text(d.name);
  for (const i of file.imports) bytes += OBJECT_BYTES + text(i.local) + text(i.imported);
  for (const e of file.exports) bytes += OBJECT_BYTES + text(e.name);
  for (const spec of file.exportsAll) bytes += text(spec);
  return bytes;
}

/** About how much memory a file's uses hold: an entry per name, and a number per line. */
export function useBytes(file: FileSymbols): number {
  let bytes = 0;
  for (const use of file.uses) bytes += OBJECT_BYTES + text(use.name) + 8 * use.lines.length;
  return bytes;
}

/**
 * One parser worker, used for one file at a time. A file that crashes it, or runs past its
 * deadline, is skipped, and the next file gets a fresh worker. Closing it frees its WASM memory.
 */
class ParserWorker {
  #worker: Promise<Worker> | null = null;

  /** Parses within `ms`, and never past `deadline`. Null when it can't. */
  async parse(
    path: string,
    language: ParseRequest['language'],
    text: string,
    ms: number,
    deadline: number,
  ): Promise<FileSymbols | null> {
    const worker = await this.#start();
    // The clock starts once the worker is ready, so loading grammars isn't charged to a file.
    const request: ParseRequest = { language, text, deadline: Math.min(deadline, Date.now() + ms) };
    return new Promise((resolve) => {
      const done = (symbols: FileSymbols | null, broken: boolean) => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('exit', onExit);
        worker.off('error', onError);
        // Logged however the file was stopped: the parser may cancel itself just in time, or be
        // stopped here after its grace period. Which one wins depends on load, not on the file.
        if (symbols === null) {
          console.error(
            `Docent skipped ${JSON.stringify(path)}: the parser failed or ran too long.`,
          );
        }
        if (broken) this.#stop(worker);
        resolve(symbols);
      };
      const onMessage = (reply: ParseReply) => done(reply.symbols, false);
      const onExit = () => done(null, true);
      const onError = () => done(null, true);
      // The parser checks its deadline itself; this catches one that doesn't come back.
      const timer = setTimeout(
        () => done(null, true),
        Math.max(0, request.deadline - Date.now()) + GRACE_MS,
      );
      worker.on('message', onMessage);
      worker.on('exit', onExit);
      worker.on('error', onError);
      worker.postMessage(request);
    });
  }

  async close(): Promise<void> {
    const worker = this.#worker;
    this.#worker = null;
    if (worker) await (await worker.catch(() => null))?.terminate();
  }

  /** A worker with its grammars loaded. Throws if one can't start, which fails the build. */
  #start(): Promise<Worker> {
    this.#worker ??= new Promise<Worker>((resolve, reject) => {
      // Node runs the .ts source directly; the build emits .js next to this file.
      const file = import.meta.url.endsWith('.ts') ? './symbol-worker.ts' : './symbol-worker.js';
      const worker = new Worker(new URL(file, import.meta.url), {
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      });
      // Always listening, so a worker's error can never become an uncaught one in the server.
      let reason = 'it exited';
      worker.on('error', (error) => {
        reason = String(error);
      });
      const fail = (why: string) => {
        clearTimeout(timer);
        void worker.terminate();
        reject(new Error(`The parser worker failed to start: ${why}`));
      };
      const timer = setTimeout(() => fail('it took too long'), STARTUP_MS);
      worker.once('message', (message: 'ready' | { error: string }) => {
        if (message !== 'ready') return fail(message.error);
        clearTimeout(timer);
        resolve(worker);
      });
      worker.once('exit', () => fail(reason));
    }).catch((error: unknown) => {
      this.#worker = null;
      throw error;
    });
    return this.#worker;
  }

  #stop(worker: Worker): void {
    this.#worker = null;
    void worker.terminate();
  }
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
