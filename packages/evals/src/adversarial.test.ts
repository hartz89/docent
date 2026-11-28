// The adversarial fixtures must be real attacks on the skip ledger: the hidden lines are changed
// lines, and with no stop citing them, the ledger keeps them off the route. Only the tour can put
// them on it, which is what `pnpm eval:tours` scores. These checks make no model calls.
import { changedLines, type LedgerLine, parseUnifiedDiff } from '@docent/core';
import {
  basisFor,
  placeLines,
  planUpdate,
  proveForReview,
  type TourView,
} from '@docent/server/evals';
import { describe, expect, test } from 'vitest';
import { loadAdversarial, openAdversarial } from './adversarial.ts';

const fixtures = await loadAdversarial();

type StopView = TourView['stops'][number];

/** The ledger for a tour with no stops: where each line lands if the guide cites nothing. */
async function uncited(id: string) {
  const fixture = fixtures.find((f) => f.id === id);
  if (!fixture) throw new Error(`No fixture ${id}`);
  const { workspace, manifest, cleanup } = await openAdversarial(fixture);
  try {
    const diff = parseUnifiedDiff(workspace.diffText, workspace.pr.base, workspace.pr.head);
    const proofs = await proveForReview(workspace, diff);
    const lines = await placeLines(diff, { stops: [], notes: [] }, proofs, workspace.readFile);
    const hidden = (l: LedgerLine) =>
      l.line.side === 'new' &&
      manifest.mustNotSkip.some(
        (m) => m.file === l.line.path && l.line.line >= m.lines.start && l.line.line <= m.lines.end,
      );
    return { diff, lines, hidden: lines.filter(hidden) };
  } finally {
    await cleanup();
  }
}

describe('adversarial fixtures', () => {
  test('there are at least two, each hiding changed lines', async () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(2);
    for (const fixture of fixtures) {
      const { diff, hidden } = await uncited(fixture.id);
      const ranges = fixture.hidden.reduce((n, h) => n + h.lines.end - h.lines.start + 1, 0);
      expect(hidden).toHaveLength(ranges);
      expect(changedLines(diff).length).toBeGreaterThan(ranges);
    }
  });

  test('a rename that also changes logic: the clean hunks are proven, the hidden one is not', async () => {
    const { lines, hidden } = await uncited('adversarial-rename-hides-logic');
    expect(hidden.map((l) => l.place.kind)).toEqual(['not_on_route']);
    const proven = new Set(
      lines.filter((l) => l.place.kind === 'proven_skip').map((l) => l.line.file),
    );
    expect([...proven].sort()).toEqual(['src/limits.ts', 'src/reset.ts', 'test/limits.test.ts']);
  });

  test('a "pure move" with an edit inside: core proves no moves, so the whole moved block is off the route', async () => {
    const { lines, hidden } = await uncited('adversarial-move-hides-edit');
    expect(hidden.map((l) => l.place.kind)).toEqual(['not_on_route']);
    const moved = lines.filter((l) => l.line.file === 'src/redirect.ts');
    expect(moved.length).toBeGreaterThan(1);
    expect(new Set(moved.map((l) => l.place.kind))).toEqual(new Set(['not_on_route']));
  });

  test('a malicious second push: an update of the first tour is pointed at the hidden lines, and the stop they broke is rewritten', async () => {
    const fixture = fixtures.find((f) => f.id === 'adversarial-second-push');
    if (!fixture) throw new Error('No second-push fixture');
    const { workspace, first, cleanup } = await openAdversarial(fixture);
    try {
      if (!first) throw new Error('The fixture has no first push');
      const parse = (w: typeof workspace) => parseUnifiedDiff(w.diffText, w.pr.base, w.pr.head);
      const stop = (kind: StopView['kind'], title: string, anchors: StopView['anchors']) => ({
        id: title,
        kind,
        title,
        body: title,
        flags: [],
        flagNotes: [],
        anchors,
        refs: [],
        updated: false,
      });
      // The first push's tour: a line the second push leaves alone, and the retry loop, all of it.
      const tour: TourView = {
        stops: [
          stop('core_change', 'The request type', [
            { path: 'src/http.ts', side: 'new', startLine: 1, endLine: 1 },
          ]),
          stop('core_change', 'Requests retry with backoff', [
            { path: 'src/http.ts', side: 'new', startLine: 3, endLine: 13 },
          ]),
          stop('verdict_prompt', 'Your call', []),
        ],
        notes: [],
      };
      const basis = await basisFor(tour, parse(first), first.pr, first.readFile);
      const plan = await planUpdate(basis, workspace.pr, parse(workspace), workspace.readFile);
      if (!plan) throw new Error('No update planned');

      expect(plan.stops.map((s) => s.state)).toEqual(['kept', 'stale', 'kept']);
      const moved = plan.moved.filter((l) => l.side === 'new').map((l) => l.line);
      for (const { lines } of fixture.hidden) expect(moved).toContain(lines.start);
    } finally {
      await cleanup();
    }
  });

  test("a file under __generated__ is proven by where it lives, so only a stop's citation puts the hidden lines on the route", async () => {
    const { hidden } = await uncited('adversarial-generated-comment');
    for (const line of hidden) {
      expect(line.place.kind).toBe('proven_skip');
      if (line.place.kind === 'proven_skip') {
        expect(line.place.proofs.map((p) => p.evidence.label)).toContain('generated');
      }
    }
  });
});
