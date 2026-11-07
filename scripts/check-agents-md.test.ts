import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { checkAgentsMd } from './check-agents-md.ts';

const roots: string[] = [];

/** Writes a real file tree into a fresh temp dir and returns its path. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'check-agents-md-'));
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

const good = {
  'AGENTS.md': '# Repo\n',
  'CLAUDE.md': '@AGENTS.md\n\n## Claude Code specifics\n',
  'apps/server/AGENTS.md': '# server\n',
  'apps/server/CLAUDE.md': '@AGENTS.md\n',
  'e2e/AGENTS.md': '# e2e\n',
  'e2e/CLAUDE.md': '@AGENTS.md',
};

describe('checkAgentsMd', () => {
  test('passes a well-formed tree', () => {
    expect(checkAgentsMd(tree(good))).toEqual([]);
  });

  test('ignores node_modules, .git and other worktrees', () => {
    const root = tree({
      ...good,
      'node_modules/pkg/AGENTS.md': '# a dependency\n',
      '.git/CLAUDE.md': 'stray\n',
      '.claude/worktrees/other/apps/x/AGENTS.md': '# another worktree\n',
    });
    expect(checkAgentsMd(root)).toEqual([]);
  });

  test('flags an AGENTS.md with no CLAUDE.md beside it', () => {
    const root = tree({ ...good, 'apps/web/AGENTS.md': '# web\n' });
    expect(checkAgentsMd(root)).toEqual([
      'apps/web/AGENTS.md has no CLAUDE.md beside it. Add apps/web/CLAUDE.md containing exactly "@AGENTS.md".',
    ]);
  });

  test('flags a package CLAUDE.md that holds more than the import', () => {
    const root = tree({ ...good, 'apps/server/CLAUDE.md': '@AGENTS.md\n\nAlso, use tabs.\n' });
    expect(checkAgentsMd(root)).toEqual([
      'apps/server/CLAUDE.md must contain exactly "@AGENTS.md". Move anything else into apps/server/AGENTS.md.',
    ]);
  });

  test('flags a root CLAUDE.md that does not start with the import', () => {
    const root = tree({ ...good, 'CLAUDE.md': '# Notes\n@AGENTS.md\n' });
    expect(checkAgentsMd(root)).toEqual(['CLAUDE.md must start with a "@AGENTS.md" line.']);
  });

  test('flags a CLAUDE.md with no AGENTS.md beside it', () => {
    const root = tree({ ...good, 'packages/core/CLAUDE.md': '@AGENTS.md\n' });
    expect(checkAgentsMd(root)).toEqual([
      'packages/core/CLAUDE.md has no AGENTS.md beside it. Put the notes in packages/core/AGENTS.md and make packages/core/CLAUDE.md contain exactly "@AGENTS.md".',
    ]);
  });
});
