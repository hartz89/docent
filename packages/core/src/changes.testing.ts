// Test-only: builds a diff and the matching file texts from before-and-after file contents, the
// way `git diff` would (three lines of context), so tests read as "this file changed like so".
import { base, head } from './arbitraries.testing.ts';
import { splitLines } from './basics.ts';
import { type Diff, makeDiff, type RawFile, type RawHunk, type RawHunkLine } from './diff.ts';
import type { FileTexts, SideTexts } from './proof.ts';

export type Change = {
  readonly path: string;
  /** Where the file lived at base, when it moved. */
  readonly from?: string;
  /** null: the file doesn't exist on that side. */
  readonly before: string | null;
  readonly after: string | null;
};

export function changes(list: readonly Change[]): { diff: Diff; texts: FileTexts } {
  const baseTexts = new Map<string, string | null>();
  const headTexts = new Map<string, string | null>();
  const files: RawFile[] = list.map((change) => {
    const oldPath = change.from ?? change.path;
    baseTexts.set(oldPath, change.before);
    headTexts.set(change.path, change.after);
    return {
      path: change.path,
      oldPath,
      hunks: hunks(splitLines(change.before ?? ''), splitLines(change.after ?? '')),
    };
  });
  return {
    diff: makeDiff(base, head, files),
    texts: { base: baseTexts as SideTexts, head: headTexts as SideTexts },
  };
}

type Op = RawHunkLine & { readonly oldBefore: number; readonly newBefore: number };

/** A longest-common-subsequence line diff, grouped into hunks with three lines of context. */
export function hunks(before: readonly string[], after: readonly string[]): RawHunk[] {
  const n = before.length;
  const m = after.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      row[j] =
        before[i] === after[j]
          ? (lcs[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(lcs[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    const at = { oldBefore: i, newBefore: j };
    if (i < n && j < m && before[i] === after[j]) {
      ops.push({ kind: 'context', text: before[i++] ?? '', ...at });
      j++;
    } else if (i < n && (j >= m || (lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0))) {
      ops.push({ kind: 'removed', text: before[i++] ?? '', ...at });
    } else {
      ops.push({ kind: 'added', text: after[j++] ?? '', ...at });
    }
  }
  const result: RawHunk[] = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k]?.kind === 'context') {
      k++;
      continue;
    }
    let start = Math.max(0, k - 3);
    while (start > 0 && ops[start - 1]?.kind !== 'context') start--;
    let end = k;
    // Extend while the next change is within six context lines.
    for (;;) {
      while (end + 1 < ops.length && ops[end + 1]?.kind !== 'context') end++;
      let next = end + 1;
      while (next < ops.length && ops[next]?.kind === 'context') next++;
      if (next < ops.length && next - end - 1 <= 6) end = next;
      else break;
    }
    const last = Math.min(ops.length - 1, end + 3);
    const slice = ops.slice(start, last + 1);
    const first = slice[0];
    result.push({
      oldStart: (first?.oldBefore ?? 0) + 1,
      newStart: (first?.newBefore ?? 0) + 1,
      lines: slice.map(({ kind, text }) => ({ kind, text })),
    });
    k = last + 1;
  }
  return result;
}
