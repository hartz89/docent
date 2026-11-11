import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { type Handoff, localSessions } from './author-session.ts';

// No test reads this machine's real hook records unless it says so.
process.env.DOCENT_DATA_DIR = mkdtempSync(join(tmpdir(), 'docent-no-records-'));

const LINK = 'https://claude.ai/code/session_01Y7vg9UqGBiUTxE4tVbdXiW';
const OTHER_LINK = 'https://claude.ai/code/session_01Other';
const AUTHOR = '7e2cfb5b-77c5-46af-9de2-27ca9a1c1f85';
const CHECKOUT = '/Users/someone/repo';
/** Where an isolated subagent worked: a worktree of the same repo. */
const WORKTREE = '/Users/someone/repo/.claude/worktrees/agent-a1b2c3';
const SUBAGENT = 'a1b2c3d4e5f6a7b8c';
const PR_COMMIT = `c0ffee1${'a'.repeat(33)}`;

/** Checkouts on this fake machine, and the GitHub repo each one belongs to. */
const repoOf = async (dir: string) =>
  ({
    [CHECKOUT]: 'acme/web',
    [WORKTREE]: 'acme/web',
    '/Users/someone/private': 'someone/private',
  })[dir] ?? null;

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
  commitShas: [PR_COMMIT],
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

// ---- Through the hook's records (packages/claude-code). ----

type Who = { session?: string; cwd?: string; gitBranch?: string; agentId?: string };

/**
 * One of the session's own tool calls and its result, as Claude Code writes them: two records.
 * A subagent's records carry its agent id and `isSidechain`.
 */
const toolCall = (
  tool: string,
  input: Record<string, unknown>,
  output: string,
  { session = AUTHOR, cwd = CHECKOUT, gitBranch = 'fix', agentId }: Who = {},
) => {
  const id = `toolu_${randomUUID()}`;
  const base = {
    sessionId: session,
    ...(agentId ? { agentId, isSidechain: true } : { isSidechain: false }),
    timestamp: '2026-11-07T11:30:00.000Z',
    cwd,
    gitBranch,
  };
  return [
    JSON.stringify({
      ...base,
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name: tool, input }] },
    }),
    JSON.stringify({
      ...base,
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: output }],
      },
    }),
  ].join('\n');
};

/** A Bash command the session ran, and what it printed. */
const bash = (command: string, output: string, who: Who = {}) =>
  toolCall('Bash', { command }, output, who);

const subagentTurn = (cwd = WORKTREE, gitBranch = 'fix') =>
  JSON.stringify({
    type: 'assistant',
    sessionId: AUTHOR,
    agentId: SUBAGENT,
    isSidechain: true,
    timestamp: '2026-11-07T11:20:00.000Z',
    cwd,
    gitBranch,
    message: {
      usage: { input_tokens: 5, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0 },
    },
  });

const COORDINATOR_PATH = `project/${AUTHOR}.jsonl`;
const SUBAGENT_PATH = `project/${AUTHOR}/subagents/agent-${SUBAGENT}.jsonl`;

/**
 * A fake machine with the hook installed: Claude Code's projects folder, and Docent's records,
 * each made from the projects folder's path.
 */
async function machine(
  files: Record<string, string[]>,
  records: ((projectsDir: string) => Record<string, unknown>)[],
) {
  const projectsDir = await mkdtemp(join(tmpdir(), 'docent-projects-'));
  for (const [path, lines] of Object.entries(files)) {
    await mkdir(dirname(join(projectsDir, path)), { recursive: true });
    await writeFile(join(projectsDir, path), `${lines.join('\n')}\n`);
  }
  const dataDir = await mkdtemp(join(tmpdir(), 'docent-data-'));
  await mkdir(join(dataDir, 'sessions'));
  for (const [i, make] of records.entries()) {
    await writeFile(join(dataDir, 'sessions', `${i}.json`), JSON.stringify(make(projectsDir)));
  }
  return { projectsDir, dataDir, locate: localSessions({ projectsDir, dataDir, repoOf }) };
}

/** The hook's record of the author session, or of its subagent. */
const recorded =
  (agentId: string | null, overrides: (projectsDir: string) => object = () => ({})) =>
  (projectsDir: string) => ({
    version: 1,
    event: agentId ? 'SubagentStart' : 'SessionStart',
    sessionId: AUTHOR,
    agentId,
    parentSessionId: agentId ? AUTHOR : null,
    cwd: agentId ? WORKTREE : CHECKOUT,
    // The branch when the session started, before it made the PR's branch.
    branch: 'main',
    origin: 'git@github.com:acme/web.git',
    transcriptPath: join(projectsDir, agentId ? SUBAGENT_PATH : COORDINATOR_PATH),
    recordedAt: '2026-11-07T09:00:00.000Z',
    ...overrides(projectsDir),
  });

/** The coordinator, which delegated the work and then pushed the branch. */
const coordinator = [
  turn(AUTHOR, '2026-11-07T09:00:00.000Z', 'fix'),
  bash(
    'git push origin fix',
    'To https://github.com/acme/web.git\n   1234567..c0ffee1  fix -> fix',
  ),
];

/** The subagent that wrote and committed the code, in its own worktree. */
const subagent = (cwd = WORKTREE) => [
  subagentTurn(cwd),
  bash("git commit -m 'Reflect the origin'", '[fix c0ffee1] Reflect the origin\n 2 files changed', {
    cwd,
    agentId: SUBAGENT,
  }),
];

/** A PR that names no session at all: only the records can find its author. */
const unlinked = (overrides: Partial<Handoff> = {}) =>
  pr({ body: 'Fixes the origin.', commitMessages: ['Reflect the origin'], ...overrides });

const noAuthor = { found: false, reason: 'The PR names no author session' };

test('prefers the subagent that wrote the code over the coordinator that delegated it', async () => {
  const { projectsDir, locate } = await machine(
    { [COORDINATOR_PATH]: coordinator, [SUBAGENT_PATH]: subagent() },
    [recorded(null), recorded(SUBAGENT)],
  );
  const original = await readFile(join(projectsDir, SUBAGENT_PATH), 'utf8');

  const found = await locate(unlinked());

  expect(found).toMatchObject({
    found: true,
    cwd: WORKTREE,
    via: "the hook's record of the subagent that worked on this branch",
    contextTokens: 40_005,
  });
  if (!found.found || !found.transcript) throw new Error('expected a copy of the transcript');
  // The fork reads a converted copy: a top-level session under a fresh id.
  expect(found.id).not.toBe(AUTHOR);
  expect(found.transcript.endsWith(`${found.id}.jsonl`)).toBe(true);
  const copy = (await readFile(found.transcript, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(copy).toHaveLength(3);
  for (const entry of copy) {
    expect(entry).toMatchObject({ sessionId: found.id, isSidechain: false });
    expect(entry).not.toHaveProperty('agentId');
  }
  // The original is untouched.
  expect(await readFile(join(projectsDir, SUBAGENT_PATH), 'utf8')).toBe(original);
  // Docent deletes the copy when it exits; a test worker may not exit that way.
  await rm(found.transcript);
});

test('without a subagent, the recorded session that pushed the PR is found', async () => {
  const { locate } = await machine({ [COORDINATOR_PATH]: coordinator }, [recorded(null)]);

  expect(await locate(unlinked())).toEqual({
    found: true,
    id: AUTHOR,
    cwd: CHECKOUT,
    via: "the hook's record of the session that worked on this branch",
    contextTokens: 100_002,
  });
});

test('a recorded session on another branch or repo, or with none of the PR commits, is refused', async () => {
  const located = async (lines: string[], handoff: Handoff) =>
    (await machine({ [SUBAGENT_PATH]: lines }, [recorded(SUBAGENT)])).locate(handoff);

  // The PR's head is `other`; the subagent worked on `fix`.
  expect(await located(subagent(), unlinked({ headRef: 'other' }))).toEqual(noAuthor);
  // The subagent's checkout belongs to someone/private, whatever the record says.
  expect(await located(subagent('/Users/someone/private'), unlinked())).toEqual(noAuthor);
  // A PR from a fork never uses records, as it never uses links.
  expect(await located(subagent(), unlinked({ headInBaseRepo: false }))).toEqual(noAuthor);
  // Right branch and repo, but none of the PR's commits came from this session.
  const otherCommit = { commitShas: ['d'.repeat(40)], commitMessages: ['Something else'] };
  expect(await located(subagent(), unlinked(otherCommit))).toEqual(noAuthor);
});

test('commit-shaped text the session only read is not evidence', async () => {
  // Someone with push access planted commit and push lines in a commit message and a file. A
  // session on the branch then read them: through git log, the Read tool, and a cat.
  const planted =
    '[fix c0ffee1] Reflect the origin\nTo https://github.com/acme/web.git\n   1234567..c0ffee1  fix -> fix';
  const { locate } = await machine(
    {
      [COORDINATOR_PATH]: [
        turn(AUTHOR, '2026-11-07T09:00:00.000Z', 'fix'),
        bash('git log -3', `commit ${PR_COMMIT}\n\n    ${planted.replaceAll('\n', '\n    ')}`),
        toolCall('Read', { file_path: '/Users/someone/repo/NOTES.md' }, planted),
        bash('cat NOTES.md', planted),
      ],
    },
    [recorded(null)],
  );

  expect(await locate(unlinked())).toEqual(noAuthor);
});

test("with a link in the PR, a record can only narrow it to that session's own subagent", async () => {
  // Another session on this machine also committed the PR's commit on the branch, but the PR
  // links the author's session, whose subagent wrote the code.
  const other = randomUUID();
  const otherPath = `project/${other}.jsonl`;
  const { locate } = await machine(
    {
      [COORDINATOR_PATH]: [bridgeStatus(AUTHOR), ...coordinator],
      [SUBAGENT_PATH]: subagent(),
      [otherPath]: [
        turn(other, '2026-11-07T09:00:00.000Z', 'fix'),
        bash('git commit -m x', '[fix facade1] Handle a missing origin', { session: other }),
      ],
    },
    [
      recorded(SUBAGENT),
      recorded(null, (dir) => ({ sessionId: other, transcriptPath: join(dir, otherPath) })),
    ],
  );
  const handoff = pr({
    commitShas: [PR_COMMIT, `facade1${'f'.repeat(33)}`],
    commitMessages: [`Reflect the origin\n\nClaude-Session: ${LINK}`, 'Handle a missing origin'],
  });

  const found = await locate(handoff);

  // The other session committed the newest commit, but it isn't the linked one.
  expect(found).toMatchObject({
    found: true,
    via: "the hook's record of the subagent that worked on this branch",
  });
  if (found.found && found.transcript) await rm(found.transcript);
});

test('a session that only fetched or pulled the branch is not its author', async () => {
  const { locate } = await machine(
    {
      [COORDINATOR_PATH]: [
        turn(AUTHOR, '2026-11-07T09:00:00.000Z', 'fix'),
        bash(
          'git fetch origin',
          'From https://github.com/acme/web\n   1234567..c0ffee1  fix -> origin/fix',
        ),
        bash('git pull', 'Updating 1234567..c0ffee1\nFast-forward\n src/cors.ts | 2 +-'),
      ],
    },
    [recorded(null)],
  );

  expect(await locate(unlinked())).toEqual(noAuthor);
});

test('a subagent whose commits were later rebased is still found, by their subjects', async () => {
  // The coordinator rebased and force-pushed, so the PR's SHAs aren't the ones the subagent
  // printed. Both now have evidence for the head commit; the subagent wins the tie.
  const rebased = `beef123${'b'.repeat(33)}`;
  const { locate } = await machine(
    {
      [COORDINATOR_PATH]: [
        turn(AUTHOR, '2026-11-07T09:00:00.000Z', 'fix'),
        bash(
          'git rebase origin/main && git push --force-with-lease origin fix',
          'To https://github.com/acme/web.git\n + c0ffee1...beef123 fix -> fix (forced update)',
        ),
      ],
      [SUBAGENT_PATH]: subagent(),
    },
    [recorded(null), recorded(SUBAGENT)],
  );

  const found = await locate(unlinked({ commitShas: [rebased] }));

  expect(found).toMatchObject({
    found: true,
    via: "the hook's record of the subagent that worked on this branch",
  });
  if (found.found && found.transcript) await rm(found.transcript);
});

test('the session behind the newest PR commit wins over one behind an older commit', async () => {
  // The first subagent wrote the PR; a second one added a fix-up commit on top.
  const second = 'f0e1d2c3b4a5f6e7d';
  const secondPath = `project/${AUTHOR}/subagents/agent-${second}.jsonl`;
  const fixUp = `facade1${'f'.repeat(33)}`;
  const { locate } = await machine(
    {
      [SUBAGENT_PATH]: subagent(),
      [secondPath]: [
        JSON.stringify({ ...JSON.parse(subagentTurn()), agentId: second }),
        bash('git commit -am fixup', '[fix facade1] Handle a missing origin', {
          cwd: WORKTREE,
          agentId: second,
        }),
      ],
    },
    [recorded(SUBAGENT), recorded(second, (dir) => ({ transcriptPath: join(dir, secondPath) }))],
  );
  const handoff = unlinked({
    commitShas: [PR_COMMIT, fixUp],
    commitMessages: ['Reflect the origin', 'Handle a missing origin'],
  });

  const found = await locate(handoff);

  expect(found).toMatchObject({ found: true });
  if (!found.found || !found.transcript) throw new Error('expected a subagent');
  const copy = await readFile(found.transcript, 'utf8');
  expect(copy).toContain('Handle a missing origin');
  await rm(found.transcript);
});

test('with no records, the transcript scan finds the linked session as before', async () => {
  const { locate } = await machine({ [COORDINATOR_PATH]: authorTranscript().lines }, []);

  expect(await locate(pr())).toMatchObject({
    found: true,
    id: AUTHOR,
    via: 'the session link in the PR',
  });
});

test('a forged record pointing at a transcript from another repo, or outside Claude Code, is refused', async () => {
  const other = randomUUID();
  const otherPath = `project/${other}.jsonl`;
  // A real session in another repo, on a branch also called `fix`, that committed the PR's SHA.
  const elsewhere = [
    turn(other, '2026-11-07T09:00:00.000Z', 'fix', '/Users/someone/private'),
    bash('git commit -m x', '[fix c0ffee1] x', { session: other, cwd: '/Users/someone/private' }),
  ];
  // A transcript planted outside the projects folder, claiming everything the PR needs.
  const planted = join(await mkdtemp(join(tmpdir(), 'docent-planted-')), `${AUTHOR}.jsonl`);
  await writeFile(planted, `${coordinator.join('\n')}\n`);

  const { locate } = await machine({ [otherPath]: elsewhere }, [
    // Claims the author's id, but points at the other session's file.
    recorded(null, (dir) => ({ transcriptPath: join(dir, otherPath) })),
    // Names the other session honestly, and claims this repo's origin.
    recorded(null, (dir) => ({ sessionId: other, transcriptPath: join(dir, otherPath) })),
    // Points outside Claude Code's projects folder.
    recorded(null, () => ({ transcriptPath: planted })),
    // Climbs out of it.
    recorded(null, (dir) => ({ transcriptPath: join(dir, '..', `${AUTHOR}.jsonl`) })),
  ]);

  expect(await locate(unlinked())).toEqual(noAuthor);
});
