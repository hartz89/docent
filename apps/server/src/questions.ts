// Question threads: every answered question, with who answered, why, what it cost, and the
// guide's note on it. Kept per PR, in memory and in one small file under the Docent data dir, so
// a reload or a relaunch shows them again. Answers cost money and are part of the review record,
// so they live on the server, never only in the browser.
//
// The file is the reviewer's own: 0600, in a 0700 folder, written whole and renamed into place.
// Text is scrubbed of anything shaped like a secret before it's written, and everything is capped,
// so a long review can't grow it without bound. Opening never throws: a file that can't be read
// is left alone, and this launch keeps its threads in memory, so nothing is lost or overwritten.
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { CorrectionView } from './answer-check.ts';
import type { AnswerView } from './review.ts';
import { envSecrets, scrubSecrets } from './run-log.ts';

/** One answered question, as kept. */
export type AskedQuestion = {
  id: string;
  /** The stop it was asked at, by id and title: a later tour may number its stops differently. */
  stopId: string;
  stopTitle: string;
  question: string;
  answer: AnswerView;
  /** The guide's note when the code contradicts an author answer. */
  correction: CorrectionView | null;
  /** True once the guide's check has settled, or when there's none to wait for (a guide answer). */
  checked: boolean;
};

/** At most this many questions are kept per PR, across heads; the oldest go first. */
export const MAX_QUESTIONS = 200;
/** Any one stored text, an answer say, is cut to this many characters. */
export const MAX_TEXT_CHARS = 16_000;
/** A file bigger than this isn't read, and the oldest questions go before a file would pass it. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Thread files untouched this long are removed when a review opens. */
export const KEEP_DAYS = 90;
/** At most this many thread files (PRs) are kept; the least recently used go first. */
export const KEEP_FILES = 500;
const MAX_COSTS = 20;
const MAX_CITES = 10;
const VERSION = 1;

export type StoreOptions = {
  /** The folder that holds one file per PR, like `<data>/questions`. */
  dir: string;
  pr: { repo: string; number: number };
  /** Secret-looking env vars are scrubbed from what's written. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Told when a read or write fails. The review goes on either way. */
  onError?: (where: string, error: unknown) => void;
  now?: () => Date;
};

export class QuestionStore {
  readonly path: string | null;
  #questions: AskedQuestion[];
  #secrets: string[];
  #onError: (where: string, error: unknown) => void;
  /** Writes in order, one at a time. Never rejects. */
  #writing: Promise<void> = Promise.resolve();

  private constructor(
    path: string | null,
    questions: AskedQuestion[],
    secrets: string[],
    onError: StoreOptions['onError'],
  ) {
    this.path = path;
    this.#questions = questions;
    this.#secrets = secrets;
    this.#onError = onError ?? (() => {});
  }

  /** Threads kept for this launch only: a replayed fixture, or a test. */
  static memory(): QuestionStore {
    return new QuestionStore(null, [], [], undefined);
  }

  /** Prunes old thread files, then reads this PR's, if there is one. */
  static async open(options: StoreOptions): Promise<QuestionStore> {
    const secrets = envSecrets(options.env ?? process.env);
    const path = join(options.dir, threadFileName(options.pr));
    try {
      await mkdir(options.dir, { recursive: true, mode: 0o700 });
      // A linked folder could point pruning and writes somewhere else.
      if (!(await lstat(options.dir)).isDirectory()) {
        throw new Error(`${options.dir} is not a plain folder`);
      }
      await chmod(options.dir, 0o700);
    } catch (error) {
      // No folder we can trust: threads are kept for this launch only.
      options.onError?.('question threads', error);
      return new QuestionStore(null, [], secrets, options.onError);
    }
    try {
      await prune(options.dir, (options.now ?? (() => new Date()))(), path);
    } catch (error) {
      // Old files stay a while longer; this review goes on.
      options.onError?.('question threads', error);
    }
    try {
      const questions = await load(path);
      return new QuestionStore(path, questions, secrets, options.onError);
    } catch (error) {
      // A file we can't read is left as it is, never overwritten: a newer Docent may have
      // written it, or the reviewer may want it back. Threads are kept for this launch only.
      options.onError?.('question threads', error);
      console.error(
        `Docent couldn't read earlier questions from ${path}, so this launch keeps them until it ends. Move the file aside to start fresh. (${error instanceof Error ? error.message : String(error)})`,
      );
      return new QuestionStore(null, [], secrets, options.onError);
    }
  }

  list(): readonly AskedQuestion[] {
    return this.#questions;
  }

  /** Keeps a newly answered question, scrubbed and capped, and saves the threads. */
  add(question: Omit<AskedQuestion, 'id'>): AskedQuestion {
    const kept = this.#clean({ ...question, id: randomUUID() });
    this.#questions = fitting([...this.#questions, kept].slice(-MAX_QUESTIONS));
    this.#save();
    return kept;
  }

  /** Records the guide's check of an answer once it has settled. */
  checked(id: string, correction: CorrectionView | null) {
    this.#questions = fitting(
      this.#questions.map((q) =>
        q.id === id ? this.#clean({ ...q, correction, checked: true }) : q,
      ),
    );
    this.#save();
  }

  /** Resolves once every write so far has finished. */
  settled(): Promise<void> {
    return this.#writing;
  }

  #save() {
    const path = this.path;
    if (!path) return;
    const questions = this.#questions;
    this.#writing = this.#writing.then(() =>
      save(path, questions).catch((error: unknown) => this.#onError('question threads', error)),
    );
  }

  #clean(question: AskedQuestion): AskedQuestion {
    const text = (value: string) => cap(scrubSecrets(value, this.#secrets));
    const { answer, correction } = question;
    return {
      ...question,
      stopTitle: text(question.stopTitle),
      question: text(question.question),
      answer: {
        ...answer,
        text: text(answer.text),
        costs: answer.costs.slice(0, MAX_COSTS),
        ...(answer.source === 'guide' ? { whyNotAuthor: text(answer.whyNotAuthor) } : {}),
      },
      correction: correction && {
        text: text(correction.text),
        cites: correction.cites.slice(0, MAX_CITES),
        costs: correction.costs.slice(0, MAX_COSTS),
      },
    };
  }
}

/** One file per PR, named for it. Only letters, digits, `.`, `_` and `-` survive. */
export function threadFileName(pr: { repo: string; number: number }): string {
  const repo = pr.repo
    .replace('/', '__')
    .replace(/[^\w.-]/g, '_')
    .slice(0, 200);
  return `${repo}__${Math.trunc(pr.number)}.json`;
}

/**
 * The newest questions whose file fits within MAX_FILE_BYTES. Each question is measured once; the
 * envelope and commas take well under the 1 KB left over.
 */
function fitting(questions: AskedQuestion[]): AskedQuestion[] {
  let bytes = 1024;
  let from = questions.length;
  while (from > 0) {
    const size = Buffer.byteLength(JSON.stringify(questions[from - 1])) + 1;
    if (bytes + size > MAX_FILE_BYTES) break;
    bytes += size;
    from -= 1;
  }
  return from === 0 ? questions : questions.slice(from);
}

/** Writes the whole file under a fresh name, then renames it over the old one. */
async function save(path: string, questions: AskedQuestion[]) {
  const body = JSON.stringify({ version: VERSION, questions });
  const temp = `${path}.${randomUUID()}.tmp`;
  // `wx`: never follow or reuse an existing file. The rename replaces a link, not its target.
  await writeFile(temp, body, { mode: 0o600, flag: 'wx' });
  try {
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

/**
 * This PR's earlier questions: none when there's no file yet. Throws for a file that isn't a
 * plain one of a sane size in this version's shape, so the caller leaves it alone.
 */
async function load(path: string): Promise<AskedQuestion[]> {
  let file: FileHandle;
  try {
    // Never through a link someone left in its place.
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error(`${path} is not a plain file`);
    if (info.size > MAX_FILE_BYTES) throw new Error(`${path} is over ${MAX_FILE_BYTES} bytes`);
    const data = JSON.parse(await file.readFile('utf8')) as unknown;
    if (!isRecord(data) || data.version !== VERSION || !Array.isArray(data.questions)) {
      throw new Error(`${path} isn't a version ${VERSION} thread file`);
    }
    return data.questions.filter(isAsked).slice(-MAX_QUESTIONS);
  } finally {
    await file.close();
  }
}

/** Names this module writes: thread files, and the temp files each save starts as. */
const THREAD_FILE = /^[\w.-]+__\d+\.json$/;
const TEMP_FILE = /^[\w.-]+__\d+\.json\.[0-9a-f-]{36}\.tmp$/;

/** Removes thread files untouched for KEEP_DAYS, then the least recently used beyond KEEP_FILES. */
async function prune(dir: string, now: Date, keep: string) {
  const cutoff = now.getTime() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  const files: { path: string; at: number }[] = [];
  for (const name of await readdir(dir)) {
    // Our own files only: thread files, and temp files a crash left behind.
    const temp = TEMP_FILE.test(name);
    if (!temp && !THREAD_FILE.test(name)) continue;
    const path = join(dir, name);
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile() || path === keep) continue;
    if (temp) {
      // A minute old: another launch's write in progress is left to finish.
      if (info.mtimeMs < now.getTime() - 60_000) await unlink(path).catch(() => {});
    } else if (info.mtimeMs < cutoff) await unlink(path).catch(() => {});
    else files.push({ path, at: info.mtimeMs });
  }
  // Leave room for this PR's file.
  files.sort((a, b) => a.at - b.at);
  for (const { path } of files.slice(0, Math.max(0, files.length - (KEEP_FILES - 1)))) {
    await unlink(path).catch(() => {});
  }
}

const cap = (text: string) =>
  text.length <= MAX_TEXT_CHARS ? text : `${text.slice(0, MAX_TEXT_CHARS)}… [cut]`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isCosts = (value: unknown) =>
  Array.isArray(value) &&
  value.every((c) => isRecord(c) && Number.isFinite(c.costMicroUsd) && typeof c.model === 'string');

/** The file is ours, but it's read back into the page, so its shape is checked, not trusted. */
function isAsked(value: unknown): value is AskedQuestion {
  if (!isRecord(value)) return false;
  const { answer: a, correction: c } = value;
  const strings = ['id', 'stopId', 'stopTitle', 'question'].every(
    (k) => typeof value[k] === 'string',
  );
  if (!strings || typeof value.checked !== 'boolean' || !isRecord(a)) return false;
  const answer =
    typeof a.text === 'string' &&
    typeof a.askedAt === 'string' &&
    typeof a.costIncomplete === 'boolean' &&
    isCosts(a.costs) &&
    (a.source === 'guide'
      ? typeof a.whyNotAuthor === 'string'
      : a.source === 'author_session' &&
        typeof a.session === 'string' &&
        typeof a.checkId === 'string');
  const correction =
    c === null ||
    (isRecord(c) &&
      typeof c.text === 'string' &&
      isCosts(c.costs) &&
      Array.isArray(c.cites) &&
      c.cites.every(
        (x) =>
          isRecord(x) &&
          typeof x.path === 'string' &&
          (x.side === 'new' || x.side === 'old') &&
          Number.isInteger(x.startLine) &&
          Number.isInteger(x.endLine),
      ));
  return answer && correction;
}
