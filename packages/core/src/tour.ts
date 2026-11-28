import { type Anchor, type FileVersion, reanchor } from './anchor.ts';
import type { Brand, CommitSha, NonEmpty } from './basics.ts';
import type { ReviewId } from './review.ts';

export type StopId = Brand<string, 'StopId'>;
export const stopId = (id: string): StopId => id as StopId;

/** The order stops must appear in (T4). */
export const STOP_KINDS = ['intent', 'map', 'core_change', 'edge', 'verdict_prompt'] as const;
export type StopKind = (typeof STOP_KINDS)[number];

/** T5: what a stop surfaces beyond the change itself. Flags play no part in what it explains. */
export type StopFlag = 'mismatch' | 'danger';

/** T6: a phrase of a stop's body that points at code. */
export type Reference = { readonly phrase: string; readonly anchor: Anchor };

/**
 * T6: a stop's body, as plain text and referenced phrases in reading order. Its text is the
 * parts joined, so a reference can't overlap another or fall outside the text.
 */
export type BodyPart = string | Reference;
export type StopBody = readonly BodyPart[];

type StopText = {
  readonly id: StopId;
  readonly title: string;
  readonly body: StopBody;
  readonly flags: readonly StopFlag[];
};

/** T2, T3: core-change and edge stops always cite code; the others may not. */
export type Stop =
  | (StopText & {
      readonly kind: 'core_change' | 'edge';
      readonly anchors: NonEmpty<Anchor>;
    })
  | (StopText & {
      readonly kind: 'intent' | 'map' | 'verdict_prompt';
      readonly anchors: readonly Anchor[];
    });

/** T1. What it leaves out is the ledger's to say, never the tour's (L4). */
export type Tour = {
  readonly review: ReviewId;
  readonly head: CommitSha;
  readonly stops: readonly Stop[];
};

export type OrderProblem =
  | { readonly kind: 'out_of_order'; readonly stop: StopId }
  | { readonly kind: 'verdict_not_last' };

/** Checks T4. An empty list means the stops are in order and end with one verdict prompt. */
export function checkStopOrder(tour: Tour): OrderProblem[] {
  const problems: OrderProblem[] = [];
  let rank = 0;
  for (const stop of tour.stops) {
    const stopRank = STOP_KINDS.indexOf(stop.kind);
    if (stopRank < rank) problems.push({ kind: 'out_of_order', stop: stop.id });
    rank = Math.max(rank, stopRank);
  }
  const verdicts = tour.stops.filter((stop) => stop.kind === 'verdict_prompt').length;
  if (verdicts !== 1 || tour.stops.at(-1)?.kind !== 'verdict_prompt') {
    problems.push({ kind: 'verdict_not_last' });
  }
  return problems;
}

/** The plain text of a body (T6): what a reader sees, with references as their phrases. */
export const bodyText = (body: StopBody): string =>
  body.map((part) => (typeof part === 'string' ? part : part.phrase)).join('');

/** A body with no references. */
export const plainBody = (text: string): StopBody => (text ? [text] : []);

/**
 * Places references in a body's text (T7). Each, in the order given, takes the first occurrence
 * of its phrase that no earlier one took. A phrase that is blank, spans lines, would split a
 * `code` span, or has no free occurrence comes back in `unplaced`, never guessed at. The text
 * never changes.
 */
export function referBody(
  text: string,
  references: readonly Reference[],
): { body: StopBody; unplaced: Reference[] } {
  const placed: { start: number; end: number; reference: Reference }[] = [];
  const unplaced: Reference[] = [];
  for (const reference of references) {
    const start = freeOccurrence(text, reference.phrase, placed);
    if (start === null) unplaced.push(reference);
    else placed.push({ start, end: start + reference.phrase.length, reference });
  }
  placed.sort((a, b) => a.start - b.start);
  const body: BodyPart[] = [];
  let at = 0;
  for (const { start, end, reference } of placed) {
    if (start > at) body.push(text.slice(at, start));
    body.push(reference);
    at = end;
  }
  if (at < text.length) body.push(text.slice(at));
  return { body, unplaced };
}

const backticks = (text: string) => text.split('`').length - 1;

/** Where a phrase can go: its first occurrence that overlaps nothing taken and splits no code. */
function freeOccurrence(
  text: string,
  phrase: string,
  taken: readonly { start: number; end: number }[],
): number | null {
  if (!phrase.trim() || /[\r\n]/.test(phrase) || backticks(phrase) % 2 !== 0) return null;
  for (let start = text.indexOf(phrase); start !== -1; start = text.indexOf(phrase, start + 1)) {
    const end = start + phrase.length;
    const free = taken.every((t) => end <= t.start || start >= t.end);
    // An even count of backticks before it in its paragraph: the phrase starts outside a `code`
    // span. Code spans never cross a paragraph break, so an odd one earlier can't shift this.
    const paragraph =
      text
        .slice(0, start)
        .split(/\n\s*\n/)
        .at(-1) ?? '';
    if (free && backticks(paragraph) % 2 === 0) return start;
  }
  return null;
}

/**
 * Re-anchors every reference in a body against new versions of its files (T8), the way a stop's
 * anchors re-anchor (A4). `files` gives a file by the path the reference was last at, or null if
 * it's gone. A reference whose code is gone stays, flagged out of date, and the text never changes.
 */
export function reanchorBody(
  body: StopBody,
  files: (path: string) => FileVersion | null,
): StopBody {
  return body.map((part) => {
    if (typeof part === 'string') return part;
    const { anchor } = part;
    const path = anchor.state === 'current' ? anchor.at.path : anchor.lastSeen.path;
    return { phrase: part.phrase, anchor: reanchor(anchor, files(path)) };
  });
}
