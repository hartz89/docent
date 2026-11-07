// Test-only fast-check generators shared by the core tests. Not exported from index.ts.
import fc from 'fast-check';
import { commitSha } from './basics.ts';
import { type Diff, makeDiff, type RawFile, type RawHunk, type RawHunkLine } from './diff.ts';

export const base = commitSha('b'.repeat(40));
export const head = commitSha('h'.repeat(40));
export const elsewhere = commitSha('e'.repeat(40));

/** Short lines from a tiny alphabet, so repeats and accidental matches are common. */
export const lineText = fc.constantFrom('', '}', 'return x;', 'x++;', 'if (a) {', 'call();');

const rawLine: fc.Arbitrary<RawHunkLine> = fc.record({
  kind: fc.constantFrom('added', 'removed', 'context'),
  text: lineText,
});

/** A hunk's lines and the gap before it; the start lines are filled in by `rawFile`. */
const hunkBody = fc.record({
  gap: fc.integer({ min: 1, max: 5 }),
  lines: fc.array(rawLine, { minLength: 1, maxLength: 6 }),
});

/** Hunks in file order that never overlap, as in a real diff. */
export function placeHunks(
  bodies: readonly { gap: number; lines: readonly RawHunkLine[] }[],
): RawHunk[] {
  let oldNext = 1;
  let newNext = 1;
  return bodies.map(({ gap, lines }) => {
    const hunk = { oldStart: oldNext + gap, newStart: newNext + gap, lines };
    oldNext = hunk.oldStart + lines.filter((l) => l.kind !== 'added').length;
    newNext = hunk.newStart + lines.filter((l) => l.kind !== 'removed').length;
    return hunk;
  });
}

const rawFile = (path: string): fc.Arbitrary<RawFile> =>
  fc
    .record({
      renamed: fc.boolean(),
      // Some hunks repeat on purpose, to exercise duplicate ids (D5).
      hunks: fc
        .array(hunkBody, { maxLength: 4 })
        .chain((bodies) =>
          fc.subarray(bodies).map((repeats) => placeHunks([...bodies, ...repeats])),
        ),
    })
    .map(({ renamed, hunks }) => ({ path, oldPath: renamed ? `old/${path}` : path, hunks }));

export const rawFiles: fc.Arbitrary<RawFile[]> = fc
  .uniqueArray(fc.constantFrom('a.ts', 'b.ts', 'src/c.ts', 'src/d.ts'), { maxLength: 4 })
  .chain((paths) => fc.tuple(...paths.map(rawFile)));

export const diffs: fc.Arbitrary<Diff> = rawFiles.map((files) => makeDiff(base, head, files));
