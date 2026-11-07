// Ties SPEC.md to the tests: every invariant is cited by a test, and every citation is real.
// Node types come in for this file only; the engine itself stays plain TypeScript.
/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const here = import.meta.dirname;
const spec = readFileSync(join(here, '..', 'SPEC.md'), 'utf8');
const invariants = [...spec.matchAll(/^- \*\*([A-Z]\d+)\.\*\*/gm)].map((m) => m[1]);

const tests = readdirSync(here)
  .filter((name) => name.endsWith('.test.ts') && name !== 'spec.test.ts')
  .map((name) => readFileSync(join(here, name), 'utf8'))
  .join('\n');
const cited = new Set([...tests.matchAll(/\b([RDATSCQBK]\d+)\b/g)].map((m) => m[1]));

test('the spec numbers its invariants uniquely', () => {
  expect(invariants.length).toBeGreaterThan(0);
  expect(new Set(invariants).size).toBe(invariants.length);
});

test('every invariant in SPEC.md is cited by a test', () => {
  expect(invariants.filter((id) => !cited.has(id))).toEqual([]);
});

test('every invariant a test cites is in SPEC.md', () => {
  expect([...cited].filter((id) => !invariants.includes(id))).toEqual([]);
});
