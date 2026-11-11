// The benchmark's graders, checked against known-good and known-bad work, without a model.
// add-clamp's grader runs pnpm install and pnpm verify, so it is checked by hand instead
// (see the PR that added this file).

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { makeCopy, tasks } from './harness-bench.ts';

function grade(id: string, answer: string, files: Record<string, string> = {}): string[] {
  const task = tasks.find((t) => t.id === id);
  if (!task) throw new Error(`no task ${id}`);
  if (!task.writes) return task.grade('', answer);
  const copy = makeCopy('HEAD', false);
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(copy, path)), { recursive: true });
      writeFileSync(join(copy, path), text);
    }
    return task.grade(copy, answer);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

describe('answer graders', () => {
  test.each([
    ['find-core-boundary', '`biome.json`', 'packages/core/tsconfig.json'],
    ['find-pairing-check', 'scripts/check-agents-md.ts', 'scripts/check-context-loading.ts'],
    ['pr-tier', 'Tier 0', 'tier 2b'],
    ['pnpm-exec', '`pnpm exec tsc --version`', 'npx tsc --version'],
  ])('%s passes %j and fails %j', (id, good, bad) => {
    expect(grade(id, good)).toEqual([]);
    expect(grade(id, bad)).not.toEqual([]);
  });
});

describe('agent-notes grader', () => {
  const notes = { 'scripts/AGENTS.md': '# scripts\n\nScripts run directly with node.\n' };

  test('passes notes with their one-line CLAUDE.md', () => {
    expect(grade('agent-notes', '', { ...notes, 'scripts/CLAUDE.md': '@AGENTS.md\n' })).toEqual([]);
  });

  test('fails without the CLAUDE.md, or with changes outside the task', () => {
    expect(grade('agent-notes', '', notes)).toContain('check-agents-md fails');
    expect(
      grade('agent-notes', '', { ...notes, 'scripts/CLAUDE.md': '@AGENTS.md\n', 'README.md': 'x' }),
    ).toEqual(['changed files outside the task: README.md']);
  });
});
