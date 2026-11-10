import { endLine } from './anchor.ts';
import type { CommitSha } from './basics.ts';
import { type ChangedLine, changedLines, type Diff, type LineRef, type Side } from './diff.ts';
import type { Skip, Stop, StopId, Tour } from './tour.ts';

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
    lines.map((line) => [lineKey(line), { skips: [] as Skip[], stops: [] as StopId[] }]),
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
      if (hit) homes.get(lineKey(line))?.skips.push(skip);
    }
  }

  for (const [key, stops] of explainedBy(diff, tour.stops)) homes.get(key)?.stops.push(...stops);

  const unexplained: LineRef[] = [];
  const conflicts: Conflict[] = [];
  for (const line of lines) {
    const { skips, stops } = homes.get(lineKey(line)) ?? { skips: [], stops: [] };
    if (skips.length === 0 && stops.length === 0) unexplained.push(refOf(line));
    else if (skips.length > 0 && stops.length > 0)
      conflicts.push({ line: refOf(line), skips, stops });
  }
  return { state: 'checked', unexplained, conflicts, unknownSkips };
}

/**
 * The stops that explain each line (C1–C3), keyed by `lineKey`. Only current anchors at the
 * diff's base or head count, and only on `core_change` and `edge` stops. Lines nobody explains
 * are absent. Shared by the coverage check and the ledger, so both mean the same by "explained".
 */
export function explainedBy(diff: Diff, stops: readonly Stop[]): Map<string, StopId[]> {
  const explained = new Map<string, StopId[]>();
  for (const stop of stops) {
    if (stop.kind !== 'core_change' && stop.kind !== 'edge') continue; // C2
    const covered = new Set<string>();
    for (const anchor of stop.anchors) {
      if (anchor.state !== 'current') continue; // C3
      const side = sideAt(diff, anchor.at.commit);
      if (side === null) continue; // C3
      const last = endLine(anchor.at, anchor.lines);
      for (let line = anchor.at.startLine; line <= last; line++) {
        covered.add(lineKey({ path: anchor.at.path, side, line }));
      }
    }
    for (const key of covered) explained.set(key, [...(explained.get(key) ?? []), stop.id]);
  }
  return explained;
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

/** A changed line's identity (D3) as a string, for maps and sets. */
export const lineKey = ({ path, side, line }: LineRef): string =>
  JSON.stringify([path, side, line]);
const refOf = ({ path, side, line }: ChangedLine): LineRef => ({ path, side, line });
