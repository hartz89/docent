import type { Brand, CommitSha } from './basics.ts';

/** `<path>#<hash>`, optionally with a `-n` suffix (D4, D5). */
export type HunkId = Brand<string, 'HunkId'>;

/** A hunk line as it comes in: just its kind and text. Line numbers are computed (D2). */
export type RawHunkLine = { readonly kind: 'added' | 'removed' | 'context'; readonly text: string };
export type RawHunk = {
  readonly oldStart: number;
  readonly newStart: number;
  readonly lines: readonly RawHunkLine[];
};
export type RawFile = {
  readonly path: string;
  readonly oldPath: string;
  readonly hunks: readonly RawHunk[];
};

export type HunkLine =
  | { readonly kind: 'added'; readonly newLine: number; readonly text: string }
  | { readonly kind: 'removed'; readonly oldLine: number; readonly text: string }
  | {
      readonly kind: 'context';
      readonly oldLine: number;
      readonly newLine: number;
      readonly text: string;
    };

export type Hunk = { readonly id: HunkId; readonly lines: readonly HunkLine[] };

/** D1: `path` is where the file lives at head (or lived at base, if deleted); `oldPath` at base. */
export type DiffFile = {
  readonly path: string;
  readonly oldPath: string;
  readonly hunks: readonly Hunk[];
};

export type Diff = {
  readonly base: CommitSha;
  readonly head: CommitSha;
  readonly files: readonly DiffFile[];
};

/** Which side of the diff a line number belongs to: base ("old") or head ("new"). */
export type Side = 'old' | 'new';

/** Identifies one changed line (D3). */
export type LineRef = { readonly path: string; readonly side: Side; readonly line: number };

export type ChangedLine = LineRef & { readonly file: string; readonly hunk: HunkId };

/** Builds a diff from raw hunks: computes line numbers (D2) and assigns stable hunk ids (D4–D6). */
export function makeDiff(base: CommitSha, head: CommitSha, files: readonly RawFile[]): Diff {
  return {
    base,
    head,
    files: files.map((file) => {
      const seen = new Map<string, number>();
      return {
        path: file.path,
        oldPath: file.oldPath,
        hunks: file.hunks.map((hunk) => {
          let id = `${file.path}#${hashHunk(file.path, hunk.lines)}`;
          // D5: a repeat (identical content, or a hash collision) gets the next free suffix.
          const count = (seen.get(id) ?? 0) + 1;
          seen.set(id, count);
          if (count > 1) id = `${id}-${count}`;
          return { id: id as HunkId, lines: numberLines(hunk) };
        }),
      };
    }),
  };
}

function numberLines(hunk: RawHunk): HunkLine[] {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  return hunk.lines.map(({ kind, text }): HunkLine => {
    if (kind === 'added') return { kind, newLine: newLine++, text };
    if (kind === 'removed') return { kind, oldLine: oldLine++, text };
    return { kind, oldLine: oldLine++, newLine: newLine++, text };
  });
}

/** D4: FNV-1a (32-bit) over the path and the lines' kinds and text, never their line numbers. */
function hashHunk(path: string, lines: readonly RawHunkLine[]): string {
  const input = JSON.stringify([path, lines.map((line) => [line.kind, line.text])]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Every changed line in the diff, in file and hunk order (D3). */
export function changedLines(diff: Diff): ChangedLine[] {
  const result: ChangedLine[] = [];
  for (const file of diff.files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === 'added') {
          result.push({
            path: file.path,
            side: 'new',
            line: line.newLine,
            file: file.path,
            hunk: hunk.id,
          });
        } else if (line.kind === 'removed') {
          result.push({
            path: file.oldPath,
            side: 'old',
            line: line.oldLine,
            file: file.path,
            hunk: hunk.id,
          });
        }
      }
    }
  }
  return result;
}
