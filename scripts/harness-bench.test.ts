// The benchmark's graders, checked against known-good and known-bad work, without a model.
// add-clamp's grader runs pnpm install and pnpm verify, so it is checked by hand instead
// (see the PR that added this file).

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { makeCopy, tasks } from './harness-bench.ts';

function grade(id: string, answer: string, files: Record<string, string> = {}): string[] {
  const task = tasks.find((t) => t.id === id);
  if (!task) throw new Error(`no task ${id}`);
  if (!task.writes) return task.grade({ dir: '', before: new Map() }, answer);
  const copy = makeCopy('HEAD', false);
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(copy.dir, path)), { recursive: true });
      writeFileSync(join(copy.dir, path), text);
    }
    return task.grade(copy, answer);
  } finally {
    rmSync(copy.dir, { recursive: true, force: true });
  }
}

describe('answer graders', () => {
  test.each([
    ['find-core-boundary', '`biome.json`', 'packages/core/biome.json'],
    ['find-core-boundary', './biome.json.', 'biome.json and tsconfig.json'],
    ['find-pairing-check', 'scripts/check-agents-md.ts', 'scripts/check-context-loading.ts'],
    ['pr-tier', 'Tier 0', 'tier 0 or 1'],
    ['pnpm-exec', '```bash\npnpm exec tsc --version\n```', 'npx tsc --version'],
    ['pnpm-exec', '`pnpm exec tsc -v`', 'pnpm exec tsc --version && rm -rf dist'],
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

  test('sees changes even when the session commits them', () => {
    const copy = makeCopy('HEAD', false);
    try {
      writeFileSync(join(copy.dir, 'README.md'), 'x');
      const task = tasks.find((t) => t.id === 'agent-notes');
      // Hide the change from git: commit it.
      const git = ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qam', 'hide'];
      expect(spawnSync('git', git, { cwd: copy.dir }).status).toBe(0);
      expect(task?.grade(copy, '')).toEqual(['changed files outside the task: README.md']);
    } finally {
      rmSync(copy.dir, { recursive: true, force: true });
    }
  });
});
