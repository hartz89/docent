import { describe, expect, test } from 'vitest';
import { follow } from './follow.ts';

const stop = (kind: string, title: string) => ({ kind, title });
const why = stop('intent', 'Why');
const verdict = stop('verdict_prompt', 'Your call');

describe('which stop the reviewer stays on when the finished tour replaces the streamed one', () => {
  test('a repair that retitles the stop being read, and adds one before it, keeps the reader on it', () => {
    // Streamed: the reviewer is reading the edge stop. The repair rewords it and adds a
    // core_change, which goes after the other core_change stops, so ahead of it.
    const streamed = [why, stop('core_change', 'The origin'), stop('edge', 'The tests')];
    const finished = [
      why,
      stop('core_change', 'The origin'),
      stop('core_change', 'The Vary header'),
      stop('edge', 'The tests, and what they skip'),
      verdict,
    ];

    expect(follow(streamed, 2, finished)).toBe(3);
  });

  test('a stop retitled in place stays where it is', () => {
    const streamed = [why, stop('core_change', 'x')];
    const finished = [why, stop('core_change', 'The origin is reflected'), verdict];

    expect(follow(streamed, 1, finished)).toBe(1);
  });

  test('of two stops with the same title, the reader stays on the one they were reading', () => {
    const streamed = [why, stop('edge', 'Tests'), stop('edge', 'Tests')];
    const finished = [
      why,
      stop('core_change', 'Added'),
      stop('edge', 'Tests'),
      stop('edge', 'Tests'),
    ];

    expect(follow(streamed, 2, finished)).toBe(3);
  });

  test('an update that rewrites an earlier stop of the same kind keeps the reader on theirs', () => {
    // An update shows only the kept stops while the guide works, so the reader's stop is
    // found by its unchanged title, not by its place among the stops of its kind.
    const kept = [why, stop('core_change', 'The helper'), verdict];
    const finished = [
      why,
      stop('core_change', 'The origin, again'),
      stop('core_change', 'The helper'),
      verdict,
    ];

    expect(follow(kept, 1, finished)).toBe(2);
  });

  test('a whole new tour without that stop keeps the reader as close as it can', () => {
    const streamed = [why, stop('map', 'Parts'), stop('edge', 'Tests')];
    const finished = [why, verdict];

    expect(follow(streamed, 2, finished)).toBe(1);
  });

  test('nothing was being read yet: the first stop', () => {
    expect(follow([], 0, [why, verdict])).toBe(0);
  });
});
