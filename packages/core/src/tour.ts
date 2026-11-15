import type { Anchor } from './anchor.ts';
import type { Brand, CommitSha, NonEmpty } from './basics.ts';
import type { ReviewId } from './review.ts';

export type StopId = Brand<string, 'StopId'>;
export const stopId = (id: string): StopId => id as StopId;

/** The order stops must appear in (T4). */
export const STOP_KINDS = ['intent', 'map', 'core_change', 'edge', 'verdict_prompt'] as const;
export type StopKind = (typeof STOP_KINDS)[number];

/** T5: what a stop surfaces beyond the change itself. Flags play no part in what it explains. */
export type StopFlag = 'mismatch' | 'danger';

type StopText = {
  readonly id: StopId;
  readonly title: string;
  readonly body: string;
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
