import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  DEFAULT_SCORING,
  loadFixtures,
  PUBLIC_FIXTURES_DIR,
  scoringFor,
  validateManifest,
} from './index.ts';

describe('the committed public fixtures', () => {
  test('all validate, with ids matching file names', () => {
    const { manifests, problems } = loadFixtures(PUBLIC_FIXTURES_DIR, 'public');

    expect(problems).toEqual([]);
    expect(manifests.length).toBeGreaterThanOrEqual(8);
  });
});

/** A small valid manifest. Each test breaks one thing. */
const valid = () => ({
  id: 'demo-1-example',
  visibility: 'public',
  source: {
    repo: 'owner/name',
    pr: 1,
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
  },
  license: 'MIT',
  title: 'Example PR',
  size: 'small',
  jobs: ['tour'],
  expectedFindings: [{ file: 'src/a.ts', lines: { start: 3, end: 4 }, description: 'Bug.' }],
  mustNotSkip: [{ file: 'src/a.ts', lines: { start: 1, end: 10 }, reason: 'The change.' }],
  expectDangerFlag: false,
  evidence: [{ url: 'https://github.com/owner/name/pull/2', note: 'The fix.' }],
});

const errorsFor = (manifest: unknown) => {
  const result = validateManifest(manifest);
  return result.ok ? [] : result.errors;
};

describe('validateManifest', () => {
  test('accepts a well-formed manifest', () => {
    expect(validateManifest(valid())).toEqual({ ok: true, manifest: valid() });
  });

  test.each([
    ['a non-object', () => 'nope', '(root): must be an object, got "nope"'],
    [
      'a missing field',
      () => ({ ...valid(), license: undefined }),
      'license: must be a non-empty string, got nothing',
    ],
    ['an unknown field', () => ({ ...valid(), diff: '...' }), 'diff: is not a known field'],
    [
      'a short SHA',
      () => ({ ...valid(), source: { ...valid().source, head: 'abc123' } }),
      'source.head: must be a full 40-character lowercase commit SHA, got "abc123"',
    ],
    [
      'an unknown job',
      () => ({ ...valid(), jobs: ['tour', 'vibes'] }),
      'jobs[1]: must be one of tour, skip, danger, answer-check, scrubber; got "vibes"',
    ],
    [
      'a backwards line range',
      () => ({
        ...valid(),
        mustNotSkip: [{ file: 'src/a.ts', lines: { start: 9, end: 2 }, reason: 'x' }],
      }),
      'mustNotSkip[0].lines.end: must not be before start (2 < 9)',
    ],
    [
      'a zero line number',
      () => ({
        ...valid(),
        expectedFindings: [{ file: 'src/a.ts', lines: { start: 0, end: 2 }, description: 'x' }],
      }),
      'expectedFindings[0].lines.start: must be a whole number of at least 1, got number 0',
    ],
    [
      'no evidence',
      () => ({ ...valid(), evidence: [] }),
      'evidence: must link at least one source for the ground truth',
    ],
    [
      'a danger flag without the danger job',
      () => ({ ...valid(), expectDangerFlag: true }),
      'expectDangerFlag: is true, so jobs must include "danger"',
    ],
    [
      'a tour fixture with nothing to find',
      () => ({ ...valid(), expectedFindings: [] }),
      'expectedFindings: must not be empty when jobs include "tour", unless negativeControl is true',
    ],
    [
      'a negative control expecting a danger flag',
      () => ({
        ...valid(),
        negativeControl: true,
        jobs: ['danger'],
        expectedFindings: [],
        mustNotSkip: [],
        expectDangerFlag: true,
      }),
      'expectDangerFlag: must be false for a negative control',
    ],
    [
      'a finding the skip decision could collapse',
      () => ({ ...valid(), mustNotSkip: [] }),
      "expectedFindings[0]: src/a.ts:3-4 must also be inside a mustNotSkip range, since the tour can't surface code it skipped",
    ],
    [
      'a blank externalKnowledge',
      () => ({
        ...valid(),
        expectedFindings: [{ ...valid().expectedFindings[0], externalKnowledge: ' ' }],
      }),
      'expectedFindings[0].externalKnowledge: must be a non-empty string, got " "',
    ],
    [
      'a shouldSkip that overlaps mustNotSkip',
      () => ({ ...valid(), shouldSkip: [{ file: 'src/a.ts', reason: 'Noise.' }] }),
      'shouldSkip[0]: src/a.ts overlaps mustNotSkip src/a.ts:1-10',
    ],
    [
      'a negative tolerance',
      () => ({ ...valid(), scoring: { toleranceLines: -1 } }),
      'scoring.toleranceLines: must be a whole number of at least 0, got number -1',
    ],
  ])('rejects %s with a clear message', (_name, build, message) => {
    expect(errorsFor(build())).toEqual([message]);
  });

  test('accepts a negative control on the tour, and fills scoring defaults', () => {
    const control = {
      ...valid(),
      negativeControl: true,
      expectedFindings: [],
      mustNotSkip: [],
      shouldSkip: [{ file: 'README.md', reason: 'Typo fix.' }],
      scoring: { maxStops: 2 },
    };
    const result = validateManifest(control);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(scoringFor(result.manifest)).toEqual({ ...DEFAULT_SCORING, maxStops: 2 });
    }
  });

  test('reports every problem at once', () => {
    const errors = errorsFor({ ...valid(), id: 'Not Kebab', size: 'huge', title: '' });

    expect(errors).toEqual([
      'id: must be kebab-case, like "hono-4813-cors-credentials", got "Not Kebab"',
      'title: must be a non-empty string, got ""',
      'size: must be one of small, medium, large; got "huge"',
    ]);
  });
});

describe('loadFixtures', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('names the file for each problem, including a private fixture in the public folder', () => {
    dir = mkdtempSync(join(tmpdir(), 'docent-fixtures-'));
    writeFileSync(join(dir, 'broken.json'), '{ not json');
    writeFileSync(
      join(dir, 'other-name.json'),
      JSON.stringify({ ...valid(), visibility: 'private' }),
    );

    const { problems } = loadFixtures(dir, 'public');

    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/^broken\.json: is not valid JSON/);
    expect(problems.slice(1)).toEqual([
      'other-name.json: id is "demo-1-example", but the file name must match it',
      'other-name.json: visibility must be "public" in this folder',
    ]);
  });
});
