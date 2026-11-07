import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { type Anchor, anchorAt, type FileVersion, reanchor } from './anchor.ts';
import { base, head, lineText } from './arbitraries.ts';
import { splitLines } from './basics.ts';

const file = (lines: readonly string[], commit = base, path = 'a.ts'): FileVersion => ({
  commit,
  path,
  text: lines.join('\n'),
});

/** The lines a current anchor points at in a file. */
const pointedAt = (anchor: Anchor & { state: 'current' }, text: string) =>
  splitLines(text).slice(anchor.at.startLine - 1, anchor.at.startLine - 1 + anchor.lines.length);

const current = (anchor: Anchor | null): Anchor & { state: 'current' } => {
  if (anchor?.state !== 'current') throw new Error(`expected a current anchor, got ${anchor}`);
  return anchor;
};

/** A file, and a range in it to cite. */
const fileAndRange = fc
  .array(lineText, { minLength: 1, maxLength: 12 })
  .chain((lines) =>
    fc
      .integer({ min: 1, max: lines.length })
      .chain((start) =>
        fc
          .integer({ min: 1, max: lines.length - start + 1 })
          .map((count) => ({ lines, start, count })),
      ),
  );

/** Lines that can't accidentally match a cited block, because the block holds a marker. */
const filler = fc.array(lineText, { maxLength: 8 });
const block = fc
  .tuple(fc.array(lineText, { maxLength: 3 }), fc.array(lineText, { maxLength: 3 }))
  .map(([before, after]) => [...before, '// the cited marker line', ...after]);

describe('anchorAt', () => {
  test('A3: a new anchor holds exactly the lines at its location', () => {
    fc.assert(
      fc.property(fileAndRange, ({ lines, start, count }) => {
        const anchor = current(anchorAt(file(lines), start, count));
        expect(pointedAt(anchor, file(lines).text)).toEqual(anchor.lines);
        expect(anchor.lines).toHaveLength(count);
      }),
    );
  });

  test('A1: a range outside the file gives no anchor', () => {
    const f = file(['one', 'two']);
    expect(anchorAt(f, 0, 1)).toBeNull();
    expect(anchorAt(f, 2, 2)).toBeNull();
    expect(anchorAt(f, 1, 0)).toBeNull();
    expect(anchorAt(f, 3, 1)).toBeNull();
  });
});

describe('reanchor', () => {
  test('A5: a current result always points at exactly the cited lines, whatever the new file', () => {
    fc.assert(
      fc.property(
        fileAndRange,
        fc.array(lineText, { maxLength: 15 }),
        ({ lines, start, count }, newLines) => {
          const anchor = current(anchorAt(file(lines), start, count));
          const result = reanchor(anchor, file(newLines, head));
          if (result.state === 'current') {
            expect(pointedAt(result, newLines.join('\n'))).toEqual(anchor.lines);
            expect(result.at.commit).toBe(head);
          }
        },
      ),
    );
  });

  test('A4: moved code is followed to its new place, at the new commit and path', () => {
    fc.assert(
      fc.property(filler, block, filler, filler, filler, (before, cited, after, added, tail) => {
        const anchor = current(
          anchorAt(file([...before, ...cited, ...after]), before.length + 1, cited.length),
        );
        const moved = [...added, ...after, ...cited, ...before, ...tail];
        const result = current(reanchor(anchor, file(moved, head, 'renamed.ts')));
        expect(result.at).toEqual({
          commit: head,
          path: 'renamed.ts',
          startLine: added.length + after.length + 1,
        });
      }),
    );
  });

  test('A4: deleted code is flagged out of date, keeping where it was last seen', () => {
    fc.assert(
      fc.property(filler, block, filler, filler, (before, cited, after, added) => {
        const anchor = current(
          anchorAt(file([...before, ...cited, ...after]), before.length + 1, cited.length),
        );
        const result = reanchor(anchor, file([...after, ...added, ...before], head));
        expect(result).toEqual({ state: 'out_of_date', lines: anchor.lines, lastSeen: anchor.at });
      }),
    );
  });

  test('A6: editing any cited line flags the anchor out of date', () => {
    fc.assert(
      fc.property(filler, block, filler, fc.nat(), (before, cited, after, which) => {
        const anchor = current(
          anchorAt(file([...before, ...cited, ...after]), before.length + 1, cited.length),
        );
        const edited = cited.map((line, i) =>
          i === which % cited.length ? `${line} // edited` : line,
        );
        expect(reanchor(anchor, file([...before, ...edited, ...after], head)).state).toBe(
          'out_of_date',
        );
      }),
    );
  });

  test('A6: an out-of-date anchor becomes current again when its code comes back', () => {
    fc.assert(
      fc.property(filler, block, filler, (before, cited, after) => {
        const original = file([...before, ...cited, ...after]);
        const anchor = current(anchorAt(original, before.length + 1, cited.length));
        const gone = reanchor(anchor, file([...before, ...after], head));
        expect(gone.state).toBe('out_of_date');
        expect(reanchor(gone, original)).toEqual(anchor);
      }),
    );
  });

  test('A4: code that stayed put stays put, even if a copy appears elsewhere', () => {
    const anchor = current(anchorAt(file(['a', 'b', 'c']), 2, 1));
    expect(current(reanchor(anchor, file(['a', 'b', 'c', 'b'], head))).at.startLine).toBe(2);
  });

  test('A4: code that moved and now appears twice is out of date, not guessed at', () => {
    const anchor = current(anchorAt(file(['a', 'b', 'c']), 2, 1));
    expect(reanchor(anchor, file(['b', 'a', 'c', 'b'], head)).state).toBe('out_of_date');
  });

  test('A6: matching is line by line, so CRLF files match and partial lines do not', () => {
    const anchor = current(anchorAt(file(['x', 'call();']), 2, 1));
    const crlf = { commit: head, path: 'a.ts', text: 'y\r\ny\r\ncall();\r\n' };
    expect(current(reanchor(anchor, crlf)).at.startLine).toBe(3);
    expect(reanchor(anchor, file(['  call(); // twice'], head)).state).toBe('out_of_date');
  });
});
