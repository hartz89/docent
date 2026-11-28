// Tour updates (issue #65): when the author pushes, the stops whose cited code didn't change are
// kept, and the guide writes only what's new. The design and its trade-offs are in
// docs/research/2026-11-23-tour-update.md.
//
// A tour that's ready leaves a basis behind: each stop with the exact text it cites, which of
// those lines were changed lines, and a fingerprint of every changed line in the diff. The next
// head's tour plans an update from it: stops are re-anchored with core's `reanchor`, which
// follows moved code and never guesses, and a stop whose code is gone or whose changed lines
// differ is marked stale, to be rewritten or dropped.
import { createHash } from 'node:crypto';
import {
  type Anchor,
  anchorAt,
  type CommitSha,
  changedLines,
  type Diff,
  type HunkLine,
  type LineRef,
  lineKey,
  reanchor,
  type StopFlag,
  type StopKind,
} from '@docent/core';
import type { PrInfo } from './github.ts';
import type { NoteView, TourView, WireNote, WireStop } from './tour.ts';

/** Bump when the basis changes shape: an older one is then ignored, never misread. */
export const BASIS_VERSION = 2;

type BasisCitation = {
  side: 'old' | 'new';
  /** The cited lines and their context, as core anchors them. */
  anchor: Anchor;
  /** Which of the cited lines, counted from 0, were changed lines of the diff. */
  changed: number[];
};
type BasisStop = {
  kind: StopKind;
  title: string;
  body: string;
  flags: { kind: StopFlag; note: string }[];
  citations: BasisCitation[];
};

/** What a ready tour leaves for the next head's update. Server-side only; never sent. */
export type TourBasis = {
  version: typeof BASIS_VERSION;
  pr: number;
  head: CommitSha;
  base: CommitSha;
  /** A fingerprint of the title and description the stops were written against. */
  description: string;
  stops: BasisStop[];
  notes: NoteView[];
  /** A fingerprint of every changed line in the diff: its side, file and text, not where. */
  changed: string[];
};

/** A stop of the earlier tour: kept and healed onto the new lines, or stale, as it was. */
export type PlannedStop = { state: 'kept' | 'stale'; stop: WireStop };

/** How to update an earlier tour for the new head. */
export type UpdatePlan = {
  /** The head the earlier tour was written for. */
  from: CommitSha;
  /** Every stop of the earlier tour, in order. A repair's numbers count all of them. */
  stops: PlannedStop[];
  notes: WireNote[];
  /** Changed lines of the new diff that no changed line of the old one matched. */
  moved: LineRef[];
  /** How many changed lines of the old diff no longer are: the new commits took them out. */
  gone: number;
};

type FileReader = (side: 'old' | 'new', path: string) => Promise<string | null>;

const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

const descriptionOf = (pr: Pick<PrInfo, 'title' | 'body'>) => fingerprint([pr.title, pr.body]);

/**
 * Every changed line, with a fingerprint of what it is: side, file, text, and the lines just
 * before and after it on its side. The neighbors make a line moved within its file, say above the
 * check that guarded it, count as new.
 */
function changedTexts(diff: Diff): { ref: LineRef; id: string }[] {
  const lines: { ref: LineRef; id: string }[] = [];
  for (const file of diff.files) {
    for (const hunk of file.hunks) {
      // Each side's view of the hunk: the new side has no removed lines, the old no added ones.
      const newSide = hunk.lines.filter((l) => l.kind !== 'removed');
      const oldSide = hunk.lines.filter((l) => l.kind !== 'added');
      // Each line's place on its side, found once, so a huge hunk costs linear time.
      const places = new Map<HunkLine, number>();
      for (const side of [newSide, oldSide]) {
        for (const [i, l] of side.entries()) places.set(l, i);
      }
      const around = (side: readonly HunkLine[], line: HunkLine) => {
        const at = places.get(line) ?? -1;
        return [side[at - 1]?.text ?? null, side[at + 1]?.text ?? null];
      };
      for (const line of hunk.lines) {
        if (line.kind === 'added') {
          lines.push({
            ref: { path: file.path, side: 'new', line: line.newLine },
            id: fingerprint(['new', file.path, line.text, ...around(newSide, line)]),
          });
        } else if (line.kind === 'removed') {
          lines.push({
            ref: { path: file.oldPath, side: 'old', line: line.oldLine },
            id: fingerprint(['old', file.oldPath, line.text, ...around(oldSide, line)]),
          });
        }
      }
    }
  }
  return lines;
}

/** Which lines of a range, counted from 0, are changed lines. */
function changedWithin(
  changed: ReadonlySet<string>,
  side: 'old' | 'new',
  path: string,
  startLine: number,
  count: number,
): number[] {
  const within: number[] = [];
  for (let i = 0; i < count; i++) {
    if (changed.has(lineKey({ path, side, line: startLine + i }))) within.push(i);
  }
  return within;
}

/**
 * The basis a ready tour leaves for the next head. Null when a cited file can't be read, so an
 * update never starts from a partial record.
 */
export async function basisFor(
  tour: TourView,
  diff: Diff,
  pr: PrInfo,
  readFile: FileReader,
): Promise<TourBasis | null> {
  const changed = new Set(changedLines(diff).map(lineKey));
  const stops: BasisStop[] = [];
  for (const stop of tour.stops) {
    const citations: BasisCitation[] = [];
    for (const cite of stop.anchors) {
      const text = await readFile(cite.side, cite.path);
      const commit = cite.side === 'new' ? diff.head : diff.base;
      const count = cite.endLine - cite.startLine + 1;
      const anchor =
        text === null ? null : anchorAt({ commit, path: cite.path, text }, cite.startLine, count);
      if (!anchor) return null;
      citations.push({
        side: cite.side,
        anchor,
        changed: changedWithin(changed, cite.side, cite.path, cite.startLine, count),
      });
    }
    stops.push({
      kind: stop.kind,
      title: stop.title,
      body: stop.body,
      flags: stop.flagNotes.map(({ flag, note }) => ({ kind: flag, note })),
      citations,
    });
  }
  return {
    version: BASIS_VERSION,
    pr: pr.number,
    head: diff.head,
    base: diff.base,
    description: descriptionOf(pr),
    stops,
    notes: tour.notes,
    changed: changedTexts(diff).map((l) => l.id),
  };
}

/** A basis read back from disk, or null if it isn't one this version wrote. */
function readBasis(value: unknown): TourBasis | null {
  const basis = value as TourBasis | null;
  return typeof basis === 'object' &&
    basis !== null &&
    basis.version === BASIS_VERSION &&
    typeof basis.head === 'string' &&
    Array.isArray(basis.stops) &&
    Array.isArray(basis.changed) &&
    Array.isArray(basis.notes)
    ? basis
    : null;
}

/**
 * How to update the earlier tour in `saved` for this PR's new head, or null when a whole tour is
 * the right call: no basis, the same head, a changed title or description (the stops' mismatch
 * flags were checked against the old one), or no core_change or edge stop survives.
 */
export async function planUpdate(
  saved: unknown,
  pr: PrInfo,
  diff: Diff,
  readFile: FileReader,
): Promise<UpdatePlan | null> {
  const basis = readBasis(saved);
  if (!basis || basis.pr !== pr.number || basis.head === diff.head) return null;
  if (basis.description !== descriptionOf(pr)) return null;

  const changed = new Set(changedLines(diff).map(lineKey));
  const stops: PlannedStop[] = [];
  for (const old of basis.stops) {
    const citations: WireStop['citations'] = [];
    let kept = true;
    for (const cite of old.citations) {
      const { path } = cite.anchor.state === 'current' ? cite.anchor.at : cite.anchor.lastSeen;
      const text = await readFile(cite.side, path);
      const commit = cite.side === 'new' ? diff.head : diff.base;
      const healed = reanchor(cite.anchor, text === null ? null : { commit, path, text });
      if (healed.state !== 'current') {
        kept = false;
        break;
      }
      const { startLine } = healed.at;
      const count = healed.lines.length;
      const now = changedWithin(changed, cite.side, path, startLine, count);
      // The same text, but a line that was a change is now context, or the other way round:
      // what the stop says about the change no longer holds.
      if (now.join() !== cite.changed.join()) {
        kept = false;
        break;
      }
      citations.push({ path, side: cite.side, startLine, endLine: startLine + count - 1 });
    }
    const stop: WireStop = {
      kind: old.kind,
      title: old.title,
      body: old.body,
      flags: old.flags,
      citations: kept
        ? citations
        : old.citations.map((c) => {
            const at = c.anchor.state === 'current' ? c.anchor.at : c.anchor.lastSeen;
            return {
              path: at.path,
              side: c.side,
              startLine: at.startLine,
              endLine: at.startLine + c.anchor.lines.length - 1,
            };
          }),
    };
    stops.push({ state: kept ? 'kept' : 'stale', stop });
  }
  const anchored = (s: PlannedStop) =>
    s.state === 'kept' && (s.stop.kind === 'core_change' || s.stop.kind === 'edge');
  if (!stops.some(anchored)) return null;

  // Each old changed line matches at most one new one with the same fingerprint.
  const seen = new Map<string, number>();
  for (const id of basis.changed) seen.set(id, (seen.get(id) ?? 0) + 1);
  const moved: LineRef[] = [];
  for (const { ref, id } of changedTexts(diff)) {
    const left = seen.get(id) ?? 0;
    if (left > 0) seen.set(id, left - 1);
    else moved.push(ref);
  }
  const gone = [...seen.values()].reduce((sum, n) => sum + n, 0);
  // A note is the guide's word on a file it left off the route. A file with new lines may no
  // longer be what the note says, so its note goes; the guide may write a new one.
  const touched = new Set(moved.map((l) => l.path));
  const notes = basis.notes.filter((n) => !touched.has(n.path));
  return { from: basis.head, stops, notes, moved, gone };
}

/** Line numbers as short ranges: "3-5, 9". */
function ranges(lines: readonly number[]): string {
  const sorted = [...lines].sort((a, b) => a - b);
  const out: string[] = [];
  let start = sorted[0];
  let end = start;
  for (const line of [...sorted.slice(1), undefined]) {
    if (line !== undefined && end !== undefined && line === end + 1) {
      end = line;
      continue;
    }
    if (start !== undefined) out.push(start === end ? `${start}` : `${start}-${end}`);
    start = line;
    end = line;
  }
  return out.join(', ');
}

/** The new lines, by file and side, as the prompt lists them. */
function movedList(moved: readonly LineRef[]): string {
  const byFile = new Map<string, number[]>();
  for (const { path, side, line } of moved) {
    const key = `${path} ${side === 'new' ? 'new' : 'old'}`;
    byFile.set(key, [...(byFile.get(key) ?? []), line]);
  }
  return [...byFile].map(([where, lines]) => `- ${where} lines ${ranges(lines)}`).join('\n');
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Where the PR section starts in every tour prompt. Everything after it is data. */
const DATA_LINE = '\n----\n\n# PR #';

/**
 * The prompt for an update: the whole-tour prompt, so the guide has the same rules and the full
 * diff. The update rules join the instructions, above the line. The earlier tour's stops and the
 * new lines go below it, after the diff: the stops were written from the PR's content, so they
 * are data too, never instructions.
 */
export function updatePrompt(plan: UpdatePlan, firstPrompt: string): string {
  // The first match is the prompt's own line: everything before it is fixed text.
  const at = firstPrompt.indexOf(DATA_LINE);
  if (at === -1) throw new Error('The tour prompt has no PR section to update.');
  const stops = plan.stops
    .map(({ state, stop }, i) => {
      const cites = stop.citations.length
        ? state === 'kept'
          ? stop.citations.map((c) => `${c.path} ${c.side} ${c.startLine}-${c.endLine}`).join('; ')
          : `code that changed in ${[...new Set(stop.citations.map((c) => c.path))].join(', ')}`
        : 'nothing';
      const flags = (stop.flags ?? []).map((f) => `\n   Flag ${f.kind}: ${oneLine(f.note)}`);
      return `${i + 1}. [${state === 'kept' ? 'kept' : 'changed'}] ${stop.kind}: ${oneLine(stop.title)}\n   ${oneLine(stop.body)}\n   Cites: ${cites}${flags.join('')}`;
    })
    .join('\n');
  const moved = [
    plan.moved.length ? movedList(plan.moved) : 'None.',
    ...(plan.gone
      ? [
          `${plan.gone} changed lines of the earlier tour are no longer in the diff: the new commits took them out or reverted them.`,
        ]
      : []),
  ].join('\n');
  const notes = plan.notes.length
    ? plan.notes.map((n) => `- ${n.path}: ${oneLine(n.note)}`).join('\n')
    : 'None.';
  return `${firstPrompt.slice(0, at)}

${UPDATE_RULES}
${firstPrompt.slice(at)}

## The earlier tour's stops, by number

Written at the earlier head commit ${plan.from.slice(0, 12)}.

${stops}

## The earlier tour's notes

${notes}

## Changed lines new since the earlier tour

${moved}`;
}

export const UPDATE_RULES = `## This is an update of an earlier tour

The reviewer already has a tour of this PR, written at an earlier head commit. The author has pushed since. Don't write a whole new tour: update the earlier one, whose stops are listed by number at the end, after the diff. The diff is the PR as it is now.
- "kept" stops cite lines that haven't changed; their citations are shown at the commits you have now. "changed" stops cite code that changed since: rewrite each one for the code as it is now, or it is removed from the tour.
- The changed lines listed as new since the earlier tour are what the reviewer hasn't seen. Explain them as you would in a whole tour: cite them in a core_change or edge stop, a new one or a rewrite of the stop they belong with, and flag them the same way.
- A "changed" stop with a danger flag must be rewritten: check the danger against the code as it is now, and flag it again if it still holds.
- Rewrite a kept stop, the verdict_prompt included, only if the new commits make it wrong or incomplete.

Send back only what changes, in the same JSON shape:
- "stops": only the stops you rewrite or add, each one in full, following every rule above. To rewrite a stop, set "replaces" to its number (Stop 2 is 2); you may change its title. For a new stop, set "replaces" to 0: it is added after the existing stops of its kind. Leave out every kept stop that still holds.
- "notes": leave it out to keep the notes as they are, or send the complete list to replace them.`;
