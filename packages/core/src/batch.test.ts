import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { Anchor } from './anchor.ts';
import { base, head } from './arbitraries.testing.ts';
import { commitSha, type OneLine, oneLine } from './basics.ts';
import {
  abandon,
  addItem,
  type Batches,
  type BatchItem,
  noBatches,
  revise,
  send,
} from './batch.ts';

const anchor: Anchor = {
  state: 'current',
  lines: ['x'],
  context: { before: [], after: [] },
  at: { commit: base, path: 'a.ts', startLine: 1 },
};

const item: fc.Arbitrary<BatchItem> = fc.oneof(
  fc.string().map((comment) => ({ kind: 'change_request' as const, anchor, comment })),
  fc
    .string()
    .map((comment) => ({ kind: 'suggestion' as const, anchor, replacement: ['y'], comment })),
);

type Op = { op: 'add'; item: BatchItem } | { op: 'send' } | { op: 'revise' | 'abandon' };
const ops = fc.array(
  fc.oneof(
    item.map((item): Op => ({ op: 'add', item })),
    fc.constant<Op>({ op: 'send' }),
    fc.constant<Op>({ op: 'revise' }),
    fc.constant<Op>({ op: 'abandon' }),
  ),
  { maxLength: 30 },
);

/** A plain model of the rules, to compare the real thing against. */
type Model = {
  draft: BatchItem[];
  sent: BatchItem[] | null;
  history: { state: 'revised' | 'abandoned'; items: BatchItem[] }[];
};

describe('batches', () => {
  test('B3, B4, B5, B6: any run of adds, sends, revisions and abandons follows the model', () => {
    fc.assert(
      fc.property(ops, (sequence) => {
        let batches: Batches = noBatches;
        const model: Model = { draft: [], sent: null, history: [] };
        const added: BatchItem[] = [];
        for (const step of sequence) {
          if (step.op === 'add') {
            batches = addItem(batches, step.item);
            model.draft.push(step.item);
            added.push(step.item);
          } else if (step.op === 'send') {
            const result = send(batches, head);
            const expected = model.sent ? 'locked' : model.draft.length === 0 ? 'empty' : null;
            if (expected) {
              expect(result).toEqual({ ok: false, reason: expected }); // B4: refused, nothing changes
            } else {
              expect(result.ok).toBe(true);
              if (result.ok) batches = result.value;
              model.sent = model.draft;
              model.draft = [];
            }
          } else {
            const result =
              step.op === 'revise'
                ? revise(batches, commitSha('r'.repeat(40)))
                : abandon(batches, oneLine('session failed') as OneLine);
            if (model.sent === null) {
              expect(result).toEqual({ ok: false, reason: 'nothing_sent' }); // B5
            } else {
              expect(result.ok).toBe(true);
              if (result.ok) batches = result.value;
              model.history.push({
                state: step.op === 'revise' ? 'revised' : 'abandoned',
                items: model.sent,
              });
              model.sent = null;
            }
          }

          // B3: the lock is held exactly while a batch is sent.
          expect(batches.sent.locked).toBe(model.sent !== null);
          expect(batches.draft.items).toEqual(model.draft);
          expect(batches.history.map(({ state, items }) => ({ state, items }))).toEqual(
            model.history,
          );
          // B6: numbers count up from 1 with no gaps: history, then sent, then the draft.
          const numbers = [
            ...batches.history.map((b) => b.number),
            ...(batches.sent.locked ? [batches.sent.batch.number] : []),
            batches.draft.number,
          ];
          expect(numbers).toEqual(numbers.map((_, i) => i + 1));
          // B6: every item is in exactly one batch, in the order it was added.
          expect([
            ...batches.history.flatMap((b) => b.items),
            ...(batches.sent.locked ? batches.sent.batch.items : []),
            ...batches.draft.items,
          ]).toEqual(added);
        }
      }),
    );
  });

  test('B2: a sent batch records the head it was sent at; a revised one adds the new commit', () => {
    const revision = commitSha('r'.repeat(40));
    const sent = send(
      addItem(noBatches, { kind: 'change_request', anchor, comment: 'rename' }),
      head,
    );
    if (!sent.ok || !sent.value.sent.locked) throw new Error('expected a sent batch');
    expect(sent.value.sent.batch).toMatchObject({ state: 'sent', number: 1, sentAt: head });
    const revised = revise(sent.value, revision);
    if (!revised.ok) throw new Error('expected a revised batch');
    expect(revised.value.history).toMatchObject([
      { state: 'revised', number: 1, sentAt: head, revision },
    ]);
  });

  test('B5: abandoning a sent batch keeps its items and reason, and frees the lock', () => {
    const reason = oneLine('author session crashed') as OneLine;
    const sent = send(addItem(noBatches, { kind: 'change_request', anchor, comment: 'x' }), head);
    if (!sent.ok) throw new Error('expected a sent batch');
    const abandoned = abandon(sent.value, reason);
    if (!abandoned.ok) throw new Error('expected an abandoned batch');
    expect(abandoned.value.sent.locked).toBe(false);
    expect(abandoned.value.history).toMatchObject([{ state: 'abandoned', number: 1, reason }]);
    const again = send(
      addItem(abandoned.value, { kind: 'change_request', anchor, comment: 'y' }),
      head,
    );
    expect(again.ok).toBe(true);
  });
});
