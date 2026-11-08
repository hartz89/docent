import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { Anchor } from './anchor.ts';
import { base, diffs, elsewhere, head } from './arbitraries.testing.ts';
import { type NonEmpty, type OneLine, oneLine } from './basics.ts';
import { type CoverageReport, checkCoverage } from './coverage.ts';
import {
  type ChangedLine,
  changedLines,
  type Diff,
  type HunkId,
  type LineRef,
  makeDiff,
} from './diff.ts';
import { reviewId } from './review.ts';
import { type Skip, type Stop, type StopFlag, stopId, type Tour } from './tour.ts';

const reason = oneLine('generated') as OneLine;
const noContext = { before: [], after: [] };
const complete: CoverageReport = {
  state: 'checked',
  unexplained: [],
  conflicts: [],
  unknownSkips: [],
};

/**
 * Anchors over the given changed lines, one per run of consecutive lines on the same side of
 * the same file. So a check that only looked at an anchor's first line would miss the rest.
 */
function anchorsOver(lines: readonly ChangedLine[]): Anchor[] {
  const anchors: Anchor[] = [];
  let run: ChangedLine[] = [];
  const flush = () => {
    const [first, ...rest] = run;
    if (first === undefined) return;
    anchors.push({
      state: 'current',
      lines: [`line ${first.line}`, ...rest.map((l) => `line ${l.line}`)],
      context: noContext,
      at: { commit: first.side === 'new' ? head : base, path: first.path, startLine: first.line },
    });
    run = [];
  };
  for (const line of lines) {
    const last = run.at(-1);
    const continues =
      last !== undefined &&
      last.path === line.path &&
      last.side === line.side &&
      last.line + 1 === line.line;
    if (!continues) flush();
    run.push(line);
  }
  flush();
  return anchors;
}

const explaining = (id: string, lines: readonly ChangedLine[], flags: StopFlag[] = []) => {
  const [first, ...rest] = anchorsOver(lines);
  if (first === undefined) return null;
  const stop: Stop = {
    id: stopId(id),
    kind: 'core_change',
    title: '',
    body: '',
    flags,
    anchors: [first, ...rest],
  };
  return stop;
};

/** One home in a hand-built tour, and the changed lines it should cover. */
type Part = { home: { skip: Skip } | { stop: Stop }; lines: ChangedLine[] };

const sorted = (lines: readonly LineRef[]) =>
  lines.map(({ path, side, line }) => JSON.stringify([path, side, line])).sort();

const checked = (report: CoverageReport) => {
  if (report.state !== 'checked') throw new Error('expected a checked report');
  return report;
};

const flagSets = fc.subarray<StopFlag>(['mismatch', 'danger']);

/**
 * A diff, and a tour that gives every changed line exactly one home: whole files skipped,
 * hunks skipped, and the rest spread over two stops, as runs of multi-line anchors.
 */
const exactTours = diffs.chain((diff) => {
  const lines = changedLines(diff);
  const hunks = diff.files.flatMap((f) => f.hunks);
  const n = (length: number) => ({ minLength: length, maxLength: length });
  return fc
    .record({
      fileSkips: fc.array(fc.boolean(), n(diff.files.length)),
      hunkSkips: fc.array(fc.boolean(), n(hunks.length)),
      stopOf: fc.array(fc.nat({ max: 1 }), n(lines.length)),
      flags: fc.tuple(flagSets, flagSets),
    })
    .map(({ fileSkips, hunkSkips, stopOf, flags }) => {
      const parts: Part[] = [];
      const skippedFiles = new Set(diff.files.filter((_, i) => fileSkips[i]).map((f) => f.path));
      const skippedHunks = new Set<HunkId>();
      for (const path of skippedFiles) {
        parts.push({
          home: { skip: { target: { kind: 'file', path }, reason, judgedAt: head } },
          lines: lines.filter((l) => l.file === path),
        });
      }
      hunks.forEach((hunk, i) => {
        const mine = lines.filter((l) => l.hunk === hunk.id);
        if (!hunkSkips[i] || mine.length === 0 || mine.some((l) => skippedFiles.has(l.file)))
          return;
        skippedHunks.add(hunk.id);
        parts.push({
          home: { skip: { target: { kind: 'hunk', hunk: hunk.id }, reason, judgedAt: head } },
          lines: mine,
        });
      });
      const rest = lines.filter((l) => !skippedFiles.has(l.file) && !skippedHunks.has(l.hunk));
      for (const k of [0, 1] as const) {
        const mine = rest.filter((l) => stopOf[lines.indexOf(l)] === k);
        const stop = explaining(`stop-${k}`, mine, flags[k]);
        if (stop)
          parts.push({ home: { stop: k === 1 ? { ...stop, kind: 'edge' } : stop }, lines: mine });
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
  .filter(({ parts }) => parts.length > 0)
  .chain(({ diff, parts }) =>
    fc.nat({ max: parts.length - 1 }).map((i) => ({ diff, parts, part: parts[i] as Part })),
  );

describe('checkCoverage', () => {
  test('C5, T5: a tour that gives every changed line one home is complete, whatever its flags', () => {
    fc.assert(
      fc.property(exactTours, ({ diff, parts }) => {
        expect(checkCoverage(diff, tourOf(parts))).toEqual(complete);
      }),
    );
  });

  test('C5: removing any one home reports exactly its lines as unexplained', () => {
    fc.assert(
      fc.property(pickPart, ({ diff, parts, part }) => {
        const report = checked(checkCoverage(diff, tourOf(parts.filter((p) => p !== part))));
        expect(sorted(report.unexplained)).toEqual(sorted(part.lines));
        expect(report.conflicts).toEqual([]);
      }),
    );
  });

  test('C4: a second stop or a second skip on the same lines is not a problem', () => {
    fc.assert(
      fc.property(pickPart, ({ diff, parts, part }) => {
        const copy: Part =
          'stop' in part.home
            ? { ...part, home: { stop: { ...part.home.stop, id: stopId('copy') } } }
            : part;
        expect(checkCoverage(diff, tourOf([...parts, copy]))).toEqual(complete);
      }),
    );
  });

  test('C5: explaining skipped lines reports exactly those lines as conflicts', () => {
    fc.assert(
      fc.property(pickPart, ({ diff, parts, part }) => {
        fc.pre('skip' in part.home);
        const stop = explaining('second-opinion', part.lines);
        if (!stop) return;
        const report = checked(checkCoverage(diff, tourOf(parts, [stop])));
        expect(report.unexplained).toEqual([]);
        expect(sorted(report.conflicts.map((c) => c.line))).toEqual(sorted(part.lines));
        for (const conflict of report.conflicts) expect(conflict.stops).toEqual([stop.id]);
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
            flags: [],
            anchors: anchorsOver(changedLines(diff)),
          };
          const withoutSome = parts.slice(1);
          expect(checkCoverage(diff, tourOf(withoutSome, [citesEverything]))).toEqual(
            checkCoverage(diff, tourOf(withoutSome)),
          );
        },
      ),
    );
  });

  test('C3: out-of-date anchors, anchors at other commits, and skips judged at another head count for nothing', () => {
    fc.assert(
      fc.property(exactTours, fc.boolean(), ({ diff, parts }, outOfDate) => {
        const stale = (anchor: Anchor): Anchor =>
          anchor.state !== 'current'
            ? anchor
            : outOfDate
              ? { ...anchor, state: 'out_of_date', lastSeen: anchor.at }
              : { ...anchor, at: { ...anchor.at, commit: elsewhere } };
        // Core-change stops and hunk skips go stale; edge stops and file skips stay current.
        const goesStale = (p: Part) =>
          'stop' in p.home
            ? p.home.stop.kind === 'core_change'
            : p.home.skip.target.kind === 'hunk';
        const staleParts = parts.map((p): Part => {
          if (!goesStale(p)) return p;
          if ('skip' in p.home)
            return { ...p, home: { skip: { ...p.home.skip, judgedAt: elsewhere } } };
          const stop = p.home.stop;
          if (stop.kind !== 'core_change') return p;
          const [first, ...rest] = stop.anchors;
          return { ...p, home: { stop: { ...stop, anchors: [stale(first), ...rest.map(stale)] } } };
        });
        const lost = parts.filter(goesStale).flatMap((p) => p.lines);
        const report = checked(checkCoverage(diff, tourOf(staleParts)));
        expect(sorted(report.unexplained)).toEqual(sorted(lost));
      }),
    );
  });

  test('C7: a tour written for another head is reported stale, not checked', () => {
    fc.assert(
      fc.property(exactTours, ({ diff, parts }) => {
        const tour = { ...tourOf(parts), head: elsewhere };
        expect(checkCoverage(diff, tour)).toEqual({
          state: 'stale',
          tourHead: elsewhere,
          diffHead: head,
        });
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
    flags: [],
    anchors,
  });
  const tour = (stops: Stop[], skips: Skip[] = []): Tour => ({
    review: reviewId('r'),
    head,
    stops,
    skips,
  });
  const next: Anchor = {
    state: 'current',
    lines: ['next();', 'more();'],
    context: noContext,
    at: { commit: head, path: 'b.ts', startLine: 10 },
  };

  test('C1: a multi-line anchor at head covers added lines; one at base covers removed lines', () => {
    const old: Anchor = {
      ...next,
      lines: ['old();'],
      at: { commit: base, path: 'a.ts', startLine: 10 },
    };
    expect(checkCoverage(diff, tour([core([next, old])]))).toEqual(complete);
  });

  test('C1, D1: removed lines of a renamed file are found under the old path, not the new one', () => {
    const old: Anchor = {
      ...next,
      lines: ['old();'],
      at: { commit: base, path: 'b.ts', startLine: 10 },
    };
    const report = checked(checkCoverage(diff, tour([core([next, old])])));
    expect(report.unexplained).toEqual([{ path: 'a.ts', side: 'old', line: 10 }]);
  });

  test('C6: skips of things not in the diff are reported; a file with no hunks can be skipped', () => {
    const skip = (target: Skip['target']): Skip => ({ target, reason, judgedAt: head });
    const report = checked(
      checkCoverage(
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
      ),
    );
    expect(report.unexplained).toEqual([]);
    expect(report.unknownSkips.map((s) => s.target)).toEqual([
      { kind: 'file', path: 'nope.ts' },
      { kind: 'hunk', hunk: 'b.ts#00000000' },
    ]);
  });
});
