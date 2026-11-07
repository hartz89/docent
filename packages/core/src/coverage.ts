import { endLine } from './anchor.ts';
import { type ChangedLine, changedLines, type Diff, type LineRef, type Side } from './diff.ts';
import type { Skip, StopId, Tour } from './tour.ts';

/** Where a changed line is explained or skipped (C1). */
export type Home =
  | { readonly kind: 'stop'; readonly stop: StopId }
  | { readonly kind: 'skip'; readonly skip: Skip };

export type CoverageReport = {
  /** Changed lines with no home (C5). */
  readonly unexplained: readonly LineRef[];
  /** Changed lines with two or more homes (C5). */
  readonly doubled: readonly { readonly line: LineRef; readonly homes: readonly Home[] }[];
  /** Skips whose target isn't in the diff (C6). */
  readonly unknownSkips: readonly Skip[];
};

/** Checks that every changed line in the diff has exactly one home in the tour (C1–C6). */
export function checkCoverage(diff: Diff, tour: Tour): CoverageReport {
  const lines = changedLines(diff);
  const homes = new Map<string, Home[]>(lines.map((line) => [keyOf(line), []]));
  const addHome = (line: LineRef, home: Home) => homes.get(keyOf(line))?.push(home);

  const unknownSkips: Skip[] = [];
  for (const skip of tour.skips) {
    const target = skip.target;
    const skipped = lines.filter((line) =>
      target.kind === 'file' ? line.file === target.path : line.hunk === target.hunk,
    );
    if (!targetExists(diff, skip)) unknownSkips.push(skip);
    for (const line of skipped) addHome(line, { kind: 'skip', skip });
  }

  for (const stop of tour.stops) {
    if (stop.kind !== 'core_change' && stop.kind !== 'edge') continue; // C2
    const covered = new Set<string>(); // C4: one home per stop, however many anchors overlap
    for (const anchor of stop.anchors) {
      if (anchor.state !== 'current') continue; // C3
      const side = sideAt(diff, anchor.at.commit);
      if (side === null) continue; // C3
      const last = endLine(anchor.at, anchor.lines);
      for (let line = anchor.at.startLine; line <= last; line++) {
        covered.add(keyOf({ path: anchor.at.path, side, line }));
      }
    }
    for (const key of covered) homes.get(key)?.push({ kind: 'stop', stop: stop.id });
  }

  const unexplained: LineRef[] = [];
  const doubled: { line: LineRef; homes: Home[] }[] = [];
  for (const line of lines) {
    const lineHomes = homes.get(keyOf(line)) ?? [];
    if (lineHomes.length === 0) unexplained.push(refOf(line));
    else if (lineHomes.length > 1) doubled.push({ line: refOf(line), homes: lineHomes });
  }
  return { unexplained, doubled, unknownSkips };
}

/** A hunk or file can exist with no changed lines (a pure rename, say); skipping it is fine. */
function targetExists(diff: Diff, { target }: Skip): boolean {
  return diff.files.some((file) =>
    target.kind === 'file'
      ? file.path === target.path
      : file.hunks.some((hunk) => hunk.id === target.hunk),
  );
}

function sideAt(diff: Diff, commit: string): Side | null {
  if (commit === diff.head) return 'new';
  if (commit === diff.base) return 'old';
  return null;
}

const keyOf = ({ path, side, line }: LineRef): string => JSON.stringify([path, side, line]);
const refOf = ({ path, side, line }: ChangedLine): LineRef => ({ path, side, line });
