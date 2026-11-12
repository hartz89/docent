// Mechanical stop-quality checks: what a script can decide about a tour stop without a model.
// The principle they measure is in docs/research/2026-11-08-first-dogfood.md: a stop's first
// sentence says what changed in behavior, in plain terms, and the stop stays short.

/** Fixed limits, the same for every prompt version, so versions are scored on one scale. */
export const STOP_LIMITS = { maxSentences: 5, maxWords: 100 } as const;

export type StopQuality = {
  firstSentence: string;
  /** The first sentence names code: a `backticked` span or something shaped like a call, `f(`. */
  codeInFirstSentence: boolean;
  sentences: number;
  words: number;
  withinLength: boolean;
};

const BACKTICKED = /`[^`\n]+`/;
// A name directly followed by "(", like `serve(` or `opts.origin(`. "behavior (like" has a space.
const CALL_SHAPED = /[A-Za-z_$][\w$.]*\(/;
const CODE_SPAN = /`[^`\n]*`/g;
// Ends a sentence: . ! or ? then whitespace, unless the period ends a common abbreviation.
const SENTENCE_END = /(?<!\b(?:e\.g|i\.e|vs|etc|cf)\.)(?<=[.!?])\s+/;

/** Splits prose into sentences. Code spans are kept whole, so `a.b()` never splits a sentence. */
export function sentences(text: string): string[] {
  const spans: string[] = [];
  const masked = text.replace(CODE_SPAN, (span) => `\uE000${spans.push(span) - 1}\uE000`);
  return masked
    .split(SENTENCE_END)
    .map((s) => s.replace(/\uE000(\d+)\uE000/g, (_, i: string) => spans[Number(i)] ?? '').trim())
    .filter((s) => s.length > 0);
}

export function stopQuality(body: string): StopQuality {
  const all = sentences(body);
  const firstSentence = all[0] ?? '';
  const words = body.split(/\s+/).filter(Boolean).length;
  return {
    firstSentence,
    codeInFirstSentence: BACKTICKED.test(firstSentence) || CALL_SHAPED.test(firstSentence),
    sentences: all.length,
    words,
    withinLength: all.length <= STOP_LIMITS.maxSentences && words <= STOP_LIMITS.maxWords,
  };
}
