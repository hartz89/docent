import { mkdtemp, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hc } from 'hono/client';
import { describe, expect, test } from 'vitest';
import { type AppType, createApp } from './app.ts';
import { fixedSession } from './author-session.ts';
import { fixtureRunner, fixtureSource } from './fixture.ts';
import type { PrSource } from './github.ts';
import { Review } from './review.ts';
import { KEEP_FILES, MAX_FIELD_CHARS, RunLog } from './run-log.ts';

// A recorded review, replayed: real PR data, no GitHub or model calls.
const fixture = fileURLToPath(new URL('../../../e2e/fixtures/hono-4813', import.meta.url));
const origin = 'http://127.0.0.1:4123';
const token = 'per-launch-token-0123456789abcdef';
const signedIn = { Authorization: `Bearer ${token}`, Origin: origin };

const tempDir = () => mkdtemp(join(tmpdir(), 'docent-runs-'));

async function events(log: RunLog) {
  const text = await readFile(log.path ?? '', 'utf8');
  return text
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as { ts: string; kind: string } & Record<string, unknown>);
}

/** A review of the recorded PR, with its log, served by the app. */
async function served(
  options: { source?: PrSource; limits?: { perMinute: number; total: number } } = {},
) {
  const log = RunLog.open({ dir: await tempDir(), label: 'honojs-hono-4813', env: {} });
  log.addSecret(token);
  const review = new Review({
    source: options.source ?? fixtureSource(fixture, () => {}),
    runner: fixtureRunner(fixture),
    locator: fixedSession({ found: false, reason: 'No author session here' }),
    model: 'claude-opus-5-5',
    log,
  });
  await review.done;
  const app = createApp({
    token,
    origin,
    version: '1.2.3',
    review,
    log,
    ...(options.limits ? { clientLogLimits: options.limits } : {}),
  });
  const client = hc<AppType>(origin, { fetch: app.request, headers: signedIn });
  return { log, review, app, client };
}

describe('the run log', () => {
  test('records the PR, the tour, and each question with who answered and why', async () => {
    const { log, review, client } = await served();
    const stop = review.snapshot().tour;
    if (stop.state !== 'ready') throw new Error('tour not ready');
    const stopId = stop.tour.stops[1]?.id ?? '';

    const res = await client.api.questions.$post({
      json: { stopId, question: 'What does it return with no Origin header?' },
    });
    expect(res.status).toBe(200);

    const written = await events(log);
    expect(written.map((e) => e.kind)).toEqual([
      'pr',
      'tour.cache',
      'author',
      'tour.attempt',
      'tour.ready',
      'question',
    ]);
    for (const e of written) expect(Date.parse(e.ts)).not.toBeNaN();
    expect(written.find((e) => e.kind === 'pr')).toMatchObject({
      repo: 'honojs/hono',
      number: 4813,
      head: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    expect(written.find((e) => e.kind === 'tour.ready')).toMatchObject({
      cached: false,
      attempts: 1,
      costMicroUsd: expect.any(Number),
    });
    expect(written.find((e) => e.kind === 'question')).toMatchObject({
      stop: 2,
      question: 'What does it return with no Origin header?',
      source: 'guide',
      whyNotAuthor: 'No author session here',
      answer: expect.stringContaining('It returns `null`.'),
      costMicroUsd: expect.any(Number),
      ms: expect.any(Number),
    });
  });

  test('is readable only by this user', async () => {
    const { log } = await served();
    const path = log.path ?? '';

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(path, '..'))).mode & 0o777).toBe(0o700);
  });

  test('records a server error with its stack, and answers with no detail', async () => {
    const broken: PrSource = async (onStep) => ({
      ...(await fixtureSource(fixture, () => {})(onStep)),
      readFile: async () => {
        throw new Error('disk on fire');
      },
    });
    const { log, client } = await served({ source: broken });

    const res = await client.api.file.$get({ query: { path: 'src/index.ts', side: 'new' } });

    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('disk on fire');
    expect((await events(log)).at(-1)).toMatchObject({
      kind: 'error',
      where: 'server',
      path: '/api/file',
      message: 'disk on fire',
      stack: expect.stringContaining('run-log.test.ts'),
    });
  });

  test('writes nothing when it is off', async () => {
    const log = RunLog.off();
    log.event('run.start', { version: '1' });
    log.span('anything').end();

    expect(log.path).toBeNull();
  });
});

describe('redaction', () => {
  test('never writes the launch token, GitHub tokens, API keys or secret env values', async () => {
    const env = {
      GH_TOKEN: 'gho_envvalue1234567890abcdef',
      MY_SERVICE_SECRET: 'hunter2-but-longer',
      HOME: '/Users/someone',
    };
    const log = RunLog.open({ dir: await tempDir(), label: 'x', env });
    log.addSecret(token);
    log.event('client.error', {
      message: `failed at http://127.0.0.1:4123/#token=${token}`,
      stack: `Authorization: Bearer ${token}\nghp_${'a'.repeat(36)} github_pat_${'b'.repeat(40)}`,
      note: `key sk-ant-api03-${'c'.repeat(40)} and sk-proj-${'d'.repeat(30)}`,
      fromEnv: 'gh said gho_envvalue1234567890abcdef, then hunter2-but-longer',
      nested: { token: 'whatever', apiKey: 'whatever', list: [`x ${token} y`] },
      home: '/Users/someone/project',
    });

    const text = await readFile(log.path ?? '', 'utf8');
    for (const secret of [
      token,
      'ghp_',
      'github_pat_',
      'sk-ant-',
      'sk-proj-',
      'gho_envvalue',
      'hunter2',
      'whatever',
    ]) {
      expect(text).not.toContain(secret);
    }
    // Ordinary text survives, so the log still reads.
    expect(text).toContain('/Users/someone/project');
    expect(text).toContain('failed at http://127.0.0.1:4123/#token=[redacted]');
  });

  test('scrubs before it cuts, so a secret across the cut leaves nothing behind', async () => {
    const log = RunLog.open({ dir: await tempDir(), label: 'x', env: {} });
    log.addSecret(token);
    const gh = `ghp_${'e'.repeat(36)}`;
    log.event('question', {
      a: `${'x'.repeat(MAX_FIELD_CHARS - 20)}${token}`,
      b: `${'x'.repeat(MAX_FIELD_CHARS - 10)}${gh}`,
    });

    const text = await readFile(log.path ?? '', 'utf8');
    expect(text).not.toContain(token.slice(0, 12));
    expect(text).not.toContain('ghp_');
  });

  test('catches tokens glued to other text, and in field names', async () => {
    const log = RunLog.open({ dir: await tempDir(), label: 'x', env: {} });
    log.addSecret(token);
    log.event('x', { a: `id_ghp_${'f'.repeat(36)}`, nested: { [token]: 1 } });

    const text = await readFile(log.path ?? '', 'utf8');
    expect(text).not.toContain('ghp_');
    expect(text).not.toContain(token);
  });

  test('keeps session ids, which say who answered', async () => {
    const id = '7e2cfb5b-77c5-46af-9de2-27ca9a1c1f85';
    const log = RunLog.open({
      dir: await tempDir(),
      label: 'x',
      env: { CLAUDE_CODE_SESSION_ID: id },
    });
    log.event('author', { session: id });

    expect((await events(log))[0]?.session).toBe(id);
  });

  test('writes characters a terminal could act on as escapes', async () => {
    const log = RunLog.open({ dir: await tempDir(), label: 'x', env: {} });
    log.event('question', { question: 'a\u009b2Jb\u2028c\u202ed' });

    const text = await readFile(log.path ?? '', 'utf8');
    expect(text).toContain('a\\u009b2Jb\\u2028c\\u202ed');
    expect((await events(log))[0]?.question).toBe('a\u009b2Jb\u2028c\u202ed');
  });

  test('caps long text, so one answer cannot swallow the log', async () => {
    const log = RunLog.open({ dir: await tempDir(), label: 'x', env: {} });
    log.event('question', { answer: 'a'.repeat(MAX_FIELD_CHARS + 500) });

    const [written] = await events(log);
    expect(String(written?.answer)).toHaveLength(
      MAX_FIELD_CHARS + '… [500 more characters]'.length,
    );
  });

  test('a question cannot add a line or a field of its own', async () => {
    const log = RunLog.open({ dir: await tempDir(), label: 'x', env: {} });
    log.event('question', { question: 'hi"}\n{"kind":"run.end","ts":"x"}', kind: 'forged' });

    const written = await events(log);
    expect(written).toHaveLength(1);
    expect(written[0]?.kind).toBe('question');
  });
});

describe('retention', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = new Date('2026-11-12T12:00:00.000Z');
  const name = (at: Date, label: string) => `${at.toISOString().replace(/:/g, '-')}-${label}.jsonl`;

  test('removes runs older than 30 days at startup, and leaves other files alone', async () => {
    const dir = await tempDir();
    const old = new Date(now.getTime() - 31 * day);
    const recent = new Date(now.getTime() - 2 * day);
    await writeFile(join(dir, name(old, 'old')), '');
    await utimes(join(dir, name(old, 'old')), old, old);
    await writeFile(join(dir, name(recent, 'recent')), '');
    await utimes(join(dir, name(recent, 'recent')), recent, recent);
    await writeFile(join(dir, 'notes.txt'), 'mine');

    RunLog.open({ dir, label: 'new', now: () => now, env: {} });

    expect((await readdir(dir)).sort()).toEqual(
      [name(recent, 'recent'), name(now, 'new'), 'notes.txt'].sort(),
    );
  });

  test(`keeps at most ${KEEP_FILES} runs, dropping the oldest`, async () => {
    const dir = await tempDir();
    const names = Array.from({ length: KEEP_FILES + 5 }, (_, i) =>
      name(new Date(now.getTime() - (i + 1) * 60_000), `run${i}`),
    );
    await Promise.all(names.map((n) => writeFile(join(dir, n), '')));

    RunLog.open({ dir, label: 'new', now: () => now, env: {} });

    const left = await readdir(dir);
    expect(left).toHaveLength(KEEP_FILES);
    expect(left).toContain(name(now, 'new'));
    // The six oldest are gone.
    for (const gone of names.slice(-6)) expect(left).not.toContain(gone);
  });
});

describe('POST /api/client-log', () => {
  test('needs the token', async () => {
    const { app } = await served();
    const res = await app.request(`${origin}/api/client-log`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'ui.viewport', width: '1440+' }),
    });

    expect(res.status).toBe(401);
  });

  test('refuses another website, even with the token', async () => {
    const { app } = await served();
    const res = await app.request(`${origin}/api/client-log`, {
      method: 'POST',
      headers: { ...signedIn, Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'ui.viewport', width: '1440+' }),
    });

    expect(res.status).toBe(403);
  });

  test('logs only the known fields of a known kind', async () => {
    const { log, client } = await served();

    const ok = await client.api['client-log'].$post({
      json: {
        kind: 'client.error',
        source: 'api',
        message: 'The server answered 502',
        method: 'POST',
        path: '/api/questions',
        status: 502,
        keystrokes: 'secret typing',
        href: `http://127.0.0.1:4123/#token=${token}`,
      } as never,
    });
    const unknown = await client.api['client-log'].$post({
      json: { kind: 'mouse.move', x: 1 } as never,
    });
    const forged = await client.api['client-log'].$post({
      json: { kind: 'client.error', source: 'window', message: 'one\n{"kind":"run.end"}' } as never,
    });

    expect(ok.status).toBe(204);
    expect(unknown.status).toBe(400);
    expect(forged.status).toBe(400);
    const last = (await events(log)).at(-1);
    expect(last).toEqual({
      ts: expect.any(String),
      kind: 'client.error',
      source: 'api',
      message: 'The server answered 502',
      method: 'POST',
      path: '/api/questions',
      status: 502,
    });
  });

  test('refuses a body over 16 KB', async () => {
    const { client } = await served();
    const res = await client.api['client-log'].$post({
      json: {
        kind: 'client.error',
        source: 'window',
        message: 'x',
        stack: 'y'.repeat(17_000),
      } as never,
    });

    expect(res.status).toBe(413);
  });

  test('is rate-limited', async () => {
    const { log, client } = await served({ limits: { perMinute: 3, total: 100 } });
    const send = () =>
      client.api['client-log'].$post({ json: { kind: 'ui.stop', stop: 1, stopId: 's1' } as never });

    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await send()).status);

    expect(statuses).toEqual([204, 204, 204, 429, 429]);
    expect((await events(log)).filter((e) => e.kind === 'ui.stop')).toHaveLength(3);
  });
});
