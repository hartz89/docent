// The eval fixture manifest: one fixed PR plus the answers Docent should find in it.
// Diffs are never stored. A runner fetches them from `base...head` at run time, so the
// same shape works for public fixtures (committed here) and private ones (kept elsewhere).

/** The Docent jobs a fixture can exercise. Matches the eval table in docs/brief.md. */
export const JOBS = ['tour', 'skip', 'danger', 'answer-check', 'scrubber'] as const;
export type Job = (typeof JOBS)[number];

/** Size by changed lines (additions + deletions) in the whole PR diff. */
export const SIZES = ['small', 'medium', 'large'] as const;
export type Size = (typeof SIZES)[number];

export function sizeFor(changedLines: number): Size {
  if (changedLines < 100) return 'small';
  if (changedLines < 500) return 'medium';
  return 'large';
}

/** 1-based, inclusive line numbers in the file as it is at the head commit. */
export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/** Something the tour must surface. */
export interface ExpectedFinding {
  readonly file: string;
  readonly lines: LineRange;
  readonly description: string;
}

/** Changed lines the skip decision must never collapse. */
export interface MustNotSkip {
  readonly file: string;
  readonly lines: LineRange;
  readonly reason: string;
}

/** A link that proves the ground truth, such as the PR or commit that fixed the defect. */
export interface Evidence {
  readonly url: string;
  readonly note: string;
}

export interface FixtureSource {
  /** GitHub `owner/name`. */
  readonly repo: string;
  readonly pr: number;
  /** The merge base. `base...head` is exactly the PR's diff. */
  readonly base: string;
  /** The PR's head commit. All line numbers refer to this commit. */
  readonly head: string;
}

export interface FixtureManifest {
  /** Kebab-case, and the same as the file name without `.json`. */
  readonly id: string;
  /** Public fixtures live in this repo. Private ones never do. */
  readonly visibility: 'public' | 'private';
  readonly source: FixtureSource;
  /** SPDX id of the source repo's license, or "UNLICENSED" for private code. */
  readonly license: string;
  /** The PR's title, as written. */
  readonly title: string;
  readonly size: Size;
  readonly jobs: readonly Job[];
  /** Empty only for negative controls. */
  readonly expectedFindings: readonly ExpectedFinding[];
  readonly mustNotSkip: readonly MustNotSkip[];
  readonly expectDangerFlag: boolean;
  readonly evidence: readonly Evidence[];
}

export type ValidationResult =
  | { readonly ok: true; readonly manifest: FixtureManifest }
  | { readonly ok: false; readonly errors: readonly string[] };

const SHA = /^[0-9a-f]{40}$/;
const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

type Obj = Record<string, unknown>;

/**
 * Checks an untrusted value (usually parsed JSON) against the manifest shape and its rules.
 * Every problem is reported, each as `path: what is wrong`.
 */
export function validateManifest(input: unknown): ValidationResult {
  const errors: string[] = [];
  const fail = (path: string, message: string) => errors.push(`${path}: ${message}`);

  const isObj = (value: unknown, path: string): value is Obj => {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return true;
    fail(path, `must be an object, got ${describe(value)}`);
    return false;
  };
  const onlyKeys = (value: Obj, path: string, allowed: readonly string[]) => {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) fail(join(path, key), `is not a known field`);
    }
  };
  const str = (value: Obj, key: string, path: string, pattern?: RegExp, hint?: string) => {
    const v = value[key];
    if (typeof v !== 'string' || v.trim() === '') {
      fail(join(path, key), `must be a non-empty string, got ${describe(v)}`);
      return;
    }
    if (pattern && !pattern.test(v)) fail(join(path, key), `${hint}, got ${JSON.stringify(v)}`);
  };
  const positiveInt = (v: unknown, path: string) => {
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1) return true;
    fail(path, `must be a whole number of at least 1, got ${describe(v)}`);
    return false;
  };
  const array = (value: Obj, key: string, path: string): unknown[] => {
    const v = value[key];
    if (Array.isArray(v)) return v;
    fail(join(path, key), `must be an array, got ${describe(v)}`);
    return [];
  };
  const range = (item: Obj, path: string) => {
    const lines = item.lines;
    const at = join(path, 'lines');
    if (!isObj(lines, at)) return;
    onlyKeys(lines, at, ['start', 'end']);
    const start = positiveInt(lines.start, join(at, 'start'));
    const end = positiveInt(lines.end, join(at, 'end'));
    if (start && end && (lines.end as number) < (lines.start as number)) {
      fail(join(at, 'end'), `must not be before start (${lines.end} < ${lines.start})`);
    }
  };
  const codeRanges = (value: Obj, key: string, textKey: string) => {
    const items = array(value, key, '');
    items.forEach((item, i) => {
      const path = `${key}[${i}]`;
      if (!isObj(item, path)) return;
      onlyKeys(item, path, ['file', 'lines', textKey]);
      str(item, 'file', path);
      range(item, path);
      str(item, textKey, path);
    });
    return items;
  };

  if (!isObj(input, '(root)')) return { ok: false, errors };
  const m = input;
  onlyKeys(m, '', [
    'id',
    'visibility',
    'source',
    'license',
    'title',
    'size',
    'jobs',
    'expectedFindings',
    'mustNotSkip',
    'expectDangerFlag',
    'evidence',
  ]);

  str(m, 'id', '', ID, 'must be kebab-case, like "hono-4813-cors-credentials"');
  if (m.visibility !== 'public' && m.visibility !== 'private') {
    fail('visibility', `must be "public" or "private", got ${describe(m.visibility)}`);
  }

  if (isObj(m.source, 'source')) {
    onlyKeys(m.source, 'source', ['repo', 'pr', 'base', 'head']);
    str(m.source, 'repo', 'source', REPO, 'must look like "owner/name"');
    positiveInt(m.source.pr, 'source.pr');
    str(m.source, 'base', 'source', SHA, 'must be a full 40-character lowercase commit SHA');
    str(m.source, 'head', 'source', SHA, 'must be a full 40-character lowercase commit SHA');
    if (typeof m.source.base === 'string' && m.source.base === m.source.head) {
      fail('source.head', 'must differ from source.base');
    }
  }

  str(m, 'license', '');
  str(m, 'title', '');
  if (!SIZES.includes(m.size as Size)) {
    fail('size', `must be one of ${SIZES.join(', ')}; got ${describe(m.size)}`);
  }

  const jobs = array(m, 'jobs', '');
  if (Array.isArray(m.jobs) && jobs.length === 0) fail('jobs', 'must name at least one job');
  jobs.forEach((job, i) => {
    if (!JOBS.includes(job as Job)) {
      fail(`jobs[${i}]`, `must be one of ${JOBS.join(', ')}; got ${describe(job)}`);
    } else if (jobs.indexOf(job) !== i) {
      fail(`jobs[${i}]`, `repeats ${JSON.stringify(job)}`);
    }
  });

  const findings = codeRanges(m, 'expectedFindings', 'description');
  const mustNotSkip = codeRanges(m, 'mustNotSkip', 'reason');

  if (typeof m.expectDangerFlag !== 'boolean') {
    fail('expectDangerFlag', `must be true or false, got ${describe(m.expectDangerFlag)}`);
  }

  const evidence = array(m, 'evidence', '');
  if (Array.isArray(m.evidence) && evidence.length === 0) {
    fail('evidence', 'must link at least one source for the ground truth');
  }
  evidence.forEach((item, i) => {
    const path = `evidence[${i}]`;
    if (!isObj(item, path)) return;
    onlyKeys(item, path, ['url', 'note']);
    str(item, 'url', path, /^https:\/\/\S+$/, 'must be an https URL');
    str(item, 'note', path);
  });

  // Rules across fields. Only checked once the shape is right, so messages stay specific.
  if (errors.length === 0) {
    const manifest = m as unknown as FixtureManifest;
    if (manifest.expectDangerFlag && !manifest.jobs.includes('danger')) {
      fail('expectDangerFlag', 'is true, so jobs must include "danger"');
    }
    if (manifest.jobs.includes('tour') && findings.length === 0) {
      fail('expectedFindings', 'must not be empty when jobs include "tour"');
    }
    manifest.expectedFindings.forEach((finding, i) => {
      const covered = mustNotSkip.some((entry) => contains(entry as MustNotSkip, finding));
      if (!covered) {
        fail(
          `expectedFindings[${i}]`,
          `${finding.file}:${finding.lines.start}-${finding.lines.end} must also be inside a mustNotSkip range, since the tour can't surface code it skipped`,
        );
      }
    });
  }

  return errors.length === 0
    ? { ok: true, manifest: m as unknown as FixtureManifest }
    : { ok: false, errors };
}

function contains(outer: MustNotSkip, inner: ExpectedFinding): boolean {
  return (
    outer.file === inner.file &&
    outer.lines.start <= inner.lines.start &&
    inner.lines.end <= outer.lines.end
  );
}

function join(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

function describe(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'object') return 'an object';
  return `${typeof value} ${String(value)}`;
}
