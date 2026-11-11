import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { base, diffs, head, placeHunks, rawFiles } from './arbitraries.testing.ts';
import { changedLines, type Diff, diffPosition, makeDiff } from './diff.ts';

const ids = (diff: Diff) => diff.files.flatMap((file) => file.hunks.map((hunk) => hunk.id));

describe('makeDiff', () => {
  test('D2: line numbers run on from the hunk starts, one side at a time', () => {
    fc.assert(
      fc.property(rawFiles, (files) => {
        const diff = makeDiff(base, head, files);
        diff.files.forEach((file, f) => {
          file.hunks.forEach((hunk, h) => {
            const raw = files[f]?.hunks[h];
            const oldLines = hunk.lines.flatMap((l) => (l.kind === 'added' ? [] : [l.oldLine]));
            const newLines = hunk.lines.flatMap((l) => (l.kind === 'removed' ? [] : [l.newLine]));
            expect(oldLines).toEqual(oldLines.map((_, i) => (raw?.oldStart ?? 0) + i));
            expect(newLines).toEqual(newLines.map((_, i) => (raw?.newStart ?? 0) + i));
          });
        });
      }),
    );
  });

  test('D3: changed lines are the added lines at head and the removed lines at base', () => {
    const [file] = makeDiff(base, head, [
      {
        path: 'new.ts',
        oldPath: 'old.ts',
        hunks: [
          {
            oldStart: 3,
            newStart: 4,
            lines: [
              { kind: 'context', text: 'a' },
              { kind: 'removed', text: 'b' },
              { kind: 'added', text: 'c' },
            ],
          },
        ],
      },
    ]).files;
    expect(changedLines({ base, head, files: file ? [file] : [] })).toMatchObject([
      { path: 'old.ts', side: 'old', line: 4, file: 'new.ts' },
      { path: 'new.ts', side: 'new', line: 5, file: 'new.ts' },
    ]);
  });

  test('D4: an id is the path, then an 8-digit hash', () => {
    fc.assert(
      fc.property(diffs, (diff) => {
        for (const file of diff.files) {
          for (const hunk of file.hunks) {
            expect(hunk.id.startsWith(`${file.path}#`)).toBe(true);
            expect(hunk.id.slice(file.path.length)).toMatch(/^#[0-9a-f]{8}(-\d+)?$/);
          }
        }
      }),
    );
  });

  test('D5: hunk ids are unique, even when hunks repeat', () => {
    fc.assert(
      fc.property(diffs, (diff) => {
        expect(new Set(ids(diff)).size).toBe(ids(diff).length);
      }),
    );
  });

  test('D6: ids survive other hunks being added and line numbers shifting', () => {
    const unique = { kind: 'added', text: 'a line no generated hunk contains' } as const;
    fc.assert(
      fc.property(rawFiles, fc.nat(), fc.nat(), (files, at, shift) => {
        const before = makeDiff(base, head, files);
        const after = makeDiff(
          base,
          head,
          files.map((file) => {
            const bodies = file.hunks.map((hunk) => ({ gap: 1 + shift, lines: hunk.lines }));
            bodies.splice(at % (bodies.length + 1), 0, { gap: 1, lines: [unique] });
            return { ...file, hunks: placeHunks(bodies) };
          }),
        );
        const added = new Set(ids(after).filter((id) => !ids(before).includes(id)));
        expect(ids(after).filter((id) => !added.has(id))).toEqual(ids(before));
        expect(added.size).toBe(files.length);
        expect(makeDiff(base, head, files)).toEqual(before);
      }),
    );
  });
});

describe('diffPosition', () => {
  // A renamed file, old.ts → new.ts, with one line changed in a three-line hunk.
  const diff = makeDiff(base, head, [
    {
      path: 'new.ts',
      oldPath: 'old.ts',
      hunks: [
        {
          oldStart: 10,
          newStart: 12,
          lines: [
            { kind: 'context', text: 'a' },
            { kind: 'removed', text: 'b' },
            { kind: 'added', text: 'B' },
          ],
        },
      ],
    },
  ]);

  test('places lines as GitHub does, always under the head path of a renamed file', () => {
    expect(diffPosition(diff, { path: 'new.ts', side: 'new', line: 13 })).toEqual({
      path: 'new.ts',
      side: 'new',
      line: 13,
    });
    expect(diffPosition(diff, { path: 'old.ts', side: 'old', line: 11 })).toEqual({
      path: 'new.ts',
      side: 'old',
      line: 11,
    });
    // An unchanged line seen at base sits on the head side, at its head number.
    expect(diffPosition(diff, { path: 'old.ts', side: 'old', line: 10 })).toEqual({
      path: 'new.ts',
      side: 'new',
      line: 12,
    });
  });

  test('a line outside every hunk, or named by the other side’s path, has no place', () => {
    expect(diffPosition(diff, { path: 'new.ts', side: 'new', line: 30 })).toBeNull();
    expect(diffPosition(diff, { path: 'new.ts', side: 'old', line: 11 })).toBeNull();
    expect(diffPosition(diff, { path: 'old.ts', side: 'new', line: 13 })).toBeNull();
  });
});
