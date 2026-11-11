import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { type Handoff, localSessions } from './author-session.ts';

const LINK = 'https://claude.ai/code/session_01Y7vg9UqGBiUTxE4tVbdXiW';
const OTHER_LINK = 'https://claude.ai/code/session_01Other';
const AUTHOR = '7e2cfb5b-77c5-46af-9de2-27ca9a1c1f85';
const CHECKOUT = '/Users/someone/repo';

/** Checkouts on this fake machine, and the GitHub repo each one belongs to. */
const repoOf = async (dir: string) =>
  ({ [CHECKOUT]: 'acme/web', '/Users/someone/private': 'someone/private' })[dir] ?? null;

/** A line as Claude Code writes it when remote control starts in a session. */
const bridgeStatus = (session: string, url = LINK, cwd = CHECKOUT) =>
  JSON.stringify({
    type: 'system',
    subtype: 'bridge_status',
    content: `/remote-control is active · Continue here, on your phone, or at ${url}`,
    url,
    cwd,
    sessionId: session,
    timestamp: '2026-11-07T10:00:00.000Z',
  });

/** A turn of work: where it ran, on which branch, and how big the context was. */
const turn = (session: string, at: string, gitBranch: string, cwd = CHECKOUT) =>
  JSON.stringify({
    type: 'assistant',
    sessionId: session,
    timestamp: at,
    cwd,
    gitBranch,
    message: {
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 90_000,
        cache_creation_input_tokens: 10_000,
      },
    },
  });

/** A fake ~/.claude/projects. */
async function projects(...transcripts: { session: string; lines: string[] }[]) {
  const dir = await mkdtemp(join(tmpdir(), 'docent-projects-'));
  for (const { session, lines } of transcripts) {
    await mkdir(join(dir, 'project'), { recursive: true });
    await writeFile(join(dir, 'project', `${session}.jsonl`), `${lines.join('\n')}\n`);
  }
  return dir;
}

/** The author's transcript: it worked on the PR's branch, in a checkout of the PR's repo. */
const authorTranscript = (session = AUTHOR, startedAt = '2026-11-07T09:00:00.000Z') => ({
  session,
  lines: [
    turn(session, startedAt, 'main'),
    bridgeStatus(session),
    turn(session, '2026-11-07T11:00:00.000Z', 'fix'),
  ],
});

const pr = (overrides: Partial<Handoff> = {}): Handoff => ({
  repo: 'acme/web',
  headRef: 'fix',
  headInBaseRepo: true,
  body: 'Fixes the origin.',
  commitMessages: [`Reflect the origin\n\nClaude-Session: ${LINK}`],
  ...overrides,
});

test("finds the author's session from the PR's link, tied to the PR's repo and branch", async () => {
  const projectsDir = await projects(authorTranscript());

  expect(await localSessions({ projectsDir, repoOf })(pr())).toEqual({
    found: true,
    id: AUTHOR,
    cwd: CHECKOUT,
    via: 'the session link in the PR',
    contextTokens: 100_002,
  });
});

test("a link pasted into someone else's PR doesn't pick that session", async () => {
  // The maintainer's private session, on another branch in another repo.
  const projectsDir = await projects({
    session: AUTHOR,
    lines: [
      bridgeStatus(AUTHOR, LINK, '/Users/someone/private'),
      turn(AUTHOR, '2026-11-07T11:00:00.000Z', 'secret-work', '/Users/someone/private'),
    ],
  });
  const locate = localSessions({ projectsDir, repoOf });
  const noMatch = { found: false, reason: "The linked session doesn't match this PR" };

  expect(await locate(pr())).toEqual(noMatch);
  // Naming the branch to match isn't enough: the session never worked in this repo.
  expect(await locate(pr({ headRef: 'secret-work' }))).toEqual(noMatch);
});

test('the branch and the checkout must come from the same record', async () => {
  // A session that worked on `fix-ci` in another project, and was in this repo's checkout only
  // on `main`. Someone who can push here opens a PR from a branch named `fix-ci`, with its link.
  const projectsDir = await projects({
    session: AUTHOR,
    lines: [
      bridgeStatus(AUTHOR, LINK, '/Users/someone/private'),
      turn(AUTHOR, '2026-11-07T11:00:00.000Z', 'fix-ci', '/Users/someone/private'),
      turn(AUTHOR, '2026-11-07T11:05:00.000Z', 'main', CHECKOUT),
    ],
  });

  expect(await localSessions({ projectsDir, repoOf })(pr({ headRef: 'fix-ci' }))).toEqual({
    found: false,
    reason: "The linked session doesn't match this PR",
  });
});

test("a record naming another session doesn't make its transcript that session", async () => {
  // This transcript carries a copy of the author's record under the author's id. Checking this
  // file and forking the author would test one session and fork another.
  const copy = randomUUID();
  const projectsDir = await projects({
    session: copy,
    lines: [bridgeStatus(AUTHOR), turn(copy, '2026-11-07T11:00:00.000Z', 'fix')],
  });

  expect(await localSessions({ projectsDir, repoOf })(pr())).toEqual({
    found: false,
    reason: "The author's session isn't on this machine",
  });
});

test('a PR from a fork never picks a session by its link', async () => {
  const projectsDir = await projects(authorTranscript());

  expect(await localSessions({ projectsDir, repoOf })(pr({ headInBaseRepo: false }))).toEqual({
    found: false,
    reason: "The linked session doesn't match this PR",
  });
});

test('a transcript that only quotes the link is not the author', async () => {
  // Docent's own tour session reads the PR body, link and all.
  const tour = randomUUID();
  const projectsDir = await projects({
    session: tour,
    lines: [
      JSON.stringify({
        type: 'user',
        sessionId: tour,
        gitBranch: 'fix',
        cwd: CHECKOUT,
        message: { content: `PR body: ${LINK} and "bridge_status"` },
      }),
    ],
  });

  expect(await localSessions({ projectsDir, repoOf })(pr())).toEqual({
    found: false,
    reason: "The author's session isn't on this machine",
  });
});

test('prefers the original over a fork, which copies the same record but starts later', async () => {
  const fork = randomUUID();
  // The fork is written first, so file order and creation time would both pick it.
  const projectsDir = await projects(
    authorTranscript(fork, '2026-11-07T12:00:00.000Z'),
    authorTranscript(AUTHOR, '2026-11-07T09:00:00.000Z'),
  );

  expect(await localSessions({ projectsDir, repoOf })(pr())).toMatchObject({ id: AUTHOR });
});

test("with several links, the PR body's comes first, then the newest commit's", async () => {
  const other = randomUUID();
  const projectsDir = await projects(authorTranscript(), {
    session: other,
    lines: [bridgeStatus(other, OTHER_LINK), turn(other, '2026-11-07T09:00:00.000Z', 'fix')],
  });
  const locate = localSessions({ projectsDir, repoOf });

  expect(await locate(pr({ body: OTHER_LINK }))).toMatchObject({ id: other });
  expect(
    await locate(pr({ commitMessages: [`old\n\n${LINK}`, `new\n\n${OTHER_LINK}`] })),
  ).toMatchObject({ id: other });
});

test('a PR with no session link goes to the guide', async () => {
  const projectsDir = await projects();

  expect(await localSessions({ projectsDir, repoOf })(pr({ commitMessages: [] }))).toEqual({
    found: false,
    reason: 'The PR names no author session',
  });
});

test('an explicit session must be a session id that exists on this machine', async () => {
  const projectsDir = await projects(authorTranscript());
  const missing = randomUUID();

  expect(await localSessions({ projectsDir, explicit: 'not-a-uuid' })(pr())).toEqual({
    found: false,
    reason: 'not-a-uuid is not a Claude Code session id',
  });
  expect(await localSessions({ projectsDir, explicit: missing })(pr())).toEqual({
    found: false,
    reason: `Session ${missing} isn't on this machine`,
  });
  expect(await localSessions({ projectsDir, explicit: AUTHOR })(pr())).toMatchObject({
    found: true,
    id: AUTHOR,
    via: 'the --session flag',
  });
});
