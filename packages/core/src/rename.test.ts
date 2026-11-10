import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { type Change, changes } from './changes.testing.ts';
import type { Proof } from './proof.ts';
import { proveRenames, type RenameOccurrences, renameLookups } from './rename.ts';

const lines = (...text: string[]) => `${text.join('\n')}\n`;

/** Proves renames, answering the repository lookups with `found` (default: nowhere else). */
function rename(
  list: readonly Change[],
  found: { base?: Record<string, string[]>; head?: Record<string, string[]> } = {},
): Proof[] {
  const { diff, texts } = changes(list);
  const asks = renameLookups(diff, texts);
  const occurrences: RenameOccurrences = {
    base: new Map(asks.atBase.map((name) => [name, found.base?.[name] ?? []])),
    head: new Map(asks.atHead.map((name) => [name, found.head?.[name] ?? []])),
  };
  return proveRenames(diff, texts, occurrences);
}

const renamed = (proofs: readonly Proof[]) =>
  proofs.map((p) => (p.evidence.label === 'rename' ? p.evidence.changes : []));

const users = (name: string, id = 'id') =>
  lines('// Users.', `export function ${name}(${id}) {`, `  return db.find(${id});`, '}');
const caller = (name: string, arg = '1', op = '===') =>
  lines(
    `import { ${name} } from './users.ts';`,
    '',
    `const user = ${name}(${arg});`,
    `if (user ${op} null) throw new Error();`,
  );

describe('P9: renames', () => {
  test('P9: a sweeping rename across files is proven, with its mapping', () => {
    const proofs = rename([
      { path: 'src/users.ts', before: users('getUser'), after: users('fetchUser') },
      { path: 'src/main.ts', before: caller('getUser'), after: caller('fetchUser') },
    ]);
    expect(renamed(proofs)).toEqual([
      [{ kind: 'identifier', from: 'getUser', to: 'fetchUser' }],
      [{ kind: 'identifier', from: 'getUser', to: 'fetchUser' }],
    ]);
  });

  test('P9: the lookups ask for the new names at base and the old ones at head', () => {
    const { diff, texts } = changes([
      { path: 'src/users.ts', before: users('getUser'), after: users('fetchUser') },
    ]);
    expect(renameLookups(diff, texts)).toEqual({ atBase: ['fetchUser'], atHead: ['getUser'] });
  });

  test('P9: a rename hunk that also changes a literal or an operator is not proven', () => {
    const literal = rename([
      { path: 'src/users.ts', before: users('getUser'), after: users('fetchUser') },
      { path: 'src/main.ts', before: caller('getUser'), after: caller('fetchUser', '2') },
    ]);
    const operator = rename([
      { path: 'src/users.ts', before: users('getUser'), after: users('fetchUser') },
      { path: 'src/main.ts', before: caller('getUser'), after: caller('fetchUser', '1', '!==') },
    ]);
    // The definition's own hunk is still a clean rename; the caller's hunk is not.
    for (const proofs of [literal, operator]) {
      expect(proofs.map((p) => p.target.kind === 'hunk' && p.target.hunk.split('#')[0])).toEqual([
        'src/users.ts',
      ]);
    }
  });

  test('P9: string contents never map, even when they look like names', () => {
    expect(
      rename([
        {
          path: 'a.ts',
          before: lines('const role = getRole();', "if (role === 'admin') grant();"),
          after: lines('const role = getRole();', "if (role === 'guest') grant();"),
        },
      ]),
    ).toEqual([]);
  });

  test('P9: a name defined outside the repo, or a property, is never renamed', () => {
    const builtin = rename([
      { path: 'a.ts', before: lines('x = Math.min(a, b);'), after: lines('x = Math.max(a, b);') },
    ]);
    const imported = rename([
      {
        path: 'a.ts',
        before: lines("import { min } from 'lodash';", 'x = min(a, b);'),
        after: lines("import { max } from 'lodash';", 'x = max(a, b);'),
      },
    ]);
    // Defined here, but also a property of outside data.
    const property = rename([
      {
        path: 'a.ts',
        before: lines('const isBanned = (u) => u.isBanned;', 'if (!isBanned(user)) allow();'),
        after: lines('const isBlocked = (u) => u.isBlocked;', 'if (!isBlocked(user)) allow();'),
      },
    ]);
    const shorthand = rename([
      {
        path: 'a.ts',
        before: lines('const banned = load();', 'send({ banned });'),
        after: lines('const blocked = load();', 'send({ blocked });'),
      },
    ]);
    expect([...builtin, ...imported, ...property, ...shorthand]).toEqual([]);
  });

  test('P9: a regex body is never read as code', () => {
    const file = (name: string) =>
      lines(
        `function ${name}() { return 1; }`,
        `export const ok = (s) => /^${name}$/.test(s) && ${name}();`,
      );
    expect(rename([{ path: 'a.ts', before: file('admin'), after: file('guest') }])).toEqual([]);
  });

  test('P9: a rename in one file never licenses renaming a global or a package export elsewhere', () => {
    const util = (name: string) =>
      lines('// helpers', `export function ${name}(o) {`, '  return o;', '}');
    const fromPackage = rename([
      { path: 'util.ts', before: util('pick'), after: util('omit') },
      {
        path: 'b.ts',
        before: lines("import { pick } from 'lodash';", '', 'export const x = pick(user, keys);'),
        after: lines("import { omit } from 'lodash';", '', 'export const x = omit(user, keys);'),
      },
    ]);
    const python = rename([
      {
        path: 'util.py',
        before: lines('# helpers', 'def md5(x):', '    return x'),
        after: lines('# helpers', 'def sha1(x):', '    return x'),
      },
      {
        path: 'b.py',
        before: lines('from hashlib import md5', '', 'h = md5(data)'),
        after: lines('from hashlib import sha1', '', 'h = sha1(data)'),
      },
    ]);
    const global = rename([
      {
        path: 'a.ts',
        before: lines('// a', 'function fetch() { return 1; }', 'export default fetch;'),
        after: lines('// a', 'function steal() { return 1; }', 'export default steal;'),
      },
      {
        path: 'b.js',
        before: lines('// b', 'export const r = fetch(url);', '// end'),
        after: lines('// b', 'export const r = steal(url);', '// end'),
      },
    ]);
    expect([...fromPackage, ...python, ...global]).toEqual([]);
  });

  test('P9: keyword arguments, destructuring defaults, JSX attributes and methods are keys', () => {
    const destructure = rename([
      {
        path: 'a.ts',
        before: lines('// a', 'export function limit() {', '  return 1;', '}'),
        after: lines('// a', 'export function quota() {', '  return 1;', '}'),
      },
      {
        path: 'b.ts',
        before: lines(
          "import { limit } from './a.ts';",
          'export function f(opts) {',
          '  const { limit = 10 } = opts;',
          '  return limit;',
          '}',
        ),
        after: lines(
          "import { quota } from './a.ts';",
          'export function f(opts) {',
          '  const { quota = 10 } = opts;',
          '  return quota;',
          '}',
        ),
      },
    ]);
    const kwarg = rename([
      {
        path: 'a.py',
        before: lines(
          '# a',
          'def timeout():',
          '    return 5',
          '',
          'requests.get(url, timeout=timeout())',
        ),
        after: lines(
          '# a',
          'def deadline():',
          '    return 5',
          '',
          'requests.get(url, deadline=deadline())',
        ),
      },
    ]);
    const jsx = rename([
      {
        path: 'a.tsx',
        before: lines(
          '// a',
          'function disabled() { return true; }',
          'export const B = () => <button disabled={disabled()} />;',
        ),
        after: lines(
          '// a',
          'function hidden() { return true; }',
          'export const B = () => <button hidden={hidden()} />;',
        ),
      },
    ]);
    const method = rename([
      {
        path: 'a.ts',
        before: lines(
          '// a',
          'function toJSON() { return 1; }',
          'export const o = { toJSON() { return toJSON(); } };',
        ),
        after: lines(
          '// a',
          'function toJson() { return 1; }',
          'export const o = { toJson() { return toJson(); } };',
        ),
      },
    ]);
    expect([...destructure, ...kwarg, ...jsx, ...method]).toEqual([]);
  });

  test('P9: a rename through a relative re-export chain is proven', () => {
    const util = (name: string) =>
      lines('// helpers', `export function ${name}(o) {`, '  return o;', '}');
    const proofs = rename([
      { path: 'src/util.ts', before: util('pick'), after: util('choose') },
      {
        path: 'src/index.ts',
        before: lines("export { pick } from './util.ts';"),
        after: lines("export { choose } from './util.ts';"),
      },
      {
        path: 'app.ts',
        before: lines("import { pick } from './src/index.ts';", 'export const r = pick(o);'),
        after: lines("import { choose } from './src/index.ts';", 'export const r = choose(o);'),
      },
    ]);
    expect(proofs).toHaveLength(3);
  });

  test('P9: keywords and built-in values never map', () => {
    expect(
      rename([{ path: 'a.ts', before: lines('let ok = true;'), after: lines('let ok = false;') }]),
    ).toEqual([]);
  });

  test('P9: a new name that already exists, or an old name still in use, is not a rename', () => {
    const both = [
      { path: 'src/users.ts', before: users('getUser'), after: users('fetchUser') },
      { path: 'src/main.ts', before: caller('getUser'), after: caller('fetchUser') },
    ];
    expect(rename(both, { base: { fetchUser: ['src/legacy.ts'] } })).toEqual([]);
    expect(rename(both, { head: { getUser: ['src/other.ts'] } })).toEqual([]);
  });

  test('P9: a swap is never a rename, whatever the lookups say', () => {
    const before = lines('function allow() {}', 'function deny() {}', 'check(allow);');
    const after = lines('function deny() {}', 'function allow() {}', 'check(deny);');
    expect(rename([{ path: 'a.ts', before, after }])).toEqual([]);
  });

  test('P9: merging two names into one is not a rename', () => {
    const before = lines('function a() {}', 'function b() {}', 'a(); b();');
    const after = lines('function c() {}', 'function c() {}', 'c(); c();');
    expect(rename([{ path: 'a.ts', before, after }])).toEqual([]);
  });

  test('P9: changing the case of the first letter is not a rename', () => {
    expect(
      rename([
        {
          path: 'a.go',
          before: lines('package a', 'func secret() string { return s }', 'var x = secret()'),
          after: lines('package a', 'func Secret() string { return s }', 'var x = Secret()'),
        },
      ]),
    ).toEqual([]);
  });

  test('P9: import paths follow a file move in the same diff, and nothing else', () => {
    const body = lines('export const x = 1;');
    const moved: Change = { path: 'src/lib/new.ts', from: 'src/old.ts', before: body, after: body };
    const importer = (path: string) => lines(`import { x } from '${path}';`, 'use(x);');
    const followed = rename([
      moved,
      { path: 'src/main.ts', before: importer('./old.ts'), after: importer('./lib/new.ts') },
    ]);
    expect(renamed(followed)).toEqual([
      [{ kind: 'import_path', from: './old.ts', to: './lib/new.ts' }],
    ]);
    const elsewhere = rename([
      moved,
      { path: 'src/main.ts', before: importer('./old.ts'), after: importer('./evil.ts') },
    ]);
    expect(elsewhere).toEqual([]);
  });

  test('P9: multi-line import lists may carry a rename', () => {
    const block = (name: string) =>
      lines('import {', `  ${name},`, '  other,', "} from './users.ts';", `const u = ${name}(1);`);
    const proofs = rename([
      { path: 'src/users.ts', before: users('getUser'), after: users('fetchUser') },
      { path: 'src/main.ts', before: block('getUser'), after: block('fetchUser') },
    ]);
    expect(proofs).toHaveLength(2);
  });

  test('P9: a whitespace-significant or unlisted language, or a multi-line string, is never a rename', () => {
    const yaml = rename([
      { path: 'a.yml', before: lines('role: admin'), after: lines('role: guest') },
    ]);
    const template = rename([
      {
        path: 'a.ts',
        before: lines('function f() {}', 'const q = `', 'admin', '`;'),
        after: lines('function g() {}', 'const q = `', 'admin', '`;'),
      },
    ]);
    expect([...yaml, ...template]).toEqual([]);
  });

  test('P9: a renamed word anywhere but a safe position is not proven', () => {
    const file = (name: string, use: string) =>
      lines(`function ${name}() { return 1; }`, use.replaceAll('NAME', name));
    const prove = (use: string) =>
      rename([{ path: 'a.ts', before: file('alpha', use), after: file('omega', use) }]).length;
    // Safe: after an operator, a few keywords, or inside call arguments.
    expect(prove('const x = NAME();')).toBe(1);
    expect(prove('export default NAME;')).toBe(1);
    expect(prove('run(a, NAME);')).toBe(1);
    // Unsafe: a statement start, a method, a class field, a key, a list in braces, a decorator.
    for (const use of [
      'NAME();',
      '  NAME(',
      '  NAME = () => 1;',
      'const o = { a, NAME };',
      'const o = { NAME: 1 };',
      '@NAME',
      'const o = { NAME() {} };',
    ]) {
      expect(prove(use)).toBe(0);
    }
  });

  test('P9: JSX, Python and Go files are never renames', () => {
    const tsx = rename([
      {
        path: 'a.tsx',
        before: lines('function admin() {}', 'const p = <p>(admin)</p>;'),
        after: lines('function guest() {}', 'const p = <p>(guest)</p>;'),
      },
    ]);
    const py = rename([
      {
        path: 'a.py',
        before: lines('def old_name(x):', '    return x', 'y = old_name(1)'),
        after: lines('def new_name(x):', '    return x', 'y = new_name(1)'),
      },
    ]);
    expect([...tsx, ...py]).toEqual([]);
  });

  test('P9: a nested or commented-out definition licenses nothing', () => {
    const nested = rename([
      {
        path: 'a.ts',
        before: lines(
          '// a',
          'function test() {',
          '  const setTimeout = (f) => f();',
          '  return setTimeout(run);',
          '}',
          'const t = setTimeout(poll, 1000);',
        ),
        after: lines(
          '// a',
          'function test() {',
          '  const queueMicrotask = (f) => f();',
          '  return queueMicrotask(run);',
          '}',
          'const t = queueMicrotask(poll, 1000);',
        ),
      },
    ]);
    const commented = rename([
      {
        path: 'a.ts',
        before: lines('/*', 'function setTimeout() {}', '*/', 'const t = setTimeout(poll, 1000);'),
        after: lines(
          '/*',
          'function queueMicrotask() {}',
          '*/',
          'const t = queueMicrotask(poll, 1000);',
        ),
      },
    ]);
    expect([...nested, ...commented]).toEqual([]);
  });

  test('P9: a comma in an object or destructuring opened on an earlier line is a key', () => {
    const prove = (before: string, after: string) => rename([{ path: 'a.ts', before, after }]);
    const keyed = prove(
      lines('export const limit = 10;', 'export const config = {', '  retries: 3, limit,', '};'),
      lines('export const quota = 10;', 'export const config = {', '  retries: 3, quota,', '};'),
    );
    const destructured = prove(
      lines(
        'export const limit = 10;',
        'export function f(opts) {',
        '  const {',
        '    retries, limit,',
        '  } = opts;',
        '  return [retries, limit];',
        '}',
      ),
      lines(
        'export const quota = 10;',
        'export function f(opts) {',
        '  const {',
        '    retries, quota,',
        '  } = opts;',
        '  return [retries, quota];',
        '}',
      ),
    );
    const method = prove(
      lines(
        'export function toJSON() { return 1; }',
        'export const o = {',
        '  a() {}, toJSON() { return 2; },',
        '};',
      ),
      lines(
        'export function toJson() { return 1; }',
        'export const o = {',
        '  a() {}, toJson() { return 2; },',
        '};',
      ),
    );
    expect([...keyed, ...destructured, ...method]).toEqual([]);
  });

  test('P9: only a real top-level definition licenses a rename: not column 0 in a body, not declare', () => {
    const unindented = rename([
      {
        path: 'a.ts',
        before: lines(
          'export function test() {',
          'const setTimeout = (f) => f();',
          'return setTimeout(run);',
          '}',
          'export const t = () => setTimeout(poll, 1000);',
        ),
        after: lines(
          'export function test() {',
          'const queueMicrotask = (f) => f();',
          'return queueMicrotask(run);',
          '}',
          'export const t = () => queueMicrotask(poll, 1000);',
        ),
      },
    ]);
    const declared = rename([
      {
        path: 'a.ts',
        before: lines(
          'declare const setTimeout: (f: () => void, ms: number) => void;',
          '',
          'export const start = () => setTimeout(poll, 1000);',
        ),
        after: lines(
          'declare const queueMicrotask: (f: () => void, ms: number) => void;',
          '',
          'export const start = () => queueMicrotask(poll, 1000);',
        ),
      },
    ]);
    const withStatement = rename([
      {
        path: 'a.js',
        before: lines(
          'function limit() { return 1; }',
          'function f(opts) {',
          '  with (opts) {',
          '    return (limit);',
          '  }',
          '}',
        ),
        after: lines(
          'function quota() { return 1; }',
          'function f(opts) {',
          '  with (opts) {',
          '    return (quota);',
          '  }',
          '}',
        ),
      },
    ]);
    expect([...unindented, ...declared, ...withStatement]).toEqual([]);
  });

  test('P9: a /* inside a line comment or a string never hides brackets from the depth count', () => {
    const body = (name: string) => [
      'export function test() {',
      `const ${name} = (f) => f();`,
      `return ${name}(run);`,
    ];
    const inLineComments = (name: string) =>
      lines(
        '// /*',
        ...body(name).slice(0, 1),
        '// */',
        ...body(name).slice(1),
        '// /*',
        '}',
        '// */',
        `export const t = () => ${name}(poll, 1000);`,
      );
    const inStrings = (name: string) =>
      lines(
        'const s = "/*"; export function test() { const u = "*/";',
        `const ${name} = (f) => f();`,
        `const r = ${name}(run);`,
        'const v = "/*"; } const w = "*/";',
        `export const t = () => ${name}(poll, 1000);`,
      );
    // Annex B: in script code, `<!--` starts a line comment too.
    const inHtmlComments = (name: string) =>
      lines(
        'function test() {',
        '<!-- }',
        `const ${name} = (f) => f();`,
        `return ${name}(run);`,
        '}',
        '<!-- {',
        `module.exports = () => ${name}(poll, 1000);`,
      );
    // JS ends a line at a lone \r, U+2028 or U+2029; git doesn't.
    const separated = (separator: string) => (name: string) =>
      lines(
        `// setup${separator}export function test() {`,
        `const ${name} = (f) => f();`,
        `return ${name}(run);`,
        `// end${separator}}`,
        `export const t = () => ${name}(poll, 1000);`,
      );
    for (const [path, file] of [
      ['a.ts', inLineComments],
      ['a.ts', inStrings],
      ['a.cjs', inHtmlComments],
      ['a.ts', separated('\r')],
      ['a.ts', separated('\u2028')],
      ['a.ts', separated('\u2029')],
    ] as const) {
      const proofs = rename([{ path, before: file('setTimeout'), after: file('queueMicrotask') }]);
      expect(proofs).toEqual([]);
    }
  });

  test('P9: an aliased or commented import item, or a source with export *, licenses nothing', () => {
    const aliased = rename([
      {
        path: 'a.ts',
        before: lines(
          'import {',
          '  pick as p, // lodash',
          "} from 'lodash';",
          '',
          'function pick() { return p; }',
          'const x = pick();',
        ),
        after: lines(
          'import {',
          '  omit as p, // lodash',
          "} from 'lodash';",
          '',
          'function omit() { return p; }',
          'const x = omit();',
        ),
      },
    ]);
    const starred = rename([
      {
        path: 'util.ts',
        before: lines(
          "export * from 'lodash';",
          '',
          'function pick() { return 1; }',
          'const y = pick();',
        ),
        after: lines(
          "export * from 'lodash';",
          '',
          'function omit() { return 1; }',
          'const y = omit();',
        ),
      },
      {
        path: 'b.ts',
        before: lines("import { pick } from './util';", '', 'export const x = pick(o, k);'),
        after: lines("import { omit } from './util';", '', 'export const x = omit(o, k);'),
      },
    ]);
    expect([...aliased, ...starred]).toEqual([]);
  });

  test('P9: any single-token change to a proven rename un-proves that hunk', () => {
    const base = lines(
      'function getUser(id) {',
      '  return db.find(id, 1);',
      '}',
      'const u = getUser(2);',
    );
    const after = base.replaceAll('getUser', 'fetchUser');
    expect(rename([{ path: 'a.ts', before: base, after }])).toHaveLength(1);
    const positions = [...after.matchAll(/[a-z0-9(),;.]/gi)].map((m) => m.index);
    fc.assert(
      fc.property(
        fc.constantFrom(...positions),
        fc.constantFrom('x', '7', '+', '!'),
        (at, char) => {
          if (after[at] === char) return;
          const tampered = after.slice(0, at) + char + after.slice(at + 1);
          expect(rename([{ path: 'a.ts', before: base, after: tampered }])).toEqual([]);
        },
      ),
      { seed: 6, numRuns: 200 },
    );
  });
});
