import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { base, head, rawFiles } from './arbitraries.ts';
import { makeDiff, type RawFile, type RawHunkLine } from './diff.ts';
import { parseRawFiles, parseUnifiedDiff } from './diff-parse.ts';

const MARK = { added: '+', removed: '-', context: ' ' } as const;
const count = (lines: readonly RawHunkLine[], skip: RawHunkLine['kind']) =>
  lines.filter((line) => line.kind !== skip).length;

/** Prints raw files the way `git diff` does, so the parser can be checked against its inverse. */
function render(files: readonly RawFile[]): string {
  return files
    .map((file) => {
      const out = [`diff --git a/${file.oldPath} b/${file.path}`];
      if (file.oldPath !== file.path) {
        out.push('similarity index 90%', `rename from ${file.oldPath}`, `rename to ${file.path}`);
      } else if (file.hunks.length === 0) {
        out.push('old mode 100644', 'new mode 100755');
      }
      if (file.hunks.length > 0) out.push(`--- a/${file.oldPath}`, `+++ b/${file.path}`);
      for (const hunk of file.hunks) {
        const old = count(hunk.lines, 'added');
        const neu = count(hunk.lines, 'removed');
        out.push(`@@ -${hunk.oldStart},${old} +${hunk.newStart},${neu} @@ function f() {`);
        for (const line of hunk.lines) out.push(`${MARK[line.kind]}${line.text}`);
      }
      return out.join('\n');
    })
    .join('\n');
}

describe('parseUnifiedDiff', () => {
  test('reads back exactly the files a diff was printed from', () => {
    fc.assert(
      fc.property(rawFiles, (files) => {
        expect(parseRawFiles(`${render(files)}\n`)).toEqual(files);
      }),
    );
  });

  test('gives the same diff, ids included, as building it from the raw files', () => {
    fc.assert(
      fc.property(rawFiles, (files) => {
        expect(parseUnifiedDiff(render(files), base, head)).toEqual(makeDiff(base, head, files));
      }),
    );
  });

  test('never throws on arbitrary text, and ignores anything before the first file', () => {
    fc.assert(
      fc.property(fc.string(), (junk) => {
        const files = parseRawFiles(junk.replaceAll('diff --git', ''));
        expect(files).toEqual([]);
      }),
    );
  });

  test('reads a real git diff: new, deleted, renamed, binary and no-newline files', () => {
    const text = [
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      'index 0000000..3b18e51',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,2 @@',
      '+export const a = 1;',
      '+export const b = 2;',
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      'index 3b18e51..0000000',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      '\\ No newline at end of file',
      'diff --git a/old name.ts b/new name.ts',
      'similarity index 80%',
      'rename from old name.ts',
      'rename to new name.ts',
      'index 1111111..2222222 100644',
      '--- a/old name.ts',
      '+++ b/new name.ts',
      '@@ -3,3 +3,3 @@ class X {',
      ' keep',
      '--- looks like a header but is a removed line',
      '+++ looks like a header but is an added line',
      ' keep',
      'diff --git a/logo.png b/logo.png',
      'index 1111111..2222222 100644',
      'Binary files a/logo.png and b/logo.png differ',
      '',
    ].join('\n');

    const diff = parseUnifiedDiff(text, base, head);

    expect(diff.files.map((f) => [f.oldPath, f.path, f.hunks.length])).toEqual([
      ['src/new.ts', 'src/new.ts', 1],
      ['gone.ts', 'gone.ts', 1],
      ['old name.ts', 'new name.ts', 1],
      ['logo.png', 'logo.png', 0],
    ]);
    expect(diff.files[0]?.hunks[0]?.lines).toEqual([
      { kind: 'added', newLine: 1, text: 'export const a = 1;' },
      { kind: 'added', newLine: 2, text: 'export const b = 2;' },
    ]);
    expect(diff.files[1]?.hunks[0]?.lines).toEqual([{ kind: 'removed', oldLine: 1, text: 'bye' }]);
    expect(diff.files[2]?.hunks[0]?.lines.map((l) => l.kind)).toEqual([
      'context',
      'removed',
      'added',
      'context',
    ]);
  });

  test('decodes git-quoted paths with escaped UTF-8', () => {
    const text = [
      'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
      '--- "a/caf\\303\\251.ts"',
      '+++ "b/caf\\303\\251.ts"',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n');

    expect(parseRawFiles(text).map((f) => f.path)).toEqual(['café.ts']);
  });
});
