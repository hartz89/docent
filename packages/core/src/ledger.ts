// The skip ledger (L1–L5): where every changed line stands. Computed by a script from the
// stops' citations and the proofs, never written by the model.
import type { CommitSha, NonEmpty } from './basics.ts';
import { explainedBy, lineKey } from './coverage.ts';
import { type ChangedLine, changedLines, type Diff } from './diff.ts';
import type { Proof } from './proof.ts';
import type { StopId, Tour } from './tour.ts';

/** L1: exactly one place per changed line, so no line is lost or counted twice. (type) */
export type Placement =
  /** L2: a stop explains it. */
  | { readonly kind: 'on_route'; readonly stops: NonEmpty<StopId> }
  /** L3: a script proved it can't change behavior; it collapses under its label. */
  | { readonly kind: 'proven_skip'; readonly proofs: NonEmpty<Proof> }
  /** L4: everything else, listed by file, one click away. */
  | { readonly kind: 'not_on_route' };

export type LedgerLine = { readonly line: ChangedLine; readonly place: Placement };

export type Ledger =
  /** L5: the tour was written for another head, so its citations say nothing about this diff. */
  | { readonly state: 'stale'; readonly tourHead: CommitSha; readonly diffHead: CommitSha }
  /** Every changed line of the diff, in diff order, each exactly once (L1). */
  | { readonly state: 'computed'; readonly lines: readonly LedgerLine[] };

/**
 * Places every changed line: on the route if a stop explains it, else a proven skip if a valid
 * proof covers it, else not on the route (L1–L4).
 */
export function computeLedger(diff: Diff, tour: Tour, proofs: readonly Proof[]): Ledger {
  if (tour.head !== diff.head) {
    return { state: 'stale', tourHead: tour.head, diffHead: diff.head };
  }
  const all = changedLines(diff);
  const explained = explainedBy(diff, tour.stops);
  const onRoute = (line: ChangedLine) => explained.has(lineKey(line));
  const usable = proofs.filter((proof) => valid(proof, diff, all, onRoute));
  const lines = all.map((line): LedgerLine => {
    const [stop, ...stops] = explained.get(lineKey(line)) ?? [];
    if (stop !== undefined) return { line, place: { kind: 'on_route', stops: [stop, ...stops] } };
    const [proof, ...more] = usable.filter((proof) => covers(proof, line));
    if (proof !== undefined)
      return { line, place: { kind: 'proven_skip', proofs: [proof, ...more] } };
    return { line, place: { kind: 'not_on_route' } };
  });
  return { state: 'computed', lines };
}

/** L3: judged at this head, and for a lockfile, one of its manifests' changed lines is on the route. */
function valid(
  proof: Proof,
  diff: Diff,
  all: readonly ChangedLine[],
  onRoute: (line: ChangedLine) => boolean,
): boolean {
  if (proof.judgedAt !== diff.head) return false;
  if (proof.evidence.label !== 'lockfile') return true;
  const manifests = new Set<string>(proof.evidence.manifests);
  return all.some((line) => manifests.has(line.file) && onRoute(line));
}

function covers({ target }: Proof, line: ChangedLine): boolean {
  if (target.kind === 'file') return line.file === target.path;
  if (target.kind === 'hunk') return line.hunk === target.hunk;
  return lineKey(target.line) === lineKey(line);
}
