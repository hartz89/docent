// The skip ledger for one review. The server only fetches: file text, base's `.gitattributes` and
// word lookups, all from git objects at the pinned base and head. Core decides which lines are
// proven skips and where every changed line stands (P1–P9, L1–L5); this file shapes the answer
// for the browser and the run log.
import {
  type Anchor,
  anchorAt,
  computeLedger,
  type Diff,
  type Evidence,
  type FileTexts,
  type LedgerLine,
  type Proof,
  proveSkips,
  renameLookups,
  reviewId,
  type Stop,
  stopId,
  type Tour,
} from '@docent/core';
import type { Workspace } from './github.ts';
import type { NoteView, TourView } from './tour.ts';

/** What a proven skip shows, in mono, after the word "proven". */
export type ProofLabel = Evidence['label'];

/** One changed file's place in the ledger. Counts are changed lines. */
export type LedgerFileView = {
  /** The file at head, or at base when the PR deleted it. */
  path: string;
  /** The file at base: where its removed lines are. Equals `path` unless the PR moved it. */
  oldPath: string;
  /**
   * The file's dot in the file tree: on the route when a stop cites any of its changed lines, a
   * proven skip when a script proved every one of them, otherwise not on the route.
   */
  place: 'on_route' | 'proven_skip' | 'not_on_route';
  onRoute: number;
  /**
   * Lines a script proved can't change behavior, and which proofs say so: the labels, a rename's
   * mapping, and the rule behind a generated or vendored proof (it says where a file lives, not
   * what it holds, so the reviewer sees which rule it was).
   */
  proven: {
    lines: number;
    labels: ProofLabel[];
    renames: { from: string; to: string }[];
    rules: string[];
  } | null;
  /**
   * Lines nobody cited and nothing proved, by line number: added lines at head, removed lines at
   * base (`oldPath`). The browser opens and marks them on their own side.
   */
  notOnRoute: { added: number[]; removed: number[] } | null;
  /** The guide's optional one-line note, kept only for a file with lines not on the route. */
  note: string | null;
};

export type LedgerView = {
  /** Every changed line, counted once (L1). */
  lines: { onRoute: number; provenSkip: number; notOnRoute: number };
  /** Changed files with changed lines, in diff order. */
  files: LedgerFileView[];
};

/** Reads from git objects at the review's two commits, never the working tree. */
type ProofSource = Pick<Workspace, 'open' | 'baseGitattributes' | 'findWords'>;

/** How long the whole-repo word lookups may take before renames are given up on. */
export const LOOKUP_DEADLINE_MS = 20_000;

/**
 * Every proof core's detectors find in this diff. File text comes from the two pinned commits; a
 * file that isn't plain text there (binary, too large, a symlink) is left unknown, so it proves
 * nothing (P2). Anything that can't be answered in full proves nothing either: word lookups past
 * the deadline (no renames), or a set of base `.gitattributes` git couldn't read completely (no
 * generated or vendored proofs, since a missed file might have opted a folder back in).
 */
export async function proveForReview(
  workspace: ProofSource,
  diff: Diff,
  deadlineMs = LOOKUP_DEADLINE_MS,
): Promise<Proof[]> {
  const texts = await fileTexts(workspace, diff);
  const lookups = renameLookups(diff, texts);
  const none = new Map<string, string[]>();
  // Past the deadline the lookups stop, git included, and their answers count for nothing.
  const deadline = AbortSignal.timeout(deadlineMs);
  const [found, attributes] = await Promise.all([
    Promise.all([
      lookups.atBase.length ? workspace.findWords('old', lookups.atBase, deadline) : none,
      lookups.atHead.length ? workspace.findWords('new', lookups.atHead, deadline) : none,
    ]),
    workspace.baseGitattributes(),
  ]);
  const [base, head] = deadline.aborted ? [none, none] : found;
  const proofs = proveSkips(diff, {
    texts,
    baseGitattributes: attributes ?? new Map(),
    renameOccurrences: { base, head },
  });
  return attributes
    ? proofs
    : proofs.filter((p) => p.evidence.label !== 'generated' && p.evidence.label !== 'vendored');
}

/** Files read at once while gathering text for the proofs. */
const READ_CONCURRENCY = 8;

async function fileTexts(workspace: ProofSource, diff: Diff): Promise<FileTexts> {
  const side = async (which: 'old' | 'new') => {
    const paths = [...new Set(diff.files.map((f) => (which === 'old' ? f.oldPath : f.path)))];
    const texts = new Map<string, string | null>();
    for (let at = 0; at < paths.length; at += READ_CONCURRENCY) {
      const batch = paths.slice(at, at + READ_CONCURRENCY);
      const found = await Promise.all(batch.map((path) => workspace.open(which, path)));
      batch.forEach((path, i) => {
        const file = found[i];
        if (file?.kind === 'text') texts.set(path, file.text);
        else if (file?.kind === 'missing') texts.set(path, null);
      });
    }
    return texts;
  };
  const [base, head] = await Promise.all([side('old'), side('new')]);
  return { base, head };
}

/** The ledger, by file, for the browser and the run log. */
export async function ledgerFor(
  diff: Diff,
  view: TourView,
  proofs: readonly Proof[],
  readFile: Workspace['readFile'],
): Promise<LedgerView> {
  return summarize(await placeLines(diff, view, proofs, readFile), view.notes);
}

/**
 * Where every changed line stands, by core's ledger, from the tour as the browser sees it. The
 * stops' citations are read again from the files, so a cached tour is placed exactly like a
 * fresh one.
 */
export async function placeLines(
  diff: Diff,
  view: TourView,
  proofs: readonly Proof[],
  readFile: Workspace['readFile'],
): Promise<readonly LedgerLine[]> {
  const ledger = computeLedger(diff, await tourOf(diff, view, readFile), proofs);
  // The tour is always built at the diff's own head, so a stale ledger means a bug here.
  if (ledger.state === 'stale') throw new Error('The tour and the diff disagree on the head.');
  return ledger.lines;
}

function summarize(lines: readonly LedgerLine[], notes: readonly NoteView[]): LedgerView {
  const files = new Map<string, LedgerFileView & { proofs: Proof[] }>();
  for (const { line, place } of lines) {
    let file = files.get(line.file);
    if (!file) {
      file = {
        path: line.file,
        oldPath: line.file,
        place: 'not_on_route',
        onRoute: 0,
        proven: null,
        notOnRoute: null,
        note: null,
        proofs: [],
      };
      files.set(line.file, file);
    }
    // A removed line is identified at its base path (D3).
    if (line.side === 'old') file.oldPath = line.path;
    if (place.kind === 'on_route') file.onRoute++;
    else if (place.kind === 'proven_skip') {
      file.proven = { lines: (file.proven?.lines ?? 0) + 1, labels: [], renames: [], rules: [] };
      file.proofs.push(...place.proofs);
    } else {
      const off = file.notOnRoute ?? { added: [], removed: [] };
      (line.side === 'new' ? off.added : off.removed).push(line.line);
      file.notOnRoute = off;
    }
  }

  const noteOf = new Map(notes.map((n) => [n.path, n.note]));
  const out: LedgerFileView[] = [];
  for (const { proofs: fileProofs, ...file } of files.values()) {
    if (file.proven) {
      file.proven.labels = [...new Set(fileProofs.map((p) => p.evidence.label))].sort();
      file.proven.renames = renames(fileProofs);
      file.proven.rules = rules(fileProofs);
    }
    file.place = file.onRoute > 0 ? 'on_route' : file.notOnRoute ? 'not_on_route' : 'proven_skip';
    file.note = file.notOnRoute ? (noteOf.get(file.path) ?? null) : null;
    out.push(file);
  }
  const count = (kind: string) => lines.filter((l) => l.place.kind === kind).length;
  return {
    lines: {
      onRoute: count('on_route'),
      provenSkip: count('proven_skip'),
      notOnRoute: count('not_on_route'),
    },
    files: out,
  };
}

/** The rule behind each generated or vendored proof, in words, each once. */
function rules(proofs: readonly Proof[]): string[] {
  const found = new Set<string>();
  for (const { evidence } of proofs) {
    if (evidence.label !== 'generated' && evidence.label !== 'vendored') continue;
    const { rule } = evidence;
    found.add(
      rule.source === 'gitattributes'
        ? `base ${rule.file}:${rule.line} ${rule.pattern}`
        : `known path ${rule.pattern}`,
    );
  }
  return [...found];
}

/** The old and new names a file's rename proofs rely on, each pair once. */
function renames(proofs: readonly Proof[]): { from: string; to: string }[] {
  const pairs = new Map<string, { from: string; to: string }>();
  for (const { evidence } of proofs) {
    if (evidence.label !== 'rename') continue;
    for (const { from, to } of evidence.changes) {
      pairs.set(JSON.stringify([from, to]), { from, to });
    }
  }
  return [...pairs.values()];
}

/** Core's Tour for a tour view: each citation read again from its file at its commit. */
async function tourOf(diff: Diff, view: TourView, readFile: Workspace['readFile']): Promise<Tour> {
  const stops: Stop[] = [];
  for (const stop of view.stops) {
    const anchors: Anchor[] = [];
    for (const a of stop.anchors) {
      const text = await readFile(a.side, a.path);
      const commit = a.side === 'new' ? diff.head : diff.base;
      const anchor =
        text === null
          ? null
          : anchorAt({ commit, path: a.path, text }, a.startLine, a.endLine - a.startLine + 1);
      if (anchor) anchors.push(anchor);
    }
    const base = { id: stopId(stop.id), title: stop.title, body: stop.body, flags: stop.flags };
    const [first, ...rest] = anchors;
    if (stop.kind === 'core_change' || stop.kind === 'edge') {
      // A citation that no longer reads is simply not on the route (C3).
      if (first) stops.push({ ...base, kind: stop.kind, anchors: [first, ...rest] });
    } else {
      stops.push({ ...base, kind: stop.kind, anchors });
    }
  }
  return { review: reviewId('review'), head: diff.head, stops };
}
