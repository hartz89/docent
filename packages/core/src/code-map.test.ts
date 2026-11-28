import { describe, expect, test } from 'vitest';
import { changes } from './changes.testing.ts';
import { type CodeMap, codeMap, MAP_LIMITS, type MapLimits } from './code-map.ts';
import { symbolIndexOf } from './symbols.testing.ts';

/** The map of a PR that turns `before` into `after`. Files absent from `before` are new. */
async function mapOf(
  before: Record<string, string>,
  after: Record<string, string>,
  limits: MapLimits = MAP_LIMITS,
): Promise<CodeMap> {
  const changed = Object.keys(after).filter((path) => before[path] !== after[path]);
  const { diff } = changes(
    changed.map((path) => ({ path, before: before[path] ?? null, after: after[path] ?? null })),
  );
  return codeMap(await symbolIndexOf(after), diff, limits);
}

/** Each side as `path › name` (or just `path` for a file), and each link as `from → to`. */
function picture(map: CodeMap) {
  const nodes = new Map(
    [...map.changed, ...map.callers].flatMap((g) =>
      g.nodes.map((n) => [n.id, n.kind === 'file' ? n.path : `${n.path} › ${n.name}`] as const),
    ),
  );
  const side = (groups: CodeMap['changed']) =>
    groups.flatMap((g) => g.nodes.map((n) => nodes.get(n.id)));
  return {
    changed: side(map.changed),
    callers: side(map.callers),
    edges: map.edges.map((e) => `${nodes.get(e.from)} → ${nodes.get(e.to)}`).sort(),
  };
}

const pricing = (body: string) =>
  [
    "import type { Discount } from './types.ts';", // 1
    '', // 2
    'export function roundCents(value: number) {', // 3
    '  return Math.round(value);', // 4
    '}', // 5
    '', // 6
    'export function applyDiscount(total: number, discount: Discount) {', // 7
    body, // 8
    '}', // 9
    '', // 10
    'export function totalOf(items: number[]) {', // 11
    '  let sum = 0;', // 12
    '  for (const item of items) sum += item;', // 13
    '  return sum;', // 14
    '}', // 15
  ].join('\n');

describe('the changed side', () => {
  test('M1: top-level definitions with an added or removed line inside, in diff order', async () => {
    const before = {
      'src/a.ts': pricing('  return total;'),
      'src/types.ts': 'export type Discount = { percent: number };\n',
      'README.md': '# Shop\n',
    };
    const after = {
      ...before,
      'src/a.ts': pricing('  return total * (1 - discount.percent);').replace(
        '  let sum = 0;\n',
        '',
      ),
      'README.md': '# Shop, with discounts\n',
    };
    const map = await mapOf(before, after);
    // roundCents is untouched; totalOf only lost a line, between two of its own.
    expect(picture(map).changed).toEqual(['src/a.ts › applyDiscount', 'src/a.ts › totalOf']);
    expect(map.changed[0]?.nodes.map((n) => n.line)).toEqual([7, 11]);
    expect(map.otherFiles).toEqual(['README.md']);
  });

  test('M1: overloads are one definition; changes outside every definition put the file itself on the map', async () => {
    const before = {
      'src/area.ts': [
        'export function area(s: string): number;',
        'export function area(s: number): number;',
        'export function area(s: unknown): number {',
        '  return 0;',
        '}',
      ].join('\n'),
      'src/setup.ts': "import { area } from './area.ts';\nconsole.log(area(1));\n",
    };
    const after = {
      'src/area.ts': before['src/area.ts'].replace('return 0', 'return 1'),
      'src/setup.ts': "import { area } from './area.ts';\nconsole.log(area(2));\n",
    };
    const map = await mapOf(before, after);
    expect(map.changed).toEqual([
      { path: 'src/area.ts', nodes: [expect.objectContaining({ name: 'area', line: 1 })] },
      {
        path: 'src/setup.ts',
        nodes: [{ id: 'src/setup.ts', path: 'src/setup.ts', line: 2, kind: 'file' }],
      },
    ]);
  });
});

describe('the callers', () => {
  const before = {
    'src/pricing.ts': pricing('  return total;'),
    'src/types.ts': 'export type Discount = { percent: number };\n',
    'src/checkout.ts': [
      "import { applyDiscount, totalOf } from './pricing.ts';", // 1
      '', // 2
      'export function checkout(items: number[]) {', // 3
      '  return applyDiscount(totalOf(items), { percent: 0 });', // 4
      '}', // 5
      '', // 6
      'export const preview = (items: number[]) =>', // 7
      '  applyDiscount(totalOf(items), { percent: 0 });', // 8
    ].join('\n'),
    'src/script.ts':
      "import { applyDiscount } from './pricing.ts';\napplyDiscount(1, { percent: 0 });\n",
    'src/reexport.ts': "export { applyDiscount } from './pricing.ts';\n",
    'src/unused.ts': "import { applyDiscount } from './pricing.ts';\nexport function noop() {}\n",
    // A different applyDiscount, and a file that uses that one: not callers of the changed one.
    'src/legacy/discount.ts': 'export function applyDiscount(t: number) {\n  return t;\n}\n',
    'src/legacy/v1.ts':
      "import { applyDiscount } from './discount.ts';\nexport function v1(t: number) {\n  return applyDiscount(t);\n}\n",
    // Says the name in a comment and a string only.
    'src/notes.ts': "// applyDiscount\nexport const label = 'applyDiscount';\n",
  };
  const after = { ...before, 'src/pricing.ts': pricing('  return total * 0.9;') };

  test('M2: definitions that use the changed one, found through imports, never by name alone', async () => {
    const map = await mapOf(before, after);
    expect(picture(map)).toEqual({
      changed: ['src/pricing.ts › applyDiscount'],
      callers: ['src/checkout.ts › checkout', 'src/checkout.ts › preview', 'src/script.ts'],
      edges: [
        'src/checkout.ts › checkout → src/pricing.ts › applyDiscount',
        'src/checkout.ts › preview → src/pricing.ts › applyDiscount',
        'src/script.ts → src/pricing.ts › applyDiscount',
      ],
    });
    // Callers are grouped by file, and open where they're defined or first use it.
    expect(map.callers.map((g) => [g.path, g.nodes.map((n) => n.line)])).toEqual([
      ['src/checkout.ts', [3, 7]],
      ['src/script.ts', [2]],
    ]);
  });

  test('M2: a use in the same file counts, but the definition naming itself does not', async () => {
    const recursive = [
      'export function walk(n: number): number {',
      '  return n <= 0 ? 0 : walk(n - 1);',
      '}',
      'export function twice(n: number) {',
      '  return walk(n) + walk(n);',
      '}',
    ].join('\n');
    const map = await mapOf(
      { 'src/walk.ts': recursive },
      { 'src/walk.ts': recursive.replace('n <= 0', 'n < 1') },
    );
    expect(picture(map)).toEqual({
      changed: ['src/walk.ts › walk'],
      callers: ['src/walk.ts › twice'],
      edges: ['src/walk.ts › twice → src/walk.ts › walk'],
    });
    expect(map.edges[0]?.uses).toBe(1);
  });

  test('M3: a changed definition that uses another stays on the changed side', async () => {
    const map = await mapOf(before, {
      ...after,
      'src/types.ts': 'export type Discount = { percent: number; minimum: number };\n',
    });
    const { changed, callers, edges } = picture(map);
    expect(changed).toEqual(['src/pricing.ts › applyDiscount', 'src/types.ts › Discount']);
    expect(callers).not.toContain('src/pricing.ts › applyDiscount');
    expect(edges).toContain('src/pricing.ts › applyDiscount → src/types.ts › Discount');
  });
});

describe('the caps', () => {
  const names = Array.from({ length: 20 }, (_, i) => `f${String(i).padStart(2, '0')}`);
  const lib = (version: number) =>
    names.map((n) => `export function ${n}() {\n  return ${version};\n}`).join('\n');
  // u00 uses one changed function, u01 two, and so on: the busier, the higher it ranks.
  const users = Object.fromEntries(
    names.map((n, i) => [
      `src/users/u${String(i).padStart(2, '0')}.ts`,
      `import { ${names.slice(0, i + 1).join(', ')} } from '../lib.ts';\nexport function ${n.replace('f', 'use')}() {\n  ${names
        .slice(0, i + 1)
        .map((m) => `${m}();`)
        .join(' ')}\n}\n`,
    ]),
  );

  test('M4: at most 12 a side, the most connected callers first, the rest counted', async () => {
    const map = await mapOf({ 'src/lib.ts': lib(1), ...users }, { 'src/lib.ts': lib(2), ...users });
    const { changed, callers } = picture(map);
    expect(changed).toHaveLength(12);
    expect(changed[0]).toBe('src/lib.ts › f00');
    expect(callers).toHaveLength(12);
    // Each user calls as many of the 12 shown functions as it can; the busiest come first.
    expect(callers.slice(0, 3)).toEqual([
      'src/users/u11.ts › use11',
      'src/users/u12.ts › use12',
      'src/users/u13.ts › use13',
    ]);
    expect(map.hidden).toEqual({ changed: 8, callers: 8, otherFiles: 0 });
    // Every link joins two nodes on the map.
    const ids = new Set([...map.changed, ...map.callers].flatMap((g) => g.nodes.map((n) => n.id)));
    expect(map.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true);
    expect(map.truncated).toBe(false);
    // The same PR always gives the same map.
    expect(
      await mapOf({ 'src/lib.ts': lib(1), ...users }, { 'src/lib.ts': lib(2), ...users }),
    ).toEqual(map);
  });

  test('M4: callers are read from a capped number of files, and the map says when that cut any', async () => {
    const limits = { ...MAP_LIMITS, changed: 1, callers: 3, filesPerDefinition: 4 };
    const map = await mapOf(
      { 'src/lib.ts': lib(1), ...users },
      { 'src/lib.ts': lib(2), ...users },
      limits,
    );
    expect(picture(map).changed).toEqual(['src/lib.ts › f00']);
    expect(map.callers.flatMap((g) => g.nodes)).toHaveLength(3);
    expect(map.truncated).toBe(true);
  });

  test('M4: other changed files are listed up to their cap, and counted past it', async () => {
    const docs = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`docs/${i}.md`, `${i}\n`]),
    );
    const map = await mapOf({}, docs);
    expect(map.otherFiles).toHaveLength(8);
    expect(map.hidden.otherFiles).toBe(2);
    expect(map.changed).toEqual([]);
  });
});
