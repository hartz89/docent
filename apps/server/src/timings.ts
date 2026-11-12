// Where a review's time goes. Everything that times a step calls `span()` here and nothing else,
// so pointing these at a shared run log later is a change to this one file.

/** One timed step, in milliseconds since the review opened. */
export type Span = { name: string; startMs: number; endMs: number; note: string };

export type Timings = {
  /** Starts a span now. Call the returned function, with an optional note, when it ends. */
  span(name: string): (note?: string) => void;
  /** Milliseconds since the timings started. */
  now(): number;
  /** The spans that have ended, in the order they started. */
  spans(): Span[];
};

/** Where spans are also written as they end: the run log, which `docent runs show` reads. */
type SpanSink = { span(name: string): { end(fields?: Record<string, unknown>): void } };

export function timings(sink?: SpanSink): Timings {
  const started = Date.now();
  const now = () => Date.now() - started;
  const all: Span[] = [];
  return {
    span(name) {
      const span = { name, startMs: now(), endMs: -1, note: '' };
      all.push(span);
      const logged = sink?.span(name);
      return (note = '') => {
        if (span.endMs >= 0) return;
        span.endMs = now();
        span.note = note;
        logged?.end({ atMs: span.startMs, ...(note ? { note } : {}) });
      };
    },
    now,
    spans: () => all.filter((s) => s.endMs >= 0).map((s) => ({ ...s })),
  };
}
