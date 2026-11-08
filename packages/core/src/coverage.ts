import { endLine } from './anchor.ts';
import type { CommitSha } from './basics.ts';
import { type ChangedLine, changedLines, type Diff, type LineRef, type Side } from './diff.ts';
import type { Skip, StopId, Tour } from './tour.ts';

/** A changed line that is both skipped and explained (C5). */
export type Conflict = {
  readonly line: LineRef;
  readonly skips: readonly Skip[];
  readonly stops: readonly StopId[];
};

export type CoverageReport =
  /** C7: the tour was written for another head, so its lines weren't checked. */
  | { readonly state: 'stale'; readonly tourHead: CommitSha; readonly diffHead: CommitSha }
  | {
      readonly state: 'checked';
      /** Changed lines neither skipped nor explained (C5). */
      readonly unexplained: readonly LineRef[];
      /** Changed lines both skipped and explained (C5). */
      readonly conflicts: readonly Conflict[];
      /** Skips whose target isn't in the diff (C6). */
      readonly unknownSkips: readonly Skip[];
    };

/** Checks that every changed line is skipped or explained, and not both (C1–C7). */
export function checkCoverage(diff: Diff, tour: Tour): CoverageReport {
  if (tour.head !== diff.head) {
    return { state: 'stale', tourHead: tour.head, diffHead: diff.head };
  }
  const lines = changedLines(diff);
  const homes = new Map(
    lines.map((line) => [keyOf(line), { skips: [] as Skip[], stops: [] as StopId[] }]),
  );

  const unknownSkips: Skip[] = [];
  for (const skip of tour.skips) {
    if (!targetExists(diff, skip)) {
      unknownSkips.push(skip); // C6
      continue;
    }
    if (skip.judgedAt !== diff.head) continue; // C3
    const target = skip.target;
    for (const line of lines) {
      const hit = target.kind === 'file' ? line.file === target.path : line.hunk === target.hunk;
      if (hit) homes.get(keyOf(line))?.skips.push(skip);
    }
  }

  for (const stop of tour.stops) {
    if (stop.kind !== 'core_change' && stop.kind !== 'edge') continue; // C2
    const covered = new Set<string>();
    for (const anchor of stop.anchors) {
      if (anchor.state !== 'current') continue; // C3
      const side = sideAt(diff, anchor.at.commit);
      if (side === null) continue; // C3
      const last = endLine(anchor.at, anchor.lines);
      for (let line = anchor.at.startLine; line <= last; line++) {
        covered.add(keyOf({ path: anchor.at.path, side, line }));
      }
    }
    for (const key of covered) homes.get(key)?.stops.push(stop.id);
  }

  const unexplained: LineRef[] = [];
  const conflicts: Conflict[] = [];
  for (const line of lines) {
    const { skips, stops } = homes.get(keyOf(line)) ?? { skips: [], stops: [] };
    if (skips.length === 0 && stops.length === 0) unexplained.push(refOf(line));
    else if (skips.length > 0 && stops.length > 0)
      conflicts.push({ line: refOf(line), skips, stops });
  }
  return { state: 'checked', unexplained, conflicts, unknownSkips };
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
