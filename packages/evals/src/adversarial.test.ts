// The adversarial fixtures must be real attacks on the skip ledger: the hidden lines are changed
// lines, and with no stop citing them, the ledger keeps them off the route. Only the tour can put
// them on it, which is what `pnpm eval:tours` scores. These checks make no model calls.
import { changedLines, type LedgerLine, parseUnifiedDiff } from '@docent/core';
import { placeLines, proveForReview } from '@docent/server/evals';
import { describe, expect, test } from 'vitest';
import { loadAdversarial, openAdversarial } from './adversarial.ts';

const fixtures = await loadAdversarial();

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
