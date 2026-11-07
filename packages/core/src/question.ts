import type { Anchor } from './anchor.ts';
import type { Brand, NonEmpty, OneLine } from './basics.ts';

export type ThreadId = Brand<string, 'ThreadId'>;
export const threadId = (id: string): ThreadId => id as ThreadId;

/** The author agent's session, as its harness names it. */
export type SessionId = Brand<string, 'SessionId'>;
export const sessionId = (id: string): SessionId => id as SessionId;

/** Q3: the guide's check of an author answer. A flag always cites the lines that contradict it. */
export type AnswerCheck =
  | { readonly state: 'pending' }
  | { readonly state: 'passed' }
  | { readonly state: 'flagged'; readonly note: OneLine; readonly cites: NonEmpty<Anchor> };

/** Q2, Q3: who answered. Only author answers are checked; the guide never checks itself. */
export type Answer =
  | {
      readonly source: 'author_session';
      readonly session: SessionId;
      readonly text: string;
      readonly check: AnswerCheck;
    }
  | { readonly source: 'guide'; readonly text: string };

export type Exchange = {
  readonly question: string;
  readonly answer: { readonly state: 'waiting' } | ({ readonly state: 'answered' } & Answer);
};

export type AnsweredExchange = Exchange & { readonly answer: { readonly state: 'answered' } };

/** Q1: a question asked at an anchor. Only the latest exchange can still be waiting. */
export type QuestionThread = {
  readonly id: ThreadId;
  readonly anchor: Anchor;
  readonly earlier: readonly AnsweredExchange[];
  readonly latest: Exchange;
};
