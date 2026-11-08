import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { localSessions } from './author-session.ts';

const LINK = 'https://claude.ai/code/session_01Y7vg9UqGBiUTxE4tVbdXiW';
const AUTHOR = '7e2cfb5b-77c5-46af-9de2-27ca9a1c1f85';

/** A line as Claude Code writes it when remote control starts in a session. */
const bridgeStatus = (session: string, url = LINK) =>
  JSON.stringify({
    type: 'system',
    subtype: 'bridge_status',
    content: `/remote-control is active · Continue here, on your phone, or at ${url}`,
    url,
    cwd: '/Users/someone/repo',
    sessionId: session,
  });

/** A fake ~/.claude/projects, with transcripts written in the order given. */
async function projects(...transcripts: { project: string; session: string; lines: string[] }[]) {
  const dir = await mkdtemp(join(tmpdir(), 'docent-projects-'));
  for (const { project, session, lines } of transcripts) {
    await mkdir(join(dir, project), { recursive: true });
    await writeFile(join(dir, project, `${session}.jsonl`), `${lines.join('\n')}\n`);
    // Distinct creation times, so "oldest first" is well defined.
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return dir;
}

const handoff = (body: string, ...commitMessages: string[]) => ({ body, commitMessages });

test("finds the author's session from the Claude-Session link in a commit", async () => {
  const projectsDir = await projects({
    project: '-Users-someone-repo',
    session: AUTHOR,
    lines: [JSON.stringify({ type: 'mode', sessionId: AUTHOR }), bridgeStatus(AUTHOR)],
  });

  const found = await localSessions({ projectsDir })(
    handoff('Fixes the origin.', `Reflect the origin\n\nClaude-Session: ${LINK}`),
  );

  expect(found).toEqual({
    found: true,
    id: AUTHOR,
    cwd: '/Users/someone/repo',
    via: 'the session link in the PR',
  });
});

test('a transcript that only quotes the link is not the author', async () => {
  // Docent's own tour session reads the PR body, link and all.
  const tour = randomUUID();
  const projectsDir = await projects({
    project: '-cache-docent-repos',
    session: tour,
    lines: [
      JSON.stringify({
        type: 'user',
        sessionId: tour,
        message: { content: `PR body: ${LINK} and "bridge_status"` },
      }),
    ],
  });

  const found = await localSessions({ projectsDir })(handoff(`https://x\n\n${LINK}`));

  expect(found).toEqual({ found: false, reason: "The author's session isn't on this machine" });
});

test('prefers the original over a fork, which copies the same record', async () => {
  const fork = randomUUID();
  const projectsDir = await projects(
    { project: 'a', session: AUTHOR, lines: [bridgeStatus(AUTHOR)] },
    { project: 'a', session: fork, lines: [bridgeStatus(fork)] },
  );

  const found = await localSessions({ projectsDir })(handoff(LINK));

  expect(found).toMatchObject({ found: true, id: AUTHOR });
});

test('a PR with no session link goes to the guide', async () => {
  const projectsDir = await projects();

  expect(await localSessions({ projectsDir })(handoff('No link here.'))).toEqual({
    found: false,
    reason: 'The PR names no author session',
  });
});

test('an explicit session must be a session id that exists on this machine', async () => {
  const missing = randomUUID();

  expect(await localSessions({ explicit: 'not-a-uuid' })(handoff(LINK))).toEqual({
    found: false,
    reason: 'not-a-uuid is not a Claude Code session id',
  });
  expect(await localSessions({ explicit: missing })(handoff(LINK))).toEqual({
    found: false,
    reason: `Session ${missing} isn't on this machine`,
  });
});
