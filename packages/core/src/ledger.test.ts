import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { Anchor } from './anchor.ts';
import { base, elsewhere, head, rawFiles } from './arbitraries.testing.ts';
import type { CommitSha } from './basics.ts';
import { changes } from './changes.testing.ts';
import { lineKey } from './coverage.ts';
import { proveBlankLines, proveGenerated, proveLockfiles, proveWhitespace } from './detect.ts';
import { type ChangedLine, changedLines, type Diff, makeDiff } from './diff.ts';
import { computeLedger, type Ledger } from './ledger.ts';
import type { FileTexts, Proof } from './proof.ts';
import { reviewId } from './review.ts';
import { type Stop, stopId, type Tour } from './tour.ts';

const lines = (...text: string[]) => `${text.join('\n')}\n`;

/** One single-line anchor per line, at the commit for its side (or `commit`, to make it stale). */
function citing(id: string, cited: readonly ChangedLine[], commit?: CommitSha): Stop | null {
  const anchors = cited.map(
    (line): Anchor => ({
      state: 'current',
      lines: ['x'],
      context: { before: [], after: [] },
      at: {
        commit: commit ?? (line.side === 'new' ? head : base),
        path: line.path,
        startLine: line.line,
      },
    }),
  );
  const [first, ...rest] = anchors;
  if (first === undefined) return null;
  return {
    id: stopId(id),
    kind: 'edge',
    title: '',
    body: '',
    flags: [],
    anchors: [first, ...rest],
  };
}

const tourOf = (stops: readonly (Stop | null)[], tourHead: CommitSha = head): Tour => ({
  review: reviewId('r'),
  head: tourHead,
  stops: stops.filter((s) => s !== null),
});

const computed = (ledger: Ledger) => {
  if (ledger.state !== 'computed') throw new Error('expected a computed ledger');
  return ledger.lines;
};

/** File text at both sides that agrees with the diff: hunk lines in place, filler between. */
function textsFor(diff: Diff): FileTexts {
  const side = (pick: 'old' | 'new') =>
    new Map(
      diff.files.map((file) => {
        const text: string[] = [];
        for (const line of file.hunks.flatMap((h) => h.lines)) {
          const at =
            pick === 'old'
              ? line.kind === 'added'
                ? null
                : line.oldLine
              : line.kind === 'removed'
                ? null
                : line.newLine;
          if (at === null) continue;
          while (text.length < at - 1) text.push('filler();');
          text[at - 1] = line.text;
        }
        return [pick === 'old' ? file.oldPath : file.path, lines(...text)] as const;
      }),
    );
  return { base: side('old'), head: side('new') };
}

const PATHS = ['a.ts', 'src/b.ts', 'dist/c.js', 'pnpm-lock.yaml', 'package.json', 'vendor/d.go'];

/** Generated diffs over paths that some detectors will prove, with proofs from real detectors. */
const scenarios = rawFiles.chain((files) =>
  fc
    .record({
      paths: fc.shuffledSubarray(PATHS, { minLength: files.length, maxLength: files.length }),
      cite: fc.array(fc.boolean(), { minLength: 200, maxLength: 200 }),
      staleCite: fc.array(fc.boolean(), { minLength: 200, maxLength: 200 }),
    })
    .map(({ paths, cite, staleCite }) => {
      const renamedFiles = files.map((file, i) => {
        const path = paths[i] ?? file.path;
        return { ...file, path, oldPath: file.oldPath === file.path ? path : `old/${path}` };
      });
      const diff = makeDiff(base, head, renamedFiles);
      const texts = textsFor(diff);
      const prove = (d: Diff): Proof[] => [
        ...proveWhitespace(d, texts),
        ...proveBlankLines(d, texts),
        ...proveGenerated(d, new Map()),
        ...proveLockfiles(d),
      ];
      // Proofs judged at another head must count for nothing.
      const stale = prove(makeDiff(base, elsewhere, renamedFiles));
      const all = changedLines(diff);
      const cited = all.filter((_, i) => cite[i % cite.length]);
      const citedElsewhere = all.filter((_, i) => staleCite[i % staleCite.length]);
      const tour = tourOf([citing('s1', cited), citing('s2', citedElsewhere, elsewhere)]);
      return { diff, proofs: [...prove(diff), ...stale], cited, tour };
    }),
);

describe('the skip ledger', () => {
  test('L1: every changed line has exactly one place, in diff order', () => {
    fc.assert(
      fc.property(scenarios, ({ diff, proofs, cited, tour }) => {
        const ledger = computed(computeLedger(diff, tour, proofs));
        const all = changedLines(diff);
        // Total and disjoint: the ledger is the changed lines, once each, nothing added.
        expect(ledger.map((l) => l.line)).toEqual(all);
        const route = new Set(cited.map(lineKey));
        for (const { line, place } of ledger) {
          const key = lineKey(line);
          if (route.has(key)) {
            expect(place.kind).toBe('on_route');
            continue;
          }
          const covering = proofs.filter(
            (p) =>
              p.judgedAt === head &&
              (p.target.kind === 'file'
                ? p.target.path === line.file
                : p.target.kind === 'hunk'
                  ? p.target.hunk === line.hunk
                  : lineKey(p.target.line) === key) &&
              (p.evidence.label !== 'lockfile' ||
                p.evidence.manifests.some((m) => cited.some((c) => c.file === m))),
          );
          if (covering.length > 0) {
            expect(place).toEqual({ kind: 'proven_skip', proofs: covering });
          } else {
            expect(place).toEqual({ kind: 'not_on_route' });
          }
        }
      }),
      { seed: 9, numRuns: 300 },
    );
  });

  test('L1: generated scenarios do exercise every kind of place', () => {
    const kinds = new Set<string>();
    fc.assert(
      fc.property(scenarios, ({ diff, proofs, tour }) => {
        for (const { place } of computed(computeLedger(diff, tour, proofs))) kinds.add(place.kind);
      }),
      { seed: 9, numRuns: 300 },
    );
    expect([...kinds].sort()).toEqual(['not_on_route', 'on_route', 'proven_skip']);
  });

  test('L2: a cited line is on the route even when a proof covers it', () => {
    const { diff, texts } = changes([
      {
        path: 'a.ts',
        before: lines('if (a) {', 'go();', '}'),
        after: lines('if (a) {', '  go();', '}'),
      },
    ]);
    const proofs = proveWhitespace(diff, texts);
    expect(proofs).toHaveLength(1);
    const [added] = changedLines(diff).filter((l) => l.side === 'new');
    const ledger = computed(
      computeLedger(diff, tourOf([citing('s', added ? [added] : [])]), proofs),
    );
    expect(ledger.map((l) => l.place.kind)).toEqual(['proven_skip', 'on_route']);
  });

  test('L2: map and intent stops put nothing on the route', () => {
    const { diff } = changes([{ path: 'a.ts', before: lines('a();'), after: lines('b();') }]);
    const stop = citing('s', changedLines(diff));
    const map: Stop | null = stop && { ...stop, kind: 'map' };
    const ledger = computed(computeLedger(diff, tourOf([map]), []));
    expect(ledger.map((l) => l.place.kind)).toEqual(['not_on_route', 'not_on_route']);
  });

  test('L3: a lockfile proof counts only when its manifest is on the route', () => {
    const { diff } = changes([
      {
        path: 'pnpm-lock.yaml',
        before: lines('v: 9', 'a@1:', '  x'),
        after: lines('v: 9', 'a@2:', '  x'),
      },
      {
        path: 'package.json',
        before: lines('{', '"a": "1"', '}'),
        after: lines('{', '"a": "2"', '}'),
      },
    ]);
    const proofs = proveLockfiles(diff);
    const lockLines = (tour: Tour) =>
      computed(computeLedger(diff, tour, proofs))
        .filter((l) => l.line.file === 'pnpm-lock.yaml')
        .map((l) => l.place.kind);
    expect(lockLines(tourOf([]))).toEqual(['not_on_route', 'not_on_route']);
    const manifest = changedLines(diff).filter((l) => l.file === 'package.json');
    expect(lockLines(tourOf([citing('s', manifest)]))).toEqual(['proven_skip', 'proven_skip']);
  });

  test('L3: a proof judged at another head counts for nothing', () => {
    const files = [
      {
        path: 'dist/a.js',
        oldPath: 'dist/a.js',
        hunks: [{ oldStart: 1, newStart: 1, lines: [{ kind: 'added' as const, text: 'x' }] }],
      },
    ];
    const old = proveGenerated(makeDiff(base, elsewhere, files), new Map());
    const diff = makeDiff(base, head, files);
    expect(computed(computeLedger(diff, tourOf([]), old)).map((l) => l.place.kind)).toEqual([
      'not_on_route',
    ]);
  });

  test('L4: a changed line no stop explains and no proof covers is not on the route', () => {
    const { diff } = changes([{ path: 'a.ts', before: lines('a();'), after: lines('b();') }]);
    expect(computed(computeLedger(diff, tourOf([]), [])).map((l) => l.place.kind)).toEqual([
      'not_on_route',
      'not_on_route',
    ]);
  });

  test('L5: a tour for another head is stale', () => {
    const { diff } = changes([{ path: 'a.ts', before: lines('a();'), after: lines('b();') }]);
    expect(computeLedger(diff, tourOf([], elsewhere), [])).toEqual({
      state: 'stale',
      tourHead: elsewhere,
      diffHead: head,
    });
  });
});
