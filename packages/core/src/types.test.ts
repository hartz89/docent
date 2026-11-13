// The rules marked "(type)" in SPEC.md, checked at compile time: each @ts-expect-error line is
// an illegal state, and `pnpm verify` (tsc -b) fails if any of them stops being a type error.
// The runtime assertions are trivial; the value is in the type checking.
import { describe, expect, test } from 'vitest';
import type { Anchor } from './anchor.ts';
import { base } from './arbitraries.testing.ts';
import type { AbandonedBatch, BatchItem, SentBatch } from './batch.ts';
import type { CostRecord, Job } from './cost.ts';
import type { DiffFile } from './diff.ts';
import type { Placement } from './ledger.ts';
import type { Evidence, Proof } from './proof.ts';
import { type Answer, type Exchange, type QuestionThread, threadId } from './question.ts';
import { type Review, reviewId } from './review.ts';
import { type Stop, stopId, type Tour } from './tour.ts';

const at = { commit: base, path: 'a', startLine: 1 };
const context = { before: [], after: [] };
const stale: Anchor = { state: 'out_of_date', lines: ['x'], context, lastSeen: at };
const pr = { repo: 'o/r', number: 1 } as const;
const typechecks = () => expect(true).toBe(true);

describe('illegal states do not typecheck', () => {
  test('R1: a review always has both commits', () => {
    // @ts-expect-error no head commit
    const _r: Review = { id: reviewId('r'), pr, base };
    typechecks();
  });

  test('R2: ids and commits cannot be swapped', () => {
    // @ts-expect-error a stop id is not a review id
    const _r: Review = { id: stopId('s'), pr, base, head: base };
    // @ts-expect-error a review id is not a commit
    const _c: Review = { id: reviewId('r'), pr, base: reviewId('r'), head: base };
    typechecks();
  });

  test('D1: a diff file always says where it lived at base', () => {
    // @ts-expect-error no oldPath
    const _f: DiffFile = { path: 'a', hunks: [] };
    typechecks();
  });

  test('A1: an anchor cites at least one line, and keeps its context', () => {
    // @ts-expect-error no lines
    const _empty: Anchor = { state: 'current', lines: [], context, at };
    // @ts-expect-error no context
    const _bare: Anchor = { state: 'current', lines: ['x'], at };
    typechecks();
  });

  test('A2: an out-of-date anchor has no current location to read', () => {
    // @ts-expect-error `at` exists only once narrowed to current
    const _at = stale.at;
    typechecks();
  });

  test('T1: a tour is written for one head commit', () => {
    // @ts-expect-error no head commit
    const _t: Tour = { review: reviewId('r'), stops: [] };
    typechecks();
  });

  test('T2: stop kinds are a closed list', () => {
    const _s: Stop = {
      id: stopId('s'),
      // @ts-expect-error not a stop kind
      kind: 'summary',
      title: '',
      body: '',
      flags: [],
      anchors: [],
    };
    typechecks();
  });

  test('T3: core-change and edge stops cite code', () => {
    // @ts-expect-error no anchors on a core change
    const _s: Stop = {
      id: stopId('s'),
      kind: 'core_change',
      title: '',
      body: '',
      flags: [],
      anchors: [],
    };
    typechecks();
  });

  test('T5: stop flags are a closed list', () => {
    const _s: Stop = {
      id: stopId('s'),
      kind: 'map',
      title: '',
      body: '',
      // @ts-expect-error not a flag
      flags: ['nit'],
      anchors: [],
    };
    typechecks();
  });

  test('Q1: only the latest exchange can be waiting', () => {
    const _t: QuestionThread = {
      id: threadId('t'),
      anchor: stale,
      // @ts-expect-error an earlier exchange still waiting
      earlier: [{ question: 'why?', askedAt: base, answer: { state: 'waiting' } }],
      latest: { question: 'and?', askedAt: base, answer: { state: 'waiting' } },
    };
    typechecks();
  });

  test('Q2: an author answer always names its session', () => {
    // @ts-expect-error no session id
    const _a: Answer = { source: 'author_session', text: '', check: { state: 'pending' } };
    typechecks();
  });

  test('Q3: the guide never checks its own answers', () => {
    // @ts-expect-error guide answers carry no check
    const _a: Answer = { source: 'guide', text: '', check: { state: 'passed' } };
    typechecks();
  });

  test('Q4: an exchange records the commit it was asked at', () => {
    // @ts-expect-error no askedAt
    const _e: Exchange = { question: 'why?', answer: { state: 'waiting' } };
    typechecks();
  });

  test('B1: a suggestion always carries its replacement lines', () => {
    // @ts-expect-error no replacement
    const _s: BatchItem = { kind: 'suggestion', anchor: stale, comment: '' };
    typechecks();
  });

  test('B2: an abandoned batch always says why', () => {
    const item: BatchItem = { kind: 'change_request', anchor: stale, comment: '' };
    const number = 1 as AbandonedBatch['number'];
    // @ts-expect-error no reason
    const _b: AbandonedBatch = { state: 'abandoned', number, items: [item], sentAt: base };
    typechecks();
  });

  test('B3: the lock slot holds a batch only while locked', () => {
    const _s: SentBatch = {
      state: 'sent',
      number: 1 as SentBatch['number'],
      // @ts-expect-error a sent batch is never empty
      items: [],
      sentAt: base,
    };
    typechecks();
  });

  test('K1: jobs are a closed list, so a typo is caught', () => {
    // @ts-expect-error a typo
    const _j: Job = 'tuor';
    typechecks();
  });

  test('K2: a plain number is not a micro-dollar amount', () => {
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    // @ts-expect-error costMicroUsd must come from microUsd()
    const _c: CostRecord = { job: 'tour', model: 'm', tokens, costMicroUsd: 0.5, latencyMs: 1 };
    typechecks();
  });

  test('P1: only a detector makes a proof, and its evidence is never empty', () => {
    const plain = {
      target: { kind: 'file', path: 'a' },
      evidence: { label: 'whitespace' },
    } as const;
    // @ts-expect-error a plain object is not a proof
    const _p: Proof = { ...plain, judgedAt: base };
    // @ts-expect-error a rename proof names at least one change
    const _e: Evidence = { label: 'rename', changes: [] };
    // @ts-expect-error a lockfile proof names at least one manifest
    const _l: Evidence = { label: 'lockfile', manifests: [] };
    typechecks();
  });

  test('L1: a ledger line has exactly one place', () => {
    // @ts-expect-error on the route means some stop explains it
    const _a: Placement = { kind: 'on_route', stops: [] };
    // @ts-expect-error a proven skip carries at least one proof
    const _b: Placement = { kind: 'proven_skip', proofs: [] };
    // @ts-expect-error a line can't be both off the route and on it
    const _c: Placement = { kind: 'not_on_route', stops: [stopId('s')] };
    typechecks();
  });
});
