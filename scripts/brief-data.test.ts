import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { type Api, gather, ghArgs, parseTier } from './brief-data.ts';

// Real GitHub responses for hartz89/docent, recorded (and trimmed to the fields the script
// reads) with: node scripts/brief-data.ts --since 2026-11-10T00:00:00Z --record <dir>
const fixtures = join(import.meta.dirname, 'fixtures', 'brief-data');
// The recording's own window is in its since= and created= values. Those filters are applied
// again in gather, so a narrower test window can reuse the same responses.
const unwindowed = (path: string) => path.replace(/(since|created)=[^&]*/g, '$1=*');
const index = new Map(
  Object.entries(
    JSON.parse(readFileSync(join(fixtures, 'index.json'), 'utf8')) as Record<string, string>,
  ).map(([path, file]) => [unwindowed(path), file]),
);
const SINCE = '2026-11-10T00:00:00.000Z';
const UNTIL = '2026-11-11T04:02:23.674Z';

/** Serves recorded responses. `edit` can change one before it's returned. */
function recorded(edit?: (path: string, value: unknown) => unknown): Api & { calls: string[] } {
  const calls: string[] = [];
  const api = async (path: string) => {
    calls.push(path);
    const file = index.get(unwindowed(path));
    if (!file) throw new Error(`no fixture for ${path}`);
    const value: unknown = JSON.parse(readFileSync(join(fixtures, file), 'utf8'));
    return edit ? edit(path, value) : value;
  };
  return Object.assign(api, { calls });
}

const window = { since: SINCE, until: UNTIL, sinceSource: 'flag' as const };

describe('gather', () => {
  test('summarizes a busy day: merged PRs, the revert, the ledger, and a due brief', async () => {
    const data = await gather(recorded(), window);

    expect(data.merged.map((pr) => pr.number)).toEqual([
      26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 19, 42, 43, 40,
    ]);
    const skipEngine = data.merged.find((pr) => pr.number === 42);
    expect(skipEngine).toMatchObject({
      url: 'https://github.com/hartz89/docent/pull/42',
      tier: '1',
      additions: 3022,
      deletions: 17,
    });
    expect(data.merged.find((pr) => pr.number === 19)?.tier).toBe('2b');
    expect(data.merged.find((pr) => pr.number === 43)?.outcome).toBe('give Docent a light theme.');

    expect(data.change).toEqual({
      mergedPrs: 17,
      changedLines: 6717,
      score: 17 + 13,
      threshold: 10,
      due: true,
    });

    expect(data.escapes).toEqual([
      {
        kind: 'revert',
        by: {
          number: 31,
          url: 'https://github.com/hartz89/docent/pull/31',
          title: 'Revert line wrapping (#29, #30)',
        },
        repairs: [
          { number: 29, url: 'https://github.com/hartz89/docent/pull/29', tier: '1' },
          { number: 30, url: 'https://github.com/hartz89/docent/pull/30', tier: '1' },
        ],
      },
    ]);
    expect(data.ledger).toEqual({
      '0': { merged: 7, escapes: 0 },
      '1': { merged: 8, escapes: 2 },
      '2b': { merged: 2, escapes: 0 },
    });

    expect(data.escalations).toMatchObject({ limit: 2, waiting: [], queued: [], overLimit: false });
    expect(data.inProgress.map((pr) => pr.number)).toEqual([
      18, 21, 39, 41, 44, 45, 46, 47, 48, 49, 51,
    ]);
    expect(data.inProgress.find((pr) => pr.number === 44)?.maintainerNotes[0]?.heading).toBe(
      'Maintainer: two one-time steps',
    );

    expect(data.newBacklogIssues).toEqual([]);
    expect(data.mainCiFailures).toEqual([]);
    expect(data.openDecisions.map((d) => d.title)).toEqual(['npm scope for publishing']);
  });

  test('a quiet stretch is not due', async () => {
    const data = await gather(recorded(), { ...window, since: '2026-11-11T03:00:00.000Z' });
    expect(data.merged.map((pr) => pr.number)).toEqual([40]);
    expect(data.change).toMatchObject({ mergedPrs: 1, changedLines: 1017, score: 3, due: false });
    expect(data.escapes).toEqual([]);
  });

  test('shows the escalation queue, and flags more than two waiting', async () => {
    const labels: Record<number, string[]> = {
      44: ['needs-maintainer'],
      45: ['needs-maintainer'],
      46: ['needs-maintainer'],
      48: ['escalation-queued'],
    };
    const api = recorded((path, value) =>
      path.includes('state=open')
        ? (value as { number: number }[]).map((pr) => ({
            ...pr,
            labels: (labels[pr.number] ?? []).map((name) => ({ name })),
          }))
        : value,
    );
    const { escalations, inProgress } = await gather(api, window);

    expect(escalations.waiting.map((pr) => pr.number)).toEqual([44, 45, 46]);
    expect(escalations.queued.map((pr) => pr.number)).toEqual([48]);
    expect(escalations.overLimit).toBe(true);
    expect(inProgress.map((pr) => pr.number)).toEqual([18, 21, 39, 41, 47, 49, 51]);
  });

  test('counts fixes that say what they repair, even when the number is not a PR', async () => {
    const api = recorded((path, value) => {
      const pr = value as { body?: string; labels?: { name: string }[] };
      if (path.endsWith('/pulls/43'))
        return { ...pr, body: `${pr.body}\n\nRepairs #42\nRepairs #9999` };
      if (path.endsWith('/pulls/38')) return { ...pr, labels: [{ name: 'escape' }] };
      return value;
    });
    const { escapes, ledger } = await gather(api, window);

    expect(escapes.find((e) => e.by.number === 43)).toEqual({
      kind: 'fix',
      by: {
        number: 43,
        url: 'https://github.com/hartz89/docent/pull/43',
        title: expect.any(String),
      },
      repairs: [
        { number: 42, url: 'https://github.com/hartz89/docent/pull/42', tier: '1' },
        { number: 9999, url: 'https://github.com/hartz89/docent/pull/9999', tier: null },
      ],
    });
    expect(escapes.find((e) => e.by.number === 38)?.repairs).toEqual([]);
    expect(ledger).toMatchObject({
      '1': { merged: 8, escapes: 3 },
      unstated: { merged: 0, escapes: 1 },
      unattributed: { merged: 0, escapes: 1 },
    });
  });

  test('a failure on main that a later run fixed is not a red main', async () => {
    const run = (name: string, conclusion: string, at: string) => ({
      name,
      conclusion,
      created_at: at,
      html_url: `https://github.com/hartz89/docent/actions/runs/${at}`,
      display_title: 'x',
      head_sha: 'abcdef123',
    });
    const api = recorded((path, value) =>
      path.includes('actions/runs')
        ? {
            workflow_runs: [
              run('CI', 'success', '2026-11-10T12:00:00Z'),
              run('CI', 'failure', '2026-11-10T11:00:00Z'),
              run('Nightly', 'failure', '2026-11-10T13:00:00Z'),
            ],
          }
        : value,
    );
    const { mainCiFailures } = await gather(api, window);
    expect(mainCiFailures.map((r) => [r.name, r.stillFailing])).toEqual([
      ['Nightly', true],
      ['CI', false],
    ]);
  });

  test('only reads: plain GET paths, never a method or a body', async () => {
    const api = recorded();
    await gather(api, window);
    expect(api.calls.length).toBeGreaterThan(0);
    for (const path of api.calls) {
      expect(ghArgs(path)).toEqual(['api', path]);
      expect(path).toMatch(/^repos\/hartz89\/docent\/[^\s]+$/);
    }
  });
});

describe('parseTier', () => {
  test.each([
    ['## Tier\n\n**2b.** It touches the server.', '2b'],
    ['**Tier: 1.** Feature work inside one package.', '1'],
    ['**Tier:** 2a. A shared contract.', '2a'],
    ['## Tier: 2b\n\nThe floor says 2a.', '2b'],
    ['## Intent\n\nNo tier stated. Wiring is a later tier 2b PR.', null],
  ])('%j → %s', (body, tier) => {
    expect(parseTier(body)).toBe(tier);
  });
});

describe('--mark', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('records the last brief in the git common dir', () => {
    const repo = mkdtempSync(join(tmpdir(), 'brief-data-'));
    dirs.push(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync(
      process.execPath,
      [
        join(import.meta.dirname, 'brief-data.ts'),
        '--mark',
        UNTIL,
        '--url',
        'https://claude.ai/artifact/x',
      ],
      { cwd: repo, stdio: 'pipe' },
    );
    const saved = JSON.parse(readFileSync(join(repo, '.git', 'docent', 'last-brief.json'), 'utf8'));
    expect(saved).toEqual({ at: UNTIL, url: 'https://claude.ai/artifact/x' });
  });
});
