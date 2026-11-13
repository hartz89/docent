// Which changed lines a tour's stops explain (C1–C4): the lines the ledger puts on the route.
import { endLine } from './anchor.ts';
import type { Diff, LineRef, Side } from './diff.ts';
import type { Stop, StopId } from './tour.ts';

/**
 * The stops that explain each line (C1–C4), keyed by `lineKey`. Only current anchors at the
 * diff's base or head count, and only on `core_change` and `edge` stops. Lines nobody explains
 * are absent.
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
    for (const key of covered) explained.set(key, [...(explained.get(key) ?? []), stop.id]); // C4
  }
  return explained;
}

function sideAt(diff: Diff, commit: string): Side | null {
  if (commit === diff.head) return 'new';
  if (commit === diff.base) return 'old';
  return null;
}

/** A changed line's identity (D3) as a string, for maps and sets. */
export const lineKey = ({ path, side, line }: LineRef): string =>
  JSON.stringify([path, side, line]);
