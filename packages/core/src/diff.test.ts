import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { base, diffs, head, placeHunks, rawFiles } from './arbitraries.testing.ts';
import { changedLines, type Diff, makeDiff } from './diff.ts';

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
