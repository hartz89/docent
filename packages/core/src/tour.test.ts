import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { anchorAt, type FileVersion } from './anchor.ts';
import { base, head } from './arbitraries.testing.ts';
import { reviewId } from './review.ts';
import {
  bodyText,
  checkStopOrder,
  plainBody,
  type Reference,
  reanchorBody,
  referBody,
  STOP_KINDS,
  type Stop,
  type StopKind,
  stopId,
  type Tour,
} from './tour.ts';

const stop = (kind: StopKind, i: number): Stop =>
  kind === 'core_change' || kind === 'edge'
    ? {
        id: stopId(`s${i}`),
        kind,
        title: '',
        body: [],
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
    : { id: stopId(`s${i}`), kind, title: '', body: [], flags: [], anchors: [] };

const tourOf = (kinds: readonly StopKind[]): Tour => ({
  review: reviewId('r'),
  head,
  stops: kinds.map(stop),
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

const file = (lines: readonly string[], commit = base, path = 'a.ts'): FileVersion => ({
  commit,
  path,
  text: lines.map((line) => `${line}\n`).join(''),
});

/** A reference to one line of a small file, for tests that care only about the phrase. */
const refTo = (phrase: string, line = 2): Reference => {
  const anchor = anchorAt(file(['a();', 'b();', 'c();']), line, 1);
  if (!anchor) throw new Error('no anchor');
  return { phrase, anchor };
};

const words = fc.constantFrom('the', 'retry', 'helper', '`run()`', 'now', 'waits', ',', ' ', '\n');
const texts = fc.array(words, { maxLength: 20 }).map((w) => w.join(' '));

describe('stop bodies', () => {
  test('T7: placing references never changes the text, and each placed phrase sits where it was found', () => {
    fc.assert(
      fc.property(texts, fc.array(fc.oneof(words, texts), { maxLength: 5 }), (text, phrases) => {
        const { body, unplaced } = referBody(
          text,
          phrases.map((p) => refTo(p)),
        );
        expect(bodyText(body)).toBe(text);
        const placed = body.filter((p) => typeof p !== 'string');
        expect(placed.length + unplaced.length).toBe(phrases.length);
        let at = 0;
        for (const part of body) {
          const phrase = typeof part === 'string' ? part : part.phrase;
          expect(text.slice(at, at + phrase.length)).toBe(phrase);
          at += phrase.length;
        }
      }),
    );
  });

  test('T7: each phrase takes its first free occurrence, in the order given', () => {
    const { body } = referBody('a retry, then a retry again', [refTo('retry'), refTo('retry', 3)]);
    expect(body).toEqual(['a ', refTo('retry'), ', then a ', refTo('retry', 3), ' again']);
  });

  test('T7: blank, multi-line, missing and code-splitting phrases are unplaced, not guessed', () => {
    const text = 'The helper calls `run(a, b)` once.\n\nThen it waits.';
    const bad = ['', '  ', 'once.\n\nThen', 'missing', 'run(a', '`run(a', 'b)` once'];
    const { body, unplaced } = referBody(
      text,
      bad.map((p) => refTo(p)),
    );
    expect(body).toEqual([text]);
    expect(unplaced.map((r) => r.phrase)).toEqual(bad);
    // A stray backtick in an earlier paragraph doesn't let a later code span be split.
    const stray = 'A stray ` here.\n\nThen `run(a, b)` once.';
    expect(referBody(stray, [refTo('run(a, b)` once')]).unplaced).toHaveLength(1);
    expect(referBody(stray, [refTo('`run(a, b)`')]).unplaced).toEqual([]);
    // A whole code span, or prose around it, is fine.
    expect(referBody(text, [refTo('`run(a, b)`'), refTo('Then it waits')]).unplaced).toEqual([]);
  });

  test('T6: a body with no references is its plain text', () => {
    expect(bodyText(plainBody('Plain words.'))).toBe('Plain words.');
    expect(plainBody('')).toEqual([]);
    expect(referBody('Plain words.', []).body).toEqual(plainBody('Plain words.'));
  });

  test('T8: re-anchoring a body follows moved code and flags gone code, keeping the text', () => {
    const { body } = referBody('It runs B, then C.', [refTo('B', 2), refTo('C', 3)]);
    // b moves down a line; c is deleted.
    const next = file(['a();', 'x();', 'b();'], head);
    const healed = reanchorBody(body, () => next);
    expect(bodyText(healed)).toBe(bodyText(body));
    const [b, c] = healed.filter((p) => typeof p !== 'string');
    expect(b?.anchor).toMatchObject({ state: 'current', at: { commit: head, startLine: 3 } });
    expect(c?.anchor).toMatchObject({ state: 'out_of_date', lastSeen: { startLine: 3 } });
  });

  test('T8: a healed reference never points at the wrong lines, and a deleted file flags it', () => {
    const lineSets = fc.array(fc.constantFrom('a();', 'b();', 'c();', '}'), { maxLength: 8 });
    fc.assert(
      fc.property(lineSets, (lines) => {
        const { body } = referBody('a b c', [refTo('a', 1), refTo('b', 2), refTo('c', 3)]);
        const next = file(lines, head);
        for (const part of reanchorBody(body, () => next)) {
          if (typeof part === 'string' || part.anchor.state !== 'current') continue;
          const start = part.anchor.at.startLine;
          expect(lines.slice(start - 1, start - 1 + part.anchor.lines.length)).toEqual(
            part.anchor.lines,
          );
        }
      }),
    );
    const { body } = referBody('a', [refTo('a', 1)]);
    expect(reanchorBody(body, () => null)).toMatchObject([{ anchor: { state: 'out_of_date' } }]);
  });
});
