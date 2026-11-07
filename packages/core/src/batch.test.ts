import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { Anchor } from './anchor.ts';
import { base, head } from './arbitraries.ts';
import { commitSha } from './basics.ts';
import { addItem, type Batches, type BatchItem, noBatches, revise, send } from './batch.ts';

const anchor: Anchor = {
  state: 'current',
  lines: ['x'],
  at: { commit: base, path: 'a.ts', startLine: 1 },
};

const item: fc.Arbitrary<BatchItem> = fc.oneof(
  fc.string().map((comment) => ({ kind: 'change_request' as const, anchor, comment })),
  fc
    .string()
    .map((comment) => ({ kind: 'suggestion' as const, anchor, replacement: ['y'], comment })),
);

type Op = { op: 'add'; item: BatchItem } | { op: 'send' } | { op: 'revise' };
const ops = fc.array(
  fc.oneof(
    item.map((item): Op => ({ op: 'add', item })),
    fc.constant<Op>({ op: 'send' }),
    fc.constant<Op>({ op: 'revise' }),
  ),
  { maxLength: 30 },
);

/** A plain model of the rules, to compare the real thing against. */
type Model = { draft: BatchItem[]; sent: BatchItem[] | null; revised: BatchItem[][] };

describe('batches', () => {
  test('B3–B6: any sequence of adds, sends and revisions follows the model, lock included', () => {
    fc.assert(
      fc.property(ops, (sequence) => {
        let batches: Batches = noBatches;
        const model: Model = { draft: [], sent: null, revised: [] };
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
            const result = revise(batches, commitSha('r'.repeat(40)));
            if (model.sent === null) {
              expect(result).toEqual({ ok: false, reason: 'nothing_sent' }); // B5
            } else {
              expect(result.ok).toBe(true);
              if (result.ok) batches = result.value;
              model.revised.push(model.sent);
              model.sent = null;
            }
          }

          // B3: the lock is held exactly while a batch is sent.
          expect(batches.sent.locked).toBe(model.sent !== null);
          expect(batches.draft.items).toEqual(model.draft);
          expect(batches.revised.map((b) => b.items)).toEqual(model.revised);
          // B6: numbers count up from 1 with no gaps: revised, then sent, then the draft.
          const numbers = [
            ...batches.revised.map((b) => b.number),
            ...(batches.sent.locked ? [batches.sent.batch.number] : []),
            batches.draft.number,
          ];
          expect(numbers).toEqual(numbers.map((_, i) => i + 1));
          // B6: every item is in exactly one batch, in the order it was added.
          expect([
            ...batches.revised.flatMap((b) => b.items),
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
    expect(revised.value.revised).toMatchObject([
      { state: 'revised', number: 1, sentAt: head, revision },
    ]);
  });
});
