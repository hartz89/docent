import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test, vi } from 'vitest';
import { runsCommand } from './runs.ts';

vi.setConfig({ testTimeout: 30_000 });

// A recorded run of a real-looking review: a retried tour, two questions (one the author's
// session answered, one that fell back to the guide), errors from both sides, and a posted review.
const data = fileURLToPath(new URL('testdata', import.meta.url));
const runs = join(data, 'runs');
const cli = fileURLToPath(new URL('cli.ts', import.meta.url));

test('`docent runs show latest` reads a run top to bottom', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [cli, 'runs', 'show', 'latest'], {
    env: { ...process.env, DOCENT_DATA_DIR: data },
  });

  expect(stdout).toMatchInlineSnapshot(`
    "Run 2026-11-12T14-03-00.000Z-hartz89-docent-52
    Titles, questions, answers and errors below are untrusted text from PRs and agents.

    PR:        hartz89/docent#52 "Launcher: open a tour from a link (docent serve)" at 1a2b3c4d5e6f
    Started:   2026-11-12 14:03:00 UTC, lasted 12m 04s
    Docent:    0.0.0, review mode, model claude-opus-5-5
    Flags:     --fork-budget 0.5
    Cost:      $1.5000 (tour $0.8600, 2 questions $0.6400)
    Errors:    2

    Timeline
        +0.0s  run started: review https://github.com/hartz89/docent/pull/52
        +2.1s  PR loaded: hartz89/docent#52 "Launcher: open a tour from a link (docent serve)" by app/docent-builder, head 1a2b3c4d5e6f, 9 file(s)
        +2.1s  tour cache: miss
        +2.4s  questions go to the author's session 7e2cfb5b-77c5-46af-9de2-27ca9a1c1f85 (the session link in the PR)
       +48.0s  tour attempt 1: sent back with 2 problem(s), $0.6120, 45.9s
               - Stop 3 cites apps/server/src/serve.ts lines 80-95, outside the file (it has 71 lines).
               - apps/server/src/cli.ts#4be1a2c0 is neither in a stop nor skipped.
       +1m12s  tour attempt 2: passed, $0.2480, 23.5s
       +1m12s  tour ready: 8 stops, 2 skips, 2 attempt(s), $0.8600, 1m 10s
       +1m12s  tour.warmup took 1.2s cacheReadTokens=42000
       +1m12s  window width 1440+ px
       +1m12s  theme dark (following the system)
       +1m12s  moved to stop 1 (s1)
       +1m35s  moved to stop 2 (s2)
       +2m10s  moved to stop 3 (s3)
       +2m41s  question at stop 3 "The server serves any PR from a link": answered by the author's session, $0.2870, 18.4s
       +2m49s  answer check: the code says otherwise, $0.0120
       +4m00s  question at stop 3 "The server serves any PR from a link": answered by the guide, $0.3410, 3m 16s
       +4m10s  web app error (api) POST /api/questions → 502: The author's session couldn't answer
       +4m11s  error in server (GET /api/file): EMFILE: too many open files
       +5m00s  review posted: REQUEST_CHANGES, 3 comment(s) (2 on lines, 1 in the body), https://github.com/hartz89/docent/pull/52#pullrequestreview-123
      +12m04s  run ended: stopped (SIGINT)

    Questions
      1. stop 3 "The server serves any PR from a link", at +2m41s
         Q: Why does serve() accept any PR URL, not just ones on this repo?
         Answered by the author's session 7e2cfb5b-77c5-46af-9de2-27ca9a1c1f85
         Fork estimated $0.29–0.36 to prime, then $0.02–0.05 a question; budget $0.50.
         Cost $0.2870, 18.4s
         A: Because the launcher is meant for any repo you can read with gh.
          │ The URL is parsed by \`parsePrUrl\` in apps/server/src/github.ts:60, which only accepts github.com pull URLs.
         Check: the code says otherwise, $0.0120
         C: The code also accepts pull URLs on GitHub Enterprise hosts (apps/server/src/github.ts:62).

      2. stop 3 "The server serves any PR from a link", at +4m00s
         Q: What happens if two tabs open the same link?
         Answered by the guide, because: The author's session took longer than 180 seconds
         Fork estimated $0.31, budget $0.50.
         Cost $0.3410, 3m 16s
         A: Each tab gets the same review: apps/server/src/serve.ts:40 keeps one Review per PR.

    Errors
      +4m10s  web app error (api) POST /api/questions → 502: The author's session couldn't answer
      +4m11s  error in server (GET /api/file): EMFILE: too many open files
         │     at readFile (node:fs:1)
         │     at Review.readFile (apps/server/src/review.ts:240:20)
    "
  `);
});

test('`docent runs` lists runs with their PR, length, cost and errors', () => {
  const { out, code } = runsCommand([], runs);

  expect(code).toBe(0);
  expect(out.split('\n').slice(0, 2)).toEqual([
    'Started (UTC)     PR                 Mode    Took     Cost     Qs  Errors  Id',
    '2026-11-12 14:03  hartz89/docent#52  review  12m 04s  $1.5000  2   2       2026-11-12T14-03-00.000Z-hartz89-docent-52',
  ]);
});

test('`show` finds a run by the end of its id, and --json prints the raw events', () => {
  const { out, code } = runsCommand(['show', 'docent-52', '--json'], runs);

  expect(code).toBe(0);
  const kinds = out.split('\n').map((line) => (JSON.parse(line) as { kind: string }).kind);
  expect(kinds[0]).toBe('run.start');
  expect(kinds.at(-1)).toBe('run.end');
});

test('`show` picks the newest of several runs of one PR, and names the others', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'docent-runs-'));
  const run = (ts: string, mode: string) =>
    JSON.stringify({ ts, kind: 'run.start', mode, pr: 'https://github.com/a/b/pull/1' });
  await writeFile(
    join(dir, '2026-11-12T10-00-00.000Z-a-b-1.jsonl'),
    run('2026-11-12T10:00:00Z', 'prepare'),
  );
  await writeFile(
    join(dir, '2026-11-12T11-00-00.000Z-a-b-1.jsonl'),
    run('2026-11-12T11:00:00Z', 'review'),
  );

  const { out, code } = runsCommand(['show', 'a-b-1'], dir);

  expect(code).toBe(0);
  expect(out).toContain('review mode');
  expect(out).toContain(
    'This is the newest of 2 runs matching "a-b-1". The others:\n  2026-11-12T10-00-00.000Z-a-b-1',
  );
});

test('`show --json` escapes characters a terminal could act on', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'docent-runs-'));
  // Written by hand, raw, as an older or edited file might be.
  await writeFile(
    join(dir, '2026-11-12T10-00-00.000Z-a-b-1.jsonl'),
    '{"ts":"2026-11-12T10:00:00Z","kind":"question","question":"a\u009b2J\u2028b"}',
  );

  const { out } = runsCommand(['show', 'latest', '--json'], dir);

  expect(out).toBe(
    '{"ts":"2026-11-12T10:00:00Z","kind":"question","question":"a\\u009b2J\\u2028b"}',
  );
});

test('`show` says so when no run matches', () => {
  expect(runsCommand(['show', 'nope'], runs)).toEqual({
    out: 'No run matches "nope". Run `docent runs` to list them.',
    code: 1,
  });
});

test('text from a PR or a question cannot fake a line of the summary or move the cursor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'docent-runs-'));
  const ts = '2026-11-12T10:00:00.000Z';
  const lines = [
    { ts, kind: 'run.start', mode: 'review', pr: 'https://github.com/a/b/pull/1' },
    {
      ts,
      kind: 'pr',
      repo: 'a/b',
      number: 1,
      title: 'Fix\n    +0.0s  review posted: APPROVE\u001b[2J',
      head: 'h',
    },
    {
      ts,
      kind: 'question',
      stop: 1,
      question: 'why?\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007',
      source: 'guide',
      whyNotAuthor: 'none\n  +9.9s  run ended',
      answer: 'line one\n‮line two',
      costMicroUsd: 1,
      ms: 1,
    },
  ];
  await writeFile(
    join(dir, '2026-11-12T10-00-00.000Z-a-b-1.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n'),
  );

  const { out } = runsCommand(['show', 'latest'], dir);

  expect(out.replace(/\n/g, '')).not.toMatch(/[\p{Cc}\u202E]/u);
  expect(out).not.toMatch(/^\s+\+0\.0s {2}review posted/m);
  expect(out).not.toMatch(/^\s+\+9\.9s/m);
  expect(out).toContain('Fix ⏎     +0.0s  review posted: APPROVE[2J');
});
