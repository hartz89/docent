import { describe, expect, test } from 'vitest';
import { base, head } from './arbitraries.testing.ts';
import { type Change, changes } from './changes.testing.ts';
import {
  proveBlankLines,
  proveGenerated,
  proveImportsInNewFiles,
  proveLockfiles,
  proveReExports,
  proveWhitespace,
} from './detect.ts';
import { makeDiff } from './diff.ts';
import { parseUnifiedDiff } from './diff-parse.ts';
import type { FileTexts, Proof } from './proof.ts';

const lines = (...text: string[]) => `${text.join('\n')}\n`;
const labels = (proofs: readonly Proof[]) => proofs.map((p) => p.evidence.label);

const whitespace = (...list: Change[]) => {
  const { diff, texts } = changes(list);
  return proveWhitespace(diff, texts);
};

describe('P2: detectors only trust text that matches the diff', () => {
  const before = lines('function f() {', 'return 1;', '}');
  const after = lines('function f() {', '  return 1;', '}');

  test('P2: an unknown file proves nothing', () => {
    const { diff } = changes([{ path: 'a.ts', before, after }]);
    const unknown: FileTexts = { base: new Map(), head: new Map() };
    expect(proveWhitespace(diff, unknown)).toEqual([]);
  });

  test('P2: text from another commit proves nothing', () => {
    const { diff } = changes([{ path: 'a.ts', before, after }]);
    const other: FileTexts = {
      base: new Map([['a.ts', lines('function f() {', 'return 2;', '}')]]),
      head: new Map([['a.ts', after]]),
    };
    expect(proveWhitespace(diff, other)).toEqual([]);
    expect(whitespace({ path: 'a.ts', before, after })).toHaveLength(1);
  });

  test('P2: a proof records the head it was judged at', () => {
    const [proof] = whitespace({ path: 'a.ts', before, after });
    expect(proof?.judgedAt).toBe(head);
  });
});

describe('P3: whitespace only', () => {
  test('P3: re-indenting and trailing spaces in a TS file are proven', () => {
    const proofs = whitespace({
      path: 'src/a.ts',
      before: lines('if (a) {', 'call(a);  ', '', '}'),
      after: lines('if (a) {', '    call(a);', '}'),
    });
    expect(labels(proofs)).toEqual(['whitespace']);
  });

  test('P3: spacing between tokens is proven only where it cannot join them', () => {
    const spaced = (before: string, after: string) =>
      whitespace({ path: 'a.ts', before: lines(before), after: lines(after) }).length;
    expect(spaced('x = a+b;', 'x = a + b;')).toBe(1);
    expect(spaced('f(a,b)', 'f(a, b)')).toBe(1);
    expect(spaced('x = a + +b;', 'x = a ++b;')).toBe(0);
    expect(spaced('x = a - -b;', 'x = a --b;')).toBe(0);
    expect(spaced('return x;', 'returnx;')).toBe(0);
    expect(spaced('y = 1 .e3;', 'y = 1.e3;')).toBe(0);
  });

  test('P3: spacing inside strings, regexes and comments is never proven', () => {
    const spaced = (before: string, after: string) =>
      whitespace({ path: 'a.ts', before: lines(before), after: lines(after) }).length;
    expect(spaced("s = 'a +';", "s = 'a+';")).toBe(0);
    expect(spaced('r = /a +/;', 'r = /a+/;')).toBe(0);
    expect(spaced('// a  b', '// a b')).toBe(0);
  });

  test('P3: indentation in whitespace-significant languages is never proven', () => {
    const python = whitespace({
      path: 'job.py',
      before: lines('if admin:', '    grant()', 'audit()'),
      after: lines('if admin:', '    grant()', '    audit()'),
    });
    const yaml = whitespace({
      path: 'ci.yml',
      before: lines('steps:', '  - run: test', 'deploy: true'),
      after: lines('steps:', '  - run: test', '  deploy: true'),
    });
    const make = whitespace({
      path: 'Makefile',
      before: lines('build:', '\tcc main.c', 'clean:'),
      after: lines('build:', '        cc main.c', 'clean:'),
    });
    expect([...python, ...yaml, ...make]).toEqual([]);
  });

  test('P3: a file where a string could span lines is never proven', () => {
    const template = whitespace({
      path: 'a.ts',
      before: lines('const sql = `', 'SELECT *', 'FROM users`;'),
      after: lines('const sql = `', '  SELECT *', 'FROM users`;'),
    });
    const nested = whitespace({
      path: 'a.ts',
      before: lines('const s = `a ${ `b', 'c` } d`;', 'f();'),
      after: lines('const s = `a ${ `b', '  c` } d`;', 'f();'),
    });
    const continued = whitespace({
      path: 'a.c',
      before: lines('#define X a \\', 'b', 'int y;'),
      after: lines('#define X a \\', '  b', 'int y;'),
    });
    const raw = whitespace({
      path: 'a.cs',
      before: lines('var s = @"one', 'two";'),
      after: lines('var s = @"one', '  two";'),
    });
    expect([...template, ...nested, ...continued, ...raw]).toEqual([]);
  });

  test('P3: a backtick hidden in a string, rune or regex still counts as an open template', () => {
    const close = 'world$' + "{'`'}`;"; // The source text under test, which closes the template.
    const ts = whitespace({
      path: 'a.ts',
      before: lines("const t = '`' + `", 'hello', close, 'log(t);'),
      after: lines("const t = '`' + `", '        hello', close, 'log(t);'),
    });
    const go = whitespace({
      path: 'a.go',
      before: lines('package main', "var t = string('`') + `", 'hello', "` + string('`')"),
      after: lines('package main', "var t = string('`') + `", '    hello', "` + string('`')"),
    });
    expect([...ts, ...go]).toEqual([]);
    const { diff, texts } = changes([
      {
        path: 'a.ts',
        before: lines("const t = '`' + `", 'hello', close),
        after: lines("const t = '`' + `", 'hello', '', close),
      },
    ]);
    expect(proveBlankLines(diff, texts)).toEqual([]);
  });

  test('P3: Go keeps its blank lines and directives exactly', () => {
    const blank = whitespace({
      path: 'a.go',
      before: lines('// +build linux', '', 'package a'),
      after: lines('// +build linux', 'package a'),
    });
    const directive = whitespace({
      path: 'a.go',
      before: lines('package a', '//go:embed x', 'var x string'),
      after: lines('package a', '  //go:embed x', 'var x string'),
    });
    expect([...blank, ...directive]).toEqual([]);
  });

  test('P3: a hunk with any other change is not proven', () => {
    expect(
      whitespace({
        path: 'a.ts',
        before: lines('if (a) {', 'call(a);', '}'),
        after: lines('if (a) {', '  call(b);', '}'),
      }),
    ).toEqual([]);
  });
});

describe('P4: blank lines', () => {
  test('P4: changed blank lines are proven where blank lines mean nothing', () => {
    const { diff, texts } = changes([
      { path: 'a.ts', before: lines('a();', 'b();'), after: lines('a();', '', 'b();', '') },
    ]);
    expect(proveBlankLines(diff, texts).map((p) => p.target)).toEqual([
      { kind: 'line', line: { path: 'a.ts', side: 'new', line: 2 } },
      { kind: 'line', line: { path: 'a.ts', side: 'new', line: 4 } },
    ]);
  });

  test('P4: never in a string, in YAML or Markdown, or in Go', () => {
    const { diff, texts } = changes([
      {
        path: 'a.py',
        before: lines('s = """', 'x', '"""'),
        after: lines('s = """', '', 'x', '"""'),
      },
      { path: 'a.yml', before: lines('a: |', '  x'), after: lines('a: |', '', '  x') },
      { path: 'a.md', before: lines('a', 'b'), after: lines('a', '', 'b') },
      { path: 'a.go', before: lines('a', 'b'), after: lines('a', '', 'b') },
    ]);
    expect(proveBlankLines(diff, texts)).toEqual([]);
  });
});

describe('P5: imports in a new file', () => {
  const prove = (text: string, before: string | null = null) => {
    const { diff, texts } = changes([{ path: 'src/new.ts', before, after: text }]);
    return proveImportsInNewFiles(diff, texts).map((p) =>
      p.target.kind === 'line' ? p.target.line.line : -1,
    );
  };

  test('P5: named and type-only imports at the top of a new file are proven', () => {
    const file = lines(
      '#!/usr/bin/env node',
      '/* License header',
      ' * spanning lines */',
      "'use strict';",
      "import { a, b as c } from './x.ts';",
      "import type { T } from './t.ts';",
      'import {',
      '  type U,',
      '  d,',
      "} from './y.ts';",
      '',
      'export const run = () => a(c, d);',
      "import { late } from './z.ts';",
    );
    expect(prove(file)).toEqual([5, 6, 7, 8, 9, 10]);
  });

  test('P5: side-effect, default and namespace imports are never proven', () => {
    const file = lines(
      "import './polyfill';",
      "import React from 'react';",
      "import * as fs from 'node:fs';",
      "import {} from './empty.ts';",
      "import { ok } from './ok.ts';",
    );
    expect(prove(file)).toEqual([5]);
  });

  test('P5: imports in an existing file are never proven', () => {
    const before = lines("import { a } from './a.ts';", 'a();');
    const after = lines("import { a } from './b.ts';", 'a();');
    expect(prove(after, before)).toEqual([]);
  });

  test('P5: an import line that also runs code is not proven', () => {
    expect(prove(lines("import { a } from './a.ts'; steal();"))).toEqual([]);
  });
});

describe('P6: re-exports', () => {
  const prove = (before: string | null, after: string | null) => {
    const { diff, texts } = changes([{ path: 'src/index.ts', before, after }]);
    return labels(proveReExports(diff, texts));
  };

  test('P6: a new barrel is proven', () => {
    expect(
      prove(null, lines("export { a, b as c } from './a.ts';", "export * from './b.ts';")),
    ).toEqual(['re_export']);
  });

  test('P6: adding a name from a module the barrel already loads is proven', () => {
    expect(
      prove(
        lines("export { a } from './a.ts';", "export type { T } from './t.ts';"),
        lines("export { a, b } from './a.ts';", '', "export type { T } from './t.ts';"),
      ),
    ).toEqual(['re_export']);
  });

  test('P6: a line that also declares something is not a re-export', () => {
    expect(
      prove(
        lines("export { a } from './a.ts';"),
        lines("export { a } from './a.ts'; export const b = 1;"),
      ),
    ).toEqual([]);
    expect(prove(null, lines("export { a } from './a.ts';", 'export const b = 1;'))).toEqual([]);
  });

  test('P6: a change that loads a new module or rebinds a name is not proven', () => {
    const newModule = prove(
      lines("export { a } from './a.ts';"),
      lines("export { a } from './a.ts';", "export * from './polyfill.ts';"),
    );
    const rebound = prove(
      lines("export { check } from './safe.ts';", "export { other } from './unsafe.ts';"),
      lines("export { check } from './unsafe.ts';", "export { other } from './safe.ts';"),
    );
    const renamedAway = prove(
      lines("export { a, b } from './a.ts';"),
      lines("export { a, c as b } from './a.ts';"),
    );
    const removed = prove(
      lines("export { a, b } from './a.ts';"),
      lines("export { a } from './a.ts';"),
    );
    expect([...newModule, ...rebound, ...renamedAway, ...removed]).toEqual([]);
  });

  test('P6: reordering a barrel changes which module loads first, so it is not proven', () => {
    expect(
      prove(
        lines("export * from './polyfill.ts';", "export { a } from './a.ts';"),
        lines("export { a } from './a.ts';", "export * from './polyfill.ts';"),
      ),
    ).toEqual([]);
  });

  test('P6: a new name next to an export * could shadow it, so it is not proven', () => {
    expect(
      prove(
        lines("export * from './safe.ts';", "export { other } from './unsafe.ts';"),
        lines("export * from './safe.ts';", "export { other, sanitize } from './unsafe.ts';"),
      ),
    ).toEqual([]);
  });
});

describe('P7: lockfiles', () => {
  const lock = (before: string[], after: string[], extra: Change[] = []) => {
    const { diff } = changes([
      { path: 'pnpm-lock.yaml', before: lines(...before), after: lines(...after) },
      ...extra,
    ]);
    return proveLockfiles(diff);
  };
  const manifest: Change = {
    path: 'packages/core/package.json',
    before: lines('{', '"a": "1"', '}'),
    after: lines('{', '"a": "2"', '}'),
  };
  const body = [
    'lockfileVersion: 9',
    'packages:',
    '  a@1:',
    '    resolution: {integrity: sha512-x}',
  ];
  const bumped = [
    'lockfileVersion: 9',
    'packages:',
    '  a@2:',
    '    resolution: {integrity: sha512-y}',
  ];

  test('P7: a lockfile is proven when a manifest it covers changed too, and names it', () => {
    const [proof] = lock(body, bumped, [manifest]);
    expect(proof?.evidence).toEqual({
      label: 'lockfile',
      manifests: ['packages/core/package.json'],
    });
  });

  test('P7: without a manifest change, or when created or deleted, it is not proven', () => {
    expect(lock(body, bumped)).toEqual([]);
    const { diff } = changes([
      { path: 'pnpm-lock.yaml', before: null, after: lines(...bumped) },
      manifest,
    ]);
    expect(proveLockfiles(diff)).toEqual([]);
  });

  test('P7: a lockfile that points somewhere new is not proven', () => {
    const tarball = [...body.slice(0, 3), '    resolution: {tarball: https://evil.example/a.tgz}'];
    const git = [...body.slice(0, 3), '    resolved "git+https://github.com/evil/a.git"'];
    expect([...lock(body, tarball, [manifest]), ...lock(body, git, [manifest])]).toEqual([]);
    const registry = [...body.slice(0, 3), '    resolved "https://registry.npmjs.org/a/-/a-2.tgz"'];
    expect(lock(body, registry, [manifest])).toHaveLength(1);
  });
});

describe('P8: generated and vendored files', () => {
  /** A file that existed at base, with one line changed. */
  const touched = (path: string) =>
    makeDiff(base, head, [
      {
        path,
        oldPath: path,
        hunks: [
          {
            oldStart: 1,
            newStart: 1,
            lines: [
              { kind: 'removed', text: 'x' },
              { kind: 'added', text: 'y' },
            ],
          },
        ],
      },
    ]);

  test('P8: base .gitattributes marks files generated or vendored', () => {
    const attributes = new Map([
      ['.gitattributes', lines('*.snap linguist-generated', 'api/** linguist-vendored=true')],
    ]);
    const [snap] = proveGenerated(touched('src/a.snap'), attributes);
    expect(snap?.evidence).toEqual({
      label: 'generated',
      rule: { source: 'gitattributes', file: '.gitattributes', line: 1, pattern: '*.snap' },
    });
    expect(labels(proveGenerated(touched('api/x/y.ts'), attributes))).toEqual(['vendored']);
    expect(proveGenerated(touched('src/api/y.ts'), attributes)).toEqual([]);
  });

  test('P8: known patterns count unless base unsets them', () => {
    expect(labels(proveGenerated(touched('dist/index.js'), new Map()))).toEqual(['generated']);
    expect(labels(proveGenerated(touched('a/vendor/b.go'), new Map()))).toEqual(['vendored']);
    const unset = new Map([['.gitattributes', lines('dist/index.js -linguist-generated')]]);
    expect(proveGenerated(touched('dist/index.js'), unset)).toEqual([]);
  });

  test('P8: a new file the PR puts in a known folder is not proven by the pattern alone', () => {
    const { diff } = changes([{ path: 'dist/evil.js', before: null, after: lines('steal();') }]);
    expect(proveGenerated(diff, new Map())).toEqual([]);
    const marked = new Map([['.gitattributes', lines('dist/** linguist-generated')]]);
    expect(labels(proveGenerated(diff, marked))).toEqual(['generated']);
  });

  test('P8: a .gitattributes change in the PR itself is ignored', () => {
    const diff = parseUnifiedDiff(
      lines(
        'diff --git a/.gitattributes b/.gitattributes',
        '--- a/.gitattributes',
        '+++ b/.gitattributes',
        '@@ -1 +1,2 @@',
        ' *.snap linguist-generated',
        '+src/auth.ts linguist-generated',
        'diff --git a/src/auth.ts b/src/auth.ts',
        '--- a/src/auth.ts',
        '+++ b/src/auth.ts',
        '@@ -1 +1 @@',
        '-check(user);',
        '+skip(user);',
      ),
      base,
      head,
    );
    const atBase = new Map([['.gitattributes', lines('*.snap linguist-generated')]]);
    expect(proveGenerated(diff, atBase)).toEqual([]);
  });

  test('P8: lines the parser cannot read make the attribute prove nothing', () => {
    for (const text of [
      '"dist/a b.js" -linguist-generated',
      'dist/[ab].js -linguist-generated',
      '[attr]keep -linguist-generated',
    ]) {
      expect(
        proveGenerated(touched('dist/a.js'), new Map([['.gitattributes', lines(text)]])),
      ).toEqual([]);
    }
  });

  test('P8: nested .gitattributes match relative to their folder, and deeper ones win', () => {
    const attributes = new Map([
      ['.gitattributes', lines('*.gen.ts linguist-generated')],
      ['src/.gitattributes', lines('/keep.gen.ts -linguist-generated', 'out/* linguist-generated')],
    ]);
    expect(proveGenerated(touched('src/keep.gen.ts'), attributes)).toEqual([]);
    expect(labels(proveGenerated(touched('lib/keep.gen.ts'), attributes))).toEqual(['generated']);
    expect(labels(proveGenerated(touched('src/out/a.ts'), attributes))).toEqual(['generated']);
    expect(proveGenerated(touched('out/a.ts'), attributes)).toEqual([]);
  });

  test('P8: a file moved out of a generated folder must qualify at both paths', () => {
    const diff = makeDiff(base, head, [
      {
        path: 'dist/evil.js',
        oldPath: 'src/evil.js',
        hunks: [{ oldStart: 1, newStart: 1, lines: [{ kind: 'added', text: 'x' }] }],
      },
    ]);
    expect(proveGenerated(diff, new Map())).toEqual([]);
  });
});
