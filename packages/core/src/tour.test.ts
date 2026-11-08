import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { head } from './arbitraries.testing.ts';
import { reviewId } from './review.ts';
import { checkStopOrder, STOP_KINDS, type Stop, type StopKind, stopId, type Tour } from './tour.ts';

const stop = (kind: StopKind, i: number): Stop =>
  kind === 'core_change' || kind === 'edge'
    ? {
        id: stopId(`s${i}`),
        kind,
        title: '',
        body: '',
        flags: [],
        anchors: [
          {
            state: 'current',
            lines: ['x'],
            context: { before: [], after: [] },
            at: { commit: head, path: 'a.ts', startLine: 1 },
          },
        ],
      }
    : { id: stopId(`s${i}`), kind, title: '', body: '', flags: [], anchors: [] };

const tourOf = (kinds: readonly StopKind[]): Tour => ({
  review: reviewId('r'),
  head,
  stops: kinds.map(stop),
  skips: [],
});

const rank = (kind: StopKind) => STOP_KINDS.indexOf(kind);
const nonVerdict = fc.constantFrom(...STOP_KINDS.filter((k) => k !== 'verdict_prompt'));

describe('checkStopOrder', () => {
  test('T4: stops in kind order, ending with one verdict prompt, pass', () => {
    fc.assert(
      fc.property(fc.array(nonVerdict), (kinds) => {
        const ordered = [...kinds].sort((a, b) => rank(a) - rank(b));
        expect(checkStopOrder(tourOf([...ordered, 'verdict_prompt']))).toEqual([]);
      }),
    );
  });

  test('T4: a stop after a later kind is reported', () => {
    fc.assert(
      fc.property(nonVerdict, nonVerdict, (a, b) => {
        fc.pre(rank(a) < rank(b));
        expect(checkStopOrder(tourOf([b, a, 'verdict_prompt']))).toEqual([
          { kind: 'out_of_order', stop: 's1' },
        ]);
      }),
    );
  });

  test('T4: a missing, early or repeated verdict prompt is reported', () => {
    const verdictNotLast = [{ kind: 'verdict_not_last' }];
    expect(checkStopOrder(tourOf(['intent']))).toEqual(verdictNotLast);
    expect(checkStopOrder(tourOf([]))).toEqual(verdictNotLast);
    expect(checkStopOrder(tourOf(['verdict_prompt', 'verdict_prompt']))).toEqual(verdictNotLast);
    expect(checkStopOrder(tourOf(['verdict_prompt', 'edge']))).toContainEqual(verdictNotLast[0]);
  });
});
