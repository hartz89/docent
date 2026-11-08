import type { Brand, CommitSha } from './basics.ts';

export type ReviewId = Brand<string, 'ReviewId'>;
export const reviewId = (id: string): ReviewId => id as ReviewId;

/** One pull request, read at a base commit and a head commit (R1). */
export type Review = {
  readonly id: ReviewId;
  readonly pr: { readonly repo: `${string}/${string}`; readonly number: number };
  readonly base: CommitSha;
  readonly head: CommitSha;
};
