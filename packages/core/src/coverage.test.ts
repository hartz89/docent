import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { Anchor } from './anchor.ts';
import { base, diffs, elsewhere, head } from './arbitraries.testing.ts';
import type { NonEmpty } from './basics.ts';
import { explainedBy, lineKey } from './coverage.ts';
import { type ChangedLine, changedLines, type Diff, makeDiff } from './diff.ts';
import type { Stop, StopFlag } from './tour.ts';
import { stopId } from './tour.ts';

const noContext = { before: [], after: [] };

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

const explaining = (
  id: string,
  lines: readonly ChangedLine[],
  kind: 'core_change' | 'edge' = 'core_change',
  flags: StopFlag[] = [],
): Stop | null => {
  const [first, ...rest] = anchorsOver(lines);
  if (first === undefined) return null;
  return { id: stopId(id), kind, title: '', body: '', flags, anchors: [first, ...rest] };
};

const flagSets = fc.subarray<StopFlag>(['mismatch', 'danger']);

/** A diff, and two stops that each cite some of its changed lines (or none). */
const citedDiffs = diffs.chain((diff) => {
  const lines = changedLines(diff);
  return fc
    .record({
      // 0: stop 1, 1: stop 2, 2: neither.
      citedBy: fc.array(fc.nat({ max: 2 }), { minLength: lines.length, maxLength: lines.length }),
      flags: fc.tuple(flagSets, flagSets),
    })
    .map(({ citedBy, flags }) => {
      const mine = (k: number) => lines.filter((_, i) => citedBy[i] === k);
      const stops = [
        explaining('stop-1', mine(0), 'core_change', flags[0]),
        explaining('stop-2', mine(1), 'edge', flags[1]),
      ].filter((s) => s !== null);
      return { diff, stops, lines, cited: [mine(0), mine(1)] as const };
    });
});

/** The explained lines as sorted `[key, stop ids]` pairs, for comparing whole results. */
const entries = (diff: Diff, stops: readonly Stop[]) =>
  [...explainedBy(diff, stops)].sort(([a], [b]) => a.localeCompare(b));

describe('explainedBy', () => {
  test('C1, T5: a line is explained by exactly the core and edge stops that cite it, whatever their flags', () => {
    fc.assert(
      fc.property(citedDiffs, ({ diff, stops, lines, cited }) => {
        const explained = explainedBy(diff, stops);
        for (const line of lines) {
          const expected = [
            ...(cited[0].includes(line) ? ['stop-1'] : []),
            ...(cited[1].includes(line) ? ['stop-2'] : []),
          ];
          expect(explained.get(lineKey(line)) ?? []).toEqual(expected);
        }
      }),
    );
  });

  test('C4: a second stop citing the same lines is listed too', () => {
    fc.assert(
      fc.property(citedDiffs, ({ diff, stops, cited }) => {
        const copy = explaining('copy', cited[0]);
        fc.pre(copy !== null);
        const explained = explainedBy(diff, [...stops, copy as Stop]);
        for (const line of cited[0]) {
          expect(explained.get(lineKey(line))).toEqual(['stop-1', 'copy']);
        }
      }),
    );
  });

  test('C2: intent, map and verdict stops explain nothing, whatever they cite', () => {
    fc.assert(
      fc.property(
        citedDiffs,
        fc.constantFrom('intent', 'map', 'verdict_prompt'),
        ({ diff, stops }, kind) => {
          const citesEverything: Stop = {
            id: stopId('overview'),
            kind,
            title: '',
            body: '',
            flags: [],
            anchors: anchorsOver(changedLines(diff)),
          };
          expect(entries(diff, [...stops, citesEverything])).toEqual(entries(diff, stops));
        },
      ),
    );
  });

  test('C3: out-of-date anchors and anchors at other commits explain nothing', () => {
    fc.assert(
      fc.property(citedDiffs, fc.boolean(), ({ diff, stops }, outOfDate) => {
        const stale = (anchor: Anchor): Anchor =>
          anchor.state !== 'current'
            ? anchor
            : outOfDate
              ? { ...anchor, state: 'out_of_date', lastSeen: anchor.at }
              : { ...anchor, at: { ...anchor.at, commit: elsewhere } };
        const staleStops = stops.map((stop): Stop => {
          if (stop.kind !== 'core_change' && stop.kind !== 'edge') return stop;
          const [first, ...rest] = stop.anchors;
          return { ...stop, anchors: [stale(first), ...rest.map(stale)] };
        });
        expect(explainedBy(diff, staleStops).size).toBe(0);
      }),
    );
  });
});

describe('explainedBy, by example', () => {
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
  ]);
  const core = (anchors: NonEmpty<Anchor>): Stop => ({
    id: stopId('core'),
    kind: 'core_change',
    title: '',
    body: '',
    flags: [],
    anchors,
  });
  const next: Anchor = {
    state: 'current',
    lines: ['next();', 'more();'],
    context: noContext,
    at: { commit: head, path: 'b.ts', startLine: 10 },
  };
  const keys = (stops: Stop[]) => [...explainedBy(diff, stops).keys()].sort();

  test('C1: a multi-line anchor at head covers added lines; one at base covers removed lines', () => {
    const old: Anchor = {
      ...next,
      lines: ['old();'],
      at: { commit: base, path: 'a.ts', startLine: 10 },
    };
    expect(keys([core([next, old])])).toEqual(
      [
        lineKey({ path: 'a.ts', side: 'old', line: 10 }),
        lineKey({ path: 'b.ts', side: 'new', line: 10 }),
        lineKey({ path: 'b.ts', side: 'new', line: 11 }),
      ].sort(),
    );
  });

  test('C1, D1: removed lines of a renamed file are found under the old path, not the new one', () => {
    const old: Anchor = {
      ...next,
      lines: ['old();'],
      at: { commit: base, path: 'b.ts', startLine: 10 },
    };
    expect(keys([core([next, old])])).not.toContain(
      lineKey({ path: 'a.ts', side: 'old', line: 10 }),
    );
  });
});
