import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { measureFootprint } from './check-context-footprint.ts';

const roots: string[] = [];

/** Writes a real file tree into a fresh temp dir and returns its path. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'check-context-footprint-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('measureFootprint', () => {
  test('counts CLAUDE.md and what it imports, nested, once each', () => {
    const root = tree({
      'CLAUDE.md': '@AGENTS.md\n\nAlso see @docs/rules.md\n', // 36 chars -> 9
      'AGENTS.md': 'Core rules. @docs/rules.md\n', // 27 chars -> 7
      'docs/rules.md': 'See @../AGENTS.md\n', // a cycle back; 18 chars -> 5
    });
    expect(measureFootprint(root)).toEqual({
      files: [
        { path: 'CLAUDE.md', tokens: 9 },
        { path: 'AGENTS.md', tokens: 7 },
        { path: 'docs/rules.md', tokens: 5 },
      ],
      total: 21,
    });
  });

  test('ignores @ in code, emails, missing files and paths outside the repo', () => {
    const root = tree({
      'CLAUDE.md': [
        'Mail me@example.com. Use `@docs/a.md` here.',
        '```',
        '@docs/b.md',
        '```',
        '@missing.md @~/notes.md @../outside.md',
      ].join('\n'),
      'docs/a.md': 'a',
      'docs/b.md': 'b',
    });
    expect(measureFootprint(root).files.map((f) => f.path)).toEqual(['CLAUDE.md']);
  });
});
