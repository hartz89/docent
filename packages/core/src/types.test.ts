// The rules marked "(type)" in SPEC.md, checked at compile time: each @ts-expect-error line is
// an illegal state, and `pnpm verify` (tsc -b) fails if any of them stops being a type error.
import { expect, test } from 'vitest';
import type { Anchor } from './anchor.ts';
import { base } from './arbitraries.ts';
import type { BatchItem, SentBatch } from './batch.ts';
import type { Job } from './cost.ts';
import type { DiffFile } from './diff.ts';
import { type Answer, type QuestionThread, threadId } from './question.ts';
import { type Review, reviewId } from './review.ts';
import { type Skip, type Stop, stopId, type Tour } from './tour.ts';

test('illegal states do not typecheck', () => {
  // R2: ids and commits can't be swapped.
  // @ts-expect-error a stop id is not a review id
  const _review: Review = { id: stopId('s'), pr: { repo: 'o/r', number: 1 }, base, head: base };
  const _commit: Review = {
    id: reviewId('r'),
    pr: { repo: 'o/r', number: 1 },
    // @ts-expect-error a review id is not a commit
    base: reviewId('r'),
    head: base,
  };

  // A1: an anchor cites at least one line.
  const _empty: Anchor = {
    state: 'current',
    // @ts-expect-error no lines
    lines: [],
    at: { commit: base, path: 'a', startLine: 1 },
  };

  // A2: an out-of-date anchor has no current location to read.
  const stale: Anchor = {
    state: 'out_of_date',
    lines: ['x'],
    lastSeen: { commit: base, path: 'a', startLine: 1 },
  };
  // @ts-expect-error `at` exists only once narrowed to current
  const _at = stale.at;

  // T3: core-change and edge stops cite code.
  // @ts-expect-error no anchors on a core change
  const _stop: Stop = { id: stopId('s'), kind: 'core_change', title: '', body: '', anchors: [] };

  // S2: a skip reason comes only from oneLine().
  // @ts-expect-error a plain string is not a OneLine
  const _skip: Skip = { target: { kind: 'file', path: 'a' }, reason: 'lockfile' };

  // Q3: the guide's answers carry no answer check.
  // @ts-expect-error guide answers are never checked
  const _answer: Answer = { source: 'guide', text: '', check: { state: 'passed' } };

  // B4: a sent batch is never empty.
  const _batch: SentBatch = {
    state: 'sent',
    number: 1 as SentBatch['number'],
    // @ts-expect-error no items
    items: [],
    sentAt: base,
  };

  // R1: a review always has both commits.
  // @ts-expect-error no head commit
  const _noHead: Review = { id: reviewId('r'), pr: { repo: 'o/r', number: 1 }, base };

  // D1: a diff file always says where it lived at base.
  // @ts-expect-error no oldPath
  const _file: DiffFile = { path: 'a', hunks: [] };

  // T1: a tour is written for one head commit.
  // @ts-expect-error no head commit
  const _tour: Tour = { review: reviewId('r'), stops: [], skips: [] };

  // T2: stop kinds are a closed list.
  // @ts-expect-error not a stop kind
  const _kind: Stop = { id: stopId('s'), kind: 'summary', title: '', body: '', anchors: [] };

  // S1: a skip targets a file or a hunk, nothing else.
  // @ts-expect-error not a skip target
  const _target: Skip['target'] = { kind: 'line', path: 'a' };

  // Q1: only the latest exchange can be waiting.
  const _thread: QuestionThread = {
    id: threadId('t'),
    anchor: stale,
    // @ts-expect-error an earlier exchange still waiting
    earlier: [{ question: 'why?', answer: { state: 'waiting' } }],
    latest: { question: 'and?', answer: { state: 'waiting' } },
  };

  // Q2: an author answer always names its session.
  // @ts-expect-error no session id
  const _author: Answer = { source: 'author_session', text: '', check: { state: 'pending' } };

  // B1: a suggestion always carries its replacement lines.
  // @ts-expect-error no replacement
  const _suggestion: BatchItem = { kind: 'suggestion', anchor: stale, comment: '' };

  // K1: jobs are a closed list, so a typo is caught.
  // @ts-expect-error a typo
  const _job: Job = 'tuor';

  expect(true).toBe(true);
});
