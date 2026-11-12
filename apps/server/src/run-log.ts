// The run log: one JSONL file per `docent review` launch, so the maintainer's agents can read
// what happened in a run instead of being told. Local only. Every line is one event, with `ts`,
// `kind` and plain fields. Secrets are scrubbed and long text is capped before anything is
// written. Writing never throws: a broken log must not break a review.
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

export type Fields = Record<string, unknown>;

/** One line of a run file. */
export type RunEvent = { ts: string; kind: string } & Fields;

/** A timed stretch of work. `end()` writes one `span` event with its name and duration. */
export type Span = { end: (fields?: Fields) => void };

/** Run files older than this are removed at startup. */
export const KEEP_DAYS = 30;
/** At most this many run files are kept; the oldest go first. */
export const KEEP_FILES = 200;

/** Any one string field is cut to this many characters. Questions and answers fit well within. */
export const MAX_FIELD_CHARS = 8_000;
/** Any one list keeps at most this many items. */
const MAX_LIST_ITEMS = 50;
/** Objects nest at most this deep; anything deeper is dropped. */
const MAX_DEPTH = 6;
/** One run file stops growing here, so a repeating error can't fill the disk. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

const REDACTED = '[redacted]';

/** Field names whose values are never written, whatever they hold. */
const SECRET_KEY = /^(token|authorization|password|secret|cookie|api[-_]?key)$/i;
/**
 * Environment variable names whose values count as secrets. Not session ids: those name who
 * answered a question, and the log exists to show that.
 */
const SECRET_ENV = /TOKEN|SECRET|KEY|PASSWORD|PASSWD|AUTH|CREDENTIAL|COOKIE/i;
/**
 * Token shapes worth catching wherever they turn up, even when we were never told them. GitHub's
 * are matched anywhere, even glued to other text (`_ghp_…`). `sk-` keys need a non-letter before
 * them, or hyphenated words like "task-list-with-…" would be scrubbed.
 */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/github_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{10,}/g, REDACTED],
  [/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, `Bearer ${REDACTED}`],
  [/([#?&]token=)[^\s&#"'<>]+/gi, `$1${REDACTED}`],
];

export type RunLogOptions = {
  /** The folder that holds every run file, like `<data>/runs`. */
  dir: string;
  /** Names the run: `owner-repo-number`, or anything else safe for a file name. */
  label: string;
  now?: () => Date;
  /** Values to scrub on top of the built-in patterns. Secret-looking env vars are added too. */
  secrets?: string[];
  env?: NodeJS.ProcessEnv;
  /** Where one run file stops growing. Default MAX_FILE_BYTES. */
  maxBytes?: number;
};

/**
 * Where events go. `RunLog.off()` writes nothing, which is what tests and `--no-run-log` get.
 */
export class RunLog {
  readonly path: string | null;
  #fd: number | null;
  #now: () => Date;
  #secrets: string[];
  #bytes = 0;
  #maxBytes = MAX_FILE_BYTES;

  private constructor(path: string | null, fd: number | null, now: () => Date, secrets: string[]) {
    this.path = path;
    this.#fd = fd;
    this.#now = now;
    this.#secrets = secrets;
  }

  /** A log that writes nothing. */
  static off(): RunLog {
    return new RunLog(null, null, () => new Date(), []);
  }

  /**
   * Prunes old runs, then opens a new run file, readable only by this user. If the folder can't
   * be written, says so once on stderr and returns a log that writes nothing.
   */
  static open(options: RunLogOptions): RunLog {
    const now = options.now ?? (() => new Date());
    const secrets = [...(options.secrets ?? []), ...envSecrets(options.env ?? process.env)];
    try {
      mkdirSync(options.dir, { recursive: true, mode: 0o700 });
      chmodSync(options.dir, 0o700);
      prune(options.dir, now());
      const stamp = now().toISOString().replace(/:/g, '-');
      const label = options.label.replace(/[^\w.-]+/g, '-').slice(0, 100);
      const path = join(options.dir, `${stamp}-${label}.jsonl`);
      // `wx` refuses to follow or reuse an existing file, so the log can't be redirected.
      const fd = openSync(path, 'wx', 0o600);
      const log = new RunLog(path, fd, now, secrets);
      if (options.maxBytes !== undefined) log.#maxBytes = options.maxBytes;
      return log;
    } catch (error) {
      console.error(`Docent couldn't start its run log, so this run isn't logged: ${error}`);
      return RunLog.off();
    }
  }

  /** Adds a value to scrub from everything written after this, like the per-launch token. */
  addSecret(value: string) {
    if (value.length >= 8) this.#secrets.push(value);
  }

  event(kind: string, fields: Fields = {}) {
    if (this.#fd === null) return;
    const line = { ts: this.#now().toISOString(), kind, ...(this.#clean(fields, 0) as Fields) };
    let text = `${escapeInvisible(JSON.stringify(line))}\n`;
    const full = this.#bytes + Buffer.byteLength(text) > this.#maxBytes;
    if (full) {
      text = `${JSON.stringify({ ts: line.ts, kind: 'log.full', bytes: this.#bytes })}\n`;
    }
    try {
      this.#bytes += writeSync(this.#fd, text);
      if (full) this.close();
    } catch (error) {
      console.error(`Docent's run log stopped: ${error}`);
      this.close();
    }
  }

  span(name: string, fields: Fields = {}): Span {
    const started = this.#now().getTime();
    let ended = false;
    return {
      end: (more = {}) => {
        if (ended) return;
        ended = true;
        this.event('span', { name, ms: this.#now().getTime() - started, ...fields, ...more });
      },
    };
  }

  /** An error with its stack, scrubbed and capped like everything else. */
  error(where: string, error: unknown, fields: Fields = {}) {
    this.event('error', { where, ...describeError(error), ...fields });
  }

  close() {
    if (this.#fd === null) return;
    try {
      closeSync(this.#fd);
    } catch {
      // Already closed.
    }
    this.#fd = null;
  }

  #clean(value: unknown, depth: number): unknown {
    // Scrub first: a cut could split a secret and hide it from the patterns.
    if (typeof value === 'string') return cap(this.#scrub(value));
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'boolean' || value === null) return value;
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
      return undefined;
    }
    if (typeof value === 'bigint') return value.toString();
    if (depth >= MAX_DEPTH) return '[too deep]';
    if (value instanceof Error) return this.#clean(describeError(value), depth + 1);
    if (Array.isArray(value)) {
      const kept = value.slice(0, MAX_LIST_ITEMS).map((v) => this.#clean(v, depth + 1));
      if (value.length > MAX_LIST_ITEMS) kept.push(`[${value.length - MAX_LIST_ITEMS} more]`);
      return kept;
    }
    const out: Fields = {};
    for (const [key, v] of Object.entries(value as Fields)) {
      if (key === 'ts' || key === 'kind') continue;
      const safeKey = this.#scrub(key).slice(0, 100);
      out[safeKey] = SECRET_KEY.test(key) ? REDACTED : this.#clean(v, depth + 1);
    }
    return out;
  }

  #scrub(text: string): string {
    let out = text;
    for (const secret of this.#secrets) out = out.split(secret).join(REDACTED);
    for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
    return out;
  }
}

/** Message and stack, for any thrown value. */
export function describeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return error.stack
      ? { message: error.message, stack: error.stack }
      : { message: error.message };
  }
  return { message: String(error) };
}

function cap(text: string): string {
  return text.length <= MAX_FIELD_CHARS
    ? text
    : `${text.slice(0, MAX_FIELD_CHARS)}… [${text.length - MAX_FIELD_CHARS} more characters]`;
}

/** Values of env vars named like secrets. Short ones are skipped, so "1" isn't scrubbed everywhere. */
function envSecrets(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([name, value]) => SECRET_ENV.test(name) && value && value.length >= 8)
    .map(([, value]) => value as string);
}

/** A run file's name: an ISO time (colons swapped for dashes), then the label. */
export const RUN_FILE = /^\d{4}-\d{2}-\d{2}T[\d-]+(?:\.\d+)?Z-.+\.jsonl$/;

/** Removes run files older than KEEP_DAYS, then the oldest beyond KEEP_FILES - 1. */
function prune(dir: string, now: Date) {
  const cutoff = now.getTime() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  // Names start with the time, so name order is age order.
  const runs = readdirSync(dir)
    .filter((name) => RUN_FILE.test(name))
    .sort();
  const kept: string[] = [];
  for (const name of runs) {
    const path = join(dir, name);
    try {
      if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
      else kept.push(path);
    } catch {
      // Gone already, or not ours to remove.
    }
  }
  // Leave room for the run about to start.
  for (const path of kept.slice(0, Math.max(0, kept.length - (KEEP_FILES - 1)))) {
    try {
      unlinkSync(path);
    } catch {
      // As above.
    }
  }
}

/** Reads `DOCENT_RUN_LOG`: `off`, `0`, `false` or `no` turns the run log off. */
export function runLogDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(off|0|false|no)$/i.test(env.DOCENT_RUN_LOG?.trim() ?? '');
}

/**
 * Characters JSON leaves raw that a terminal or reader could act on: C1 controls (U+009B starts
 * an escape in some terminals), line separators, and bidi controls. Written as `\\uXXXX`.
 * They only occur inside JSON strings, so the text stays valid JSON.
 */
export const INVISIBLE = /[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

export function escapeInvisible(json: string): string {
  return json.replace(INVISIBLE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
