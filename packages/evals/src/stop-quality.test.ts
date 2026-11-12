import { describe, expect, test } from 'vitest';
import { sentences, stopQuality } from './stop-quality.ts';

describe('stop quality, mechanically', () => {
  test('flags the dogfood stop that narrates code, and passes its rewrite', () => {
    // Both from docs/research/2026-11-08-first-dogfood.md.
    const narrated =
      '`serve()` holds the old top-level flow unchanged: start the server, print the token link, open the browser, and register the SIGINT/SIGTERM handlers. The old inline subscribe logging moved into `report()` with the same messages.';
    const guided =
      'The CLI now has two modes. Normal mode is unchanged. The new prepare mode builds the tour and exits. It force-quits on purpose, so stray agent processes can’t hang it. That exit is the one thing worth checking.';

    expect(stopQuality(narrated).codeInFirstSentence).toBe(true);
    expect(stopQuality(guided)).toEqual({
      firstSentence: 'The CLI now has two modes.',
      codeInFirstSentence: false,
      sentences: 5,
      words: 38,
      withinLength: true,
    });
  });

  test('a call-shaped name counts as code even without backticks; a parenthesis after a space does not', () => {
    expect(
      stopQuality('It now calls abortController.abort() on timeout.').codeInFirstSentence,
    ).toBe(true);
    expect(stopQuality('Timeouts now abort the request (always).').codeInFirstSentence).toBe(false);
  });

  test('code spans and abbreviations never split a sentence', () => {
    expect(sentences('It reads `opts.origin. x` first, e.g. for CORS. Then it stops.')).toEqual([
      'It reads `opts.origin. x` first, e.g. for CORS.',
      'Then it stops.',
    ]);
  });

  test('too many sentences or words is over length', () => {
    expect(stopQuality('One. Two. Three. Four. Five. Six.').withinLength).toBe(false);
    expect(stopQuality(`${'word '.repeat(101)}.`).withinLength).toBe(false);
    expect(stopQuality('One. Two. Three. Four. Five.').withinLength).toBe(true);
  });
});
