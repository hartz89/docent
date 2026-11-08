// Ties SPEC.md to the tests: every invariant is named by a test, and every name is real.
// A citation counts only in a test's name, not in a comment, so each rule has a test of its own.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const here = import.meta.dirname;
const spec = readFileSync(join(here, '..', 'SPEC.md'), 'utf8');
const invariants = [...spec.matchAll(/^- \*\*([A-Z]\d+)\.\*\*/gm)].map((m) => m[1]);

const testNames = readdirSync(here)
  .filter((name) => name.endsWith('.test.ts') && name !== 'spec.test.ts')
  .flatMap((name) => [
    ...readFileSync(join(here, name), 'utf8').matchAll(/\btest\(\s*(['"`])(.*?)\1/gs),
  ])
  .map((m) => m[2] ?? '');
const cited = new Set(
  testNames.flatMap((name) => [...name.matchAll(/\b([A-Z]\d+)\b/g)].map((m) => m[1])),
);

test('the spec numbers its invariants uniquely', () => {
  expect(invariants.length).toBeGreaterThan(0);
  expect(new Set(invariants).size).toBe(invariants.length);
});

test('every invariant in SPEC.md is named by a test', () => {
  expect(invariants.filter((id) => !cited.has(id))).toEqual([]);
});

test('every invariant a test names is in SPEC.md', () => {
  expect([...cited].filter((id) => !invariants.includes(id))).toEqual([]);
});
