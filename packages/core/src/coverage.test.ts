import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { Anchor } from './anchor.ts';
import { base, diffs, elsewhere, head } from './arbitraries.ts';
import { type NonEmpty, type OneLine, oneLine } from './basics.ts';
import { checkCoverage } from './coverage.ts';
import {
  type ChangedLine,
  changedLines,
  type Diff,
  type HunkId,
  type LineRef,
  makeDiff,
} from './diff.ts';
import { reviewId } from './review.ts';
import { type Skip, type Stop, stopId, type Tour } from './tour.ts';

const reason = oneLine('generated') as OneLine;

/** A one-line anchor at a changed line, at the commit for its side. */
const anchorOn = (line: ChangedLine): Anchor => ({
  state: 'current',
  lines: ['text'],
  at: { commit: line.side === 'new' ? head : base, path: line.path, startLine: line.line },
});

/** One home in a hand-built tour, and the changed lines it should cover. */
type Part = { home: { skip: Skip } | { stop: Stop }; lines: LineRef[] };

const ref = ({ path, side, line }: LineRef): LineRef => ({ path, side, line });
const sorted = (lines: readonly LineRef[]) => lines.map((l) => JSON.stringify(ref(l))).sort();

/**
 * A diff, and a tour that gives every changed line exactly one home: whole files skipped,
 * hunks skipped, and the rest spread over core-change and edge stops as one-line anchors.
 */
const exactTours = diffs.chain((diff) => {
  const lines = changedLines(diff);
  const hunks = diff.files.flatMap((f) => f.hunks);
  return fc
    .record({
      fileSkips: fc.array(fc.boolean(), {
        minLength: diff.files.length,
        maxLength: diff.files.length,
      }),
      hunkSkips: fc.array(fc.boolean(), { minLength: hunks.length, maxLength: hunks.length }),
      stopOf: fc.array(fc.nat({ max: 2 }), { minLength: lines.length, maxLength: lines.length }),
    })
    .map(({ fileSkips, hunkSkips, stopOf }) => {
      const parts: Part[] = [];
      const skippedFiles = new Set(diff.files.filter((_, i) => fileSkips[i]).map((f) => f.path));
      const skippedHunks = new Set<HunkId>();
      for (const path of skippedFiles) {
        parts.push({
          home: { skip: { target: { kind: 'file', path }, reason } },
          lines: lines.filter((l) => l.file === path),
        });
      }
      hunks.forEach((hunk, i) => {
        const inSkippedFile = lines.some((l) => l.hunk === hunk.id && skippedFiles.has(l.file));
        if (!hunkSkips[i] || inSkippedFile || !lines.some((l) => l.hunk === hunk.id)) return;
        skippedHunks.add(hunk.id);
        parts.push({
          home: { skip: { target: { kind: 'hunk', hunk: hunk.id }, reason } },
          lines: lines.filter((l) => l.hunk === hunk.id),
        });
      });
      const rest = lines.filter((l) => !skippedFiles.has(l.file) && !skippedHunks.has(l.hunk));
      for (const n of [0, 1, 2]) {
        const mine = rest.filter((l) => stopOf[lines.indexOf(l)] === n);
        const [first, ...others] = mine.map(anchorOn);
        if (first === undefined) continue;
        const stop: Stop = {
          id: stopId(`stop-${n}`),
          kind: n === 2 ? 'edge' : 'core_change',
          title: '',
          body: '',
          anchors: [first, ...others],
        };
        parts.push({ home: { stop }, lines: mine });
      }
      return { diff, parts };
    });
});

const tourOf = (parts: readonly Part[], extraStops: readonly Stop[] = []): Tour => ({
  review: reviewId('r'),
  head,
  stops: [...parts.flatMap((p) => ('stop' in p.home ? [p.home.stop] : [])), ...extraStops],
  skips: parts.flatMap((p) => ('skip' in p.home ? [p.home.skip] : [])),
});

const pickPart = exactTours
  .chain(({ diff, parts }) =>
    parts.length === 0
      ? fc.constant(null)
      : fc.nat({ max: parts.length - 1 }).map((i) => ({ diff, parts, i })),
  )
  .filter((x) => x !== null);

/** Rewrites the anchors of every stop in a hand-built tour. */
const withAnchors = (
  parts: readonly Part[],
  rewrite: (stop: Stop, anchors: NonEmpty<Anchor>) => NonEmpty<Anchor>,
): Part[] =>
  parts.map((p) => {
    if (!('stop' in p.home)) return p;
    const stop = p.home.stop;
    if (stop.kind !== 'core_change' && stop.kind !== 'edge') return p;
    return { ...p, home: { stop: { ...stop, anchors: rewrite(stop, stop.anchors) } } };
  });

describe('checkCoverage', () => {
  test('C5: a tour that gives every changed line one home is complete', () => {
    fc.assert(
      fc.property(exactTours, ({ diff, parts }) => {
        expect(checkCoverage(diff, tourOf(parts))).toEqual({
          unexplained: [],
          doubled: [],
          unknownSkips: [],
        });
      }),
    );
  });

  test('C5: removing any one home reports exactly its lines as unexplained', () => {
    fc.assert(
      fc.property(pickPart, ({ diff, parts, i }) => {
        const report = checkCoverage(diff, tourOf(parts.filter((_, j) => j !== i)));
        expect(sorted(report.unexplained)).toEqual(sorted(parts[i]?.lines ?? []));
        expect(report.doubled).toEqual([]);
      }),
    );
  });

  test('C5: giving lines a second home reports exactly those lines as doubled', () => {
    fc.assert(
      fc.property(pickPart, ({ diff, parts, i }) => {
        const part = parts[i] as Part;
        const copy: Part =
          'stop' in part.home
            ? { ...part, home: { stop: { ...part.home.stop, id: stopId('copy') } } }
            : part;
        const report = checkCoverage(diff, tourOf([...parts, copy]));
        expect(report.unexplained).toEqual([]);
        expect(sorted(report.doubled.map((d) => d.line))).toEqual(sorted(part.lines));
        for (const { homes } of report.doubled) expect(homes).toHaveLength(2);
      }),
    );
  });

  test('C2: intent, map and verdict stops never change coverage, whatever they cite', () => {
    fc.assert(
      fc.property(
        exactTours,
        fc.constantFrom('intent', 'map', 'verdict_prompt'),
        ({ diff, parts }, kind) => {
          const citesEverything: Stop = {
            id: stopId('overview'),
            kind,
            title: '',
            body: '',
            anchors: changedLines(diff).map(anchorOn),
          };
          expect(checkCoverage(diff, tourOf(parts, [citesEverything]))).toEqual(
            checkCoverage(diff, tourOf(parts)),
          );
        },
      ),
    );
  });

  test('C3: out-of-date anchors, and anchors at other commits, give no home', () => {
    fc.assert(
      fc.property(exactTours, fc.boolean(), ({ diff, parts }, outOfDate) => {
        const stale = (anchor: Anchor): Anchor =>
          anchor.state !== 'current'
            ? anchor
            : outOfDate
              ? { state: 'out_of_date', lines: anchor.lines, lastSeen: anchor.at }
              : { ...anchor, at: { ...anchor.at, commit: elsewhere } };
        // Only the core-change stops go stale; edge stops and skips keep their lines.
        const staleParts = withAnchors(parts, (stop, [first, ...rest]) =>
          stop.kind === 'core_change' ? [stale(first), ...rest.map(stale)] : [first, ...rest],
        );
        const lost = parts.flatMap((p) =>
          'stop' in p.home && p.home.stop.kind === 'core_change' ? p.lines : [],
        );
        expect(sorted(checkCoverage(diff, tourOf(staleParts)).unexplained)).toEqual(sorted(lost));
      }),
    );
  });

  test('C4: a stop that cites a line twice is still one home', () => {
    fc.assert(
      fc.property(exactTours, ({ diff, parts }) => {
        const twice = withAnchors(parts, (_, anchors) => [...anchors, ...anchors]);
        expect(checkCoverage(diff, tourOf(twice)).doubled).toEqual([]);
      }),
    );
  });
});

describe('checkCoverage, by example', () => {
  const diff: Diff = makeDiff(base, head, [
    {
      path: 'b.ts',
      oldPath: 'a.ts',
      hunks: [
        {
          oldStart: 10,
          newStart: 10,
          lines: [
            { kind: 'removed', text: 'old();' },
            { kind: 'added', text: 'next();' },
            { kind: 'added', text: 'more();' },
          ],
        },
      ],
    },
    { path: 'moved-only.ts', oldPath: 'was.ts', hunks: [] },
  ]);
  const core = (anchors: NonEmpty<Anchor>): Stop => ({
    id: stopId('core'),
    kind: 'core_change',
    title: '',
    body: '',
    anchors,
  });
  const tour = (stops: Stop[], skips: Skip[] = []): Tour => ({
    review: reviewId('r'),
    head,
    stops,
    skips,
  });

  test('C1: a multi-line anchor at head covers added lines; one at base covers removed lines', () => {
    const report = checkCoverage(
      diff,
      tour([
        core([
          {
            state: 'current',
            lines: ['next();', 'more();'],
            at: { commit: head, path: 'b.ts', startLine: 10 },
          },
          {
            state: 'current',
            lines: ['old();'],
            at: { commit: base, path: 'a.ts', startLine: 10 },
          },
        ]),
      ]),
    );
    expect(report).toEqual({ unexplained: [], doubled: [], unknownSkips: [] });
  });

  test('C1: removed lines of a renamed file are found under the old path, not the new one', () => {
    const report = checkCoverage(
      diff,
      tour([
        core([
          {
            state: 'current',
            lines: ['next();', 'more();'],
            at: { commit: head, path: 'b.ts', startLine: 10 },
          },
          {
            state: 'current',
            lines: ['old();'],
            at: { commit: base, path: 'b.ts', startLine: 10 },
          },
        ]),
      ]),
    );
    expect(report.unexplained).toEqual([{ path: 'a.ts', side: 'old', line: 10 }]);
  });

  test('C6: skips of things not in the diff are reported; a file with no hunks can be skipped', () => {
    const skip = (target: Skip['target']): Skip => ({ target, reason });
    const report = checkCoverage(
      diff,
      tour(
        [],
        [
          skip({ kind: 'file', path: 'b.ts' }),
          skip({ kind: 'file', path: 'moved-only.ts' }),
          skip({ kind: 'file', path: 'nope.ts' }),
          skip({ kind: 'hunk', hunk: 'b.ts#00000000' as HunkId }),
        ],
      ),
    );
    expect(report.unexplained).toEqual([]);
    expect(report.unknownSkips.map((s) => s.target)).toEqual([
      { kind: 'file', path: 'nope.ts' },
      { kind: 'hunk', hunk: 'b.ts#00000000' },
    ]);
  });
});
