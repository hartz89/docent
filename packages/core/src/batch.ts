import type { Anchor } from './anchor.ts';
import type { Brand, CommitSha, NonEmpty, Result } from './basics.ts';

/** B1 */
export type BatchItem =
  | { readonly kind: 'change_request'; readonly anchor: Anchor; readonly comment: string }
  | {
      readonly kind: 'suggestion';
      readonly anchor: Anchor;
      readonly replacement: readonly string[];
      readonly comment: string;
    };

/** B6: 1, 2, 3… within a review. */
export type BatchNumber = Brand<number, 'BatchNumber'>;

/** B2: each state has its own shape. Sent and revised batches are never empty (B4). */
export type DraftBatch = {
  readonly state: 'draft';
  readonly number: BatchNumber;
  readonly items: readonly BatchItem[];
};
export type SentBatch = {
  readonly state: 'sent';
  readonly number: BatchNumber;
  readonly items: NonEmpty<BatchItem>;
  readonly sentAt: CommitSha;
};
export type RevisedBatch = {
  readonly state: 'revised';
  readonly number: BatchNumber;
  readonly items: NonEmpty<BatchItem>;
  readonly sentAt: CommitSha;
  readonly revision: CommitSha;
};
export type Batch = DraftBatch | SentBatch | RevisedBatch;

/** B3: one review's batches. The `sent` slot is the lock. */
export type Batches = {
  readonly draft: DraftBatch;
  readonly sent: { readonly locked: false } | { readonly locked: true; readonly batch: SentBatch };
  readonly revised: readonly RevisedBatch[];
};

/** A review's batches before any feedback: one empty draft, number 1. */
export const noBatches: Batches = {
  draft: { state: 'draft', number: 1 as BatchNumber, items: [] },
  sent: { locked: false },
  revised: [],
};

export function addItem(batches: Batches, item: BatchItem): Batches {
  return { ...batches, draft: { ...batches.draft, items: [...batches.draft.items, item] } };
}

/** B4: sends the draft at the head commit the reviewer saw, and opens a fresh draft. */
export function send(batches: Batches, head: CommitSha): Result<Batches, 'locked' | 'empty'> {
  if (batches.sent.locked) return { ok: false, reason: 'locked' };
  const { draft } = batches;
  const [first, ...rest] = draft.items;
  if (first === undefined) return { ok: false, reason: 'empty' };
  const batch: SentBatch = {
    state: 'sent',
    number: draft.number,
    items: [first, ...rest],
    sentAt: head,
  };
  return {
    ok: true,
    value: {
      draft: { state: 'draft', number: (draft.number + 1) as BatchNumber, items: [] },
      sent: { locked: true, batch },
      revised: batches.revised,
    },
  };
}

/** B5: records the commit the author produced for the sent batch, and frees the lock. */
export function revise(batches: Batches, revision: CommitSha): Result<Batches, 'nothing_sent'> {
  if (!batches.sent.locked) return { ok: false, reason: 'nothing_sent' };
  const revised: RevisedBatch = { ...batches.sent.batch, state: 'revised', revision };
  return {
    ok: true,
    value: { ...batches, sent: { locked: false }, revised: [...batches.revised, revised] },
  };
}
