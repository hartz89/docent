import { describe, expect, test } from 'vitest';
import { indexOf, testGrammars } from './symbols.testing.ts';
import { extractSymbols } from './symbols.ts';

const at = (path: string, line: number) => expect.objectContaining({ path, line });

describe('definitions', () => {
  test('N1: functions, classes, methods, types, interfaces, enums, consts and overloads', async () => {
    const index = await indexOf({
      'src/shapes.ts': [
        'export function area(s: Square): number;', // 1
        'export function area(s: Circle): number;', // 2
        'export function area(s: Shape): number { return 0; }', // 3
        'export class Square { grow() {} }', // 4
        'export interface Circle { r: number }', // 5
        'export type Shape = Square | Circle;', // 6
        'export enum Unit { Px, Em }', // 7
        'export const ORIGIN = { x: 0 }, scale = (n: number) => n;', // 8
        'namespace Geometry {}', // 9
      ].join('\n'),
    });
    const kinds = (symbol: string) =>
      index.definitions(symbol).map(({ line, kind }) => ({ line, kind }));
    expect(kinds('area')).toEqual([
      { line: 1, kind: 'function' },
      { line: 2, kind: 'function' },
      { line: 3, kind: 'function' },
    ]);
    expect(kinds('Square')).toEqual([{ line: 4, kind: 'class' }]);
    expect(kinds('grow')).toEqual([{ line: 4, kind: 'method' }]);
    expect(kinds('Circle')).toEqual([{ line: 5, kind: 'interface' }]);
    expect(kinds('Shape')).toEqual([{ line: 6, kind: 'type' }]);
    expect(kinds('Unit')).toEqual([{ line: 7, kind: 'enum' }]);
    expect(kinds('ORIGIN')).toEqual([{ line: 8, kind: 'constant' }]);
    expect(kinds('scale')).toEqual([{ line: 8, kind: 'function' }]);
    expect(kinds('Geometry')).toEqual([{ line: 9, kind: 'module' }]);
  });

  test('N1: a parse past its deadline gives nothing, and the next file still parses cleanly', async () => {
    const grammar = (await testGrammars()).get('typescript');
    if (!grammar) throw new Error('no TypeScript grammar');
    const slow = 'export function f() { return [1].map((x) => x); }\n'.repeat(5000);
    expect(extractSymbols(grammar, slow, Date.now() - 1)).toBeNull();
    expect(extractSymbols(grammar, 'function g() {}')?.definitions).toEqual([
      { name: 'g', kind: 'function', line: 1, topLevel: true },
    ]);
  });

  test('N1: a long run of comments stays fast, and the definitions after it are found', async () => {
    const index = await indexOf({
      'a.ts': `${'// note\n'.repeat(20_000)}export function after() {}\n`,
    });
    // Every grammar's tags had the slow pattern, so each one is checked.
    const comments = '// note\n'.repeat(20_000);
    const started = performance.now();
    const again = await indexOf({
      'b.ts': `${comments}function b() {}\n`,
      'c.js': `${comments}function c() {}\n`,
      'd.go': `package d\n${comments}func d() {}\n`,
      'e.tsx': `${comments}function e() {}\n`,
    });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(index.definitions('after')).toEqual([at('a.ts', 20_001)]);
    expect(again.definitions('b')).toEqual([at('b.ts', 20_001)]);
    expect(again.definitions('c')).toEqual([at('c.js', 20_001)]);
    expect(again.definitions('d')).toEqual([at('d.go', 20_002)]);
    expect(again.definitions('e')).toEqual([at('e.tsx', 20_001)]);
  });

  test('N1: TSX, JSX, Python and Go files are indexed too', async () => {
    const index = await indexOf({
      'web/App.tsx': 'export function App() { return <div />; }\n',
      'web/legacy.jsx': 'export const Old = () => <span />;\n',
      'tools/build.py': 'class Builder:\n    def run(self):\n        pass\n',
      'cmd/main.go': 'package main\n\ntype Server struct{}\n\nfunc (s *Server) Run() {}\n',
    });
    expect(index.definitions('App')).toEqual([at('web/App.tsx', 1)]);
    expect(index.definitions('Old')).toEqual([at('web/legacy.jsx', 1)]);
    expect(index.definitions('run')).toEqual([at('tools/build.py', 2)]);
    expect(index.definitions('Server')).toEqual([at('cmd/main.go', 3)]);
    expect(index.definitions('Run')).toEqual([at('cmd/main.go', 5)]);
  });

  test('N2, N5: ambiguous names return every candidate, same file then imports then repo', async () => {
    const index = await indexOf({
      'src/app.ts': [
        "import { helper } from './lib';", // 1
        'function parse() {}', // 2
        'helper(parse);', // 3
        'function parse2() { function parse() {} }', // 4
      ].join('\n'),
      'src/lib.ts': 'export function helper() {}\nexport function parse() {}\n',
      'other/a.ts': 'export function helper() {}\n',
      'other/b.ts': 'export function helper() {}\n',
    });
    // Clicked at line 4: the nearer of the two same-file definitions comes first.
    expect(index.definitions('parse', { path: 'src/app.ts', line: 4 })).toEqual([
      { path: 'src/app.ts', line: 4, kind: 'function', rank: 'same_file' },
      { path: 'src/app.ts', line: 2, kind: 'function', rank: 'same_file' },
      { path: 'src/lib.ts', line: 2, kind: 'function', rank: 'import' },
    ]);
    // The import wins over identical names elsewhere, which still come back, by path.
    expect(index.definitions('helper', { path: 'src/app.ts', line: 3 })).toEqual([
      { path: 'src/lib.ts', line: 1, kind: 'function', rank: 'import' },
      { path: 'other/a.ts', line: 1, kind: 'function', rank: 'repo' },
      { path: 'other/b.ts', line: 1, kind: 'function', rank: 'repo' },
    ]);
    // Without a file to start from, it's every definition by path.
    expect(index.definitions('helper').map((c) => c.path)).toEqual([
      'other/a.ts',
      'other/b.ts',
      'src/lib.ts',
    ]);
    expect(index.definitions('nothing')).toEqual([]);
    // A limit keeps the best and says there were more.
    expect(index.limited('helper', 2)).toEqual({
      candidates: [at('other/a.ts', 1), at('other/b.ts', 1)],
      truncated: true,
    });
    expect(index.limited('helper', 3).truncated).toBe(false);
  });
});

describe('following imports', () => {
  test('N3: re-exports, renames, export * and namespace imports lead to the definition', async () => {
    const index = await indexOf({
      'src/app.ts': [
        "import { Button as B, Link } from './ui';",
        "import * as icons from './icons';",
        "import { Card } from './ui';",
      ].join('\n'),
      'src/ui/index.ts': [
        "export { Button } from './button';",
        "export * from './link';",
        "import { Card as Inner } from './card';",
        'export { Inner as Card };',
      ].join('\n'),
      'src/ui/button.ts': 'export class Button {}\n',
      'src/ui/link.ts': '\nexport function Link() {}\n',
      'src/ui/card.ts': '\n\nexport const Card = 1;\n',
      'src/icons.ts': 'export const star = 1;\n',
      'elsewhere/button.ts': 'export class Button {}\n',
    });
    const from = { path: 'src/app.ts' };
    expect(index.definitions('B', from)).toEqual([at('src/ui/button.ts', 1)]);
    expect(index.definitions('Link', from)).toEqual([
      { path: 'src/ui/link.ts', line: 2, kind: 'function', rank: 'import' },
    ]);
    expect(index.definitions('Card', from)).toEqual([at('src/ui/card.ts', 3)]);
    expect(index.definitions('icons', from)).toEqual([
      { path: 'src/icons.ts', line: 1, kind: 'module', rank: 'import' },
    ]);
  });

  test('N3: default exports, named, anonymous and re-exported', async () => {
    const index = await indexOf({
      'main.js': [
        "import Named from './named.js';",
        "import Anon from './anon.js';",
        "import Value from './value.js';",
        "import { default as Again } from './again.js';",
      ].join('\n'),
      'named.js': '// a comment\nexport default class Widget {}\n',
      'anon.js': '\n\nexport default function () {}\n',
      'value.js': 'const config = { a: 1 };\nexport default config;\n',
      'again.js': "export { default } from './named.js';\n",
    });
    const from = { path: 'main.js' };
    expect(index.definitions('Named', from)).toEqual([
      { path: 'named.js', line: 2, kind: 'class', rank: 'import' },
    ]);
    expect(index.definitions('Anon', from)).toEqual([
      { path: 'anon.js', line: 3, kind: 'export', rank: 'import' },
    ]);
    expect(index.definitions('Value', from)).toEqual([
      { path: 'value.js', line: 1, kind: 'constant', rank: 'import' },
    ]);
    expect(index.definitions('Again', from)).toEqual([at('named.js', 2)]);
  });

  test('N3: a nested or unexported name never stands in for the export', async () => {
    const index = await indexOf({
      'app.ts': [
        "import { foo, parse } from './barrel';",
        "import * as u from './u';",
        'u.helper();',
      ].join('\n'),
      // A method named foo, and a nested parse, above the real ones.
      'barrel.ts': [
        'class Helper { foo() {} }',
        "export * from './real';",
        'function outer() { function parse() {} }',
        "export { parse } from './real';",
      ].join('\n'),
      'real.ts': 'export function foo() {}\nexport function parse() {}\n',
      'u.ts': "export * from './v';\n",
      'v.ts': 'export function helper() {}\n',
    });
    const from = { path: 'app.ts' };
    // The export comes first; the method in the imported barrel still follows, as an import.
    expect(index.definitions('foo', from)).toEqual([
      { path: 'real.ts', line: 1, kind: 'function', rank: 'import' },
      { path: 'barrel.ts', line: 1, kind: 'method', rank: 'import' },
    ]);
    expect(index.definitions('parse', from)).toEqual([
      { path: 'real.ts', line: 2, kind: 'function', rank: 'import' },
      { path: 'barrel.ts', line: 3, kind: 'function', rank: 'import' },
    ]);
    expect(index.definitions('helper', from)).toEqual([
      { path: 'v.ts', line: 1, kind: 'function', rank: 'import' },
    ]);
  });

  test('N2: a file built to fan out stops at a work budget, marked truncated', async () => {
    // Found by the security review: thousands of `import * as` of a barrel of `export *`.
    const leaves = Array.from({ length: 2_500 }, (_, i) => `l${i}`);
    const files: Record<string, string> = {
      'x.ts': `${Array.from({ length: 3_000 }, (_, i) => `import * as a${i} from './h';`).join('\n')}\n`,
      'h.ts': leaves.map((l) => `export * from './${l}';`).join('\n'),
      'z.ts': 'export function foo() {}\n',
    };
    for (const leaf of leaves) files[`${leaf}.ts`] = '';
    const index = await indexOf(files);
    const started = performance.now();
    const found = index.limited('foo', 50, { path: 'x.ts' });
    expect(performance.now() - started).toBeLessThan(500);
    // Nothing the budget couldn't reach is lost from the repo-wide pass.
    expect(found).toEqual({ candidates: [at('z.ts', 1)], truncated: true });
  });

  test('N3: an export cycle ends instead of looping', async () => {
    const index = await indexOf({
      'a.ts': "export * from './b';\nimport { x } from './b';\n",
      'b.ts': "export * from './a';\n",
    });
    expect(index.definitions('x', { path: 'a.ts' })).toEqual([]);
  });
});

describe('resolving imports', () => {
  test('N4: relative specifiers, extensions, .js for .ts, index files and tsconfig paths', async () => {
    const index = await indexOf({
      'tsconfig.json': `{
        // comments and trailing commas, as tsconfig allows
        "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], "~lib": ["src/lib/index.ts"], }, },
      }`,
      'src/app.ts': '',
      'src/util.ts': '',
      'src/lib/index.ts': '',
      'src/styles.css': '',
      'src/view.tsx': '',
    });
    const resolve = (spec: string) => index.resolveImport('src/app.ts', spec);
    expect(resolve('./util')).toBe('src/util.ts');
    expect(resolve('./util.js')).toBe('src/util.ts');
    expect(resolve('./view.js')).toBe('src/view.tsx');
    expect(resolve('./lib')).toBe('src/lib/index.ts');
    expect(resolve('../src/styles.css')).toBe('src/styles.css');
    expect(resolve('@/util')).toBe('src/util.ts');
    expect(resolve('~lib')).toBe('src/lib/index.ts');
  });

  test('N4: a hostile tsconfig is capped, and .js names the .ts file when both exist', async () => {
    const targets = Array.from({ length: 20_000 }, (_, i) => `nowhere${i}/*`);
    const imports = Array.from({ length: 300 }, (_, i) => `import { x${i} } from 'pkg${i}';`);
    const index = await indexOf({
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '*': targets } } }),
      'app.ts': imports.join('\n'),
      'b.js': '',
      'b.ts': '',
    });
    const started = performance.now();
    for (let i = 0; i < 5; i++) index.definitions('x1', { path: 'app.ts' });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(index.resolveImport('app.ts', './b.js')).toBe('b.ts');
  });

  test('N4: packages, missing files and paths out of the repo stay unresolved', async () => {
    const index = await indexOf({ 'src/app.ts': '', 'secret.ts': '' });
    const resolve = (spec: string) => index.resolveImport('src/app.ts', spec);
    expect(resolve('react')).toBeNull();
    expect(resolve('./missing')).toBeNull();
    expect(resolve('../../secret')).toBeNull();
    expect(resolve('/etc/passwd')).toBeNull();
    expect(resolve('../secret')).toBe('secret.ts');
  });
});
