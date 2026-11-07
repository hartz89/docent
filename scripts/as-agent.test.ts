import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { asAgent, type Deps } from './as-agent.ts';

const NOW = 1_800_000_000;
const TOKEN = 'ghs_faketoken0123456789';
const BOT = { login: 'docent-builder[bot]', id: 4242 };
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const filled = {
  builder: { slug: 'docent-builder' },
  reviewer: { slug: 'REPLACE_ME' },
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'as-agent-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Call = { method: string; url: string; auth: string };

/**
 * Fake `gh` and `git` binaries, first on PATH. Each records its argv and what a real child sees
 * (its env, and the git identity and config that real git resolves), then exits with FAKE_EXIT.
 */
function fakeBinaries(): string {
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const script = [
    '#!/bin/sh',
    `echo "$(basename "$0") $*" >> "${dir}/argv"`,
    `env > "${dir}/probe.env"`,
    `"${REAL_GIT}" var GIT_AUTHOR_IDENT > "${dir}/probe.ident"`,
    `"${REAL_GIT}" config --get http.https://github.com/.extraheader > "${dir}/probe.header"`,
    'exit "$FAKE_EXIT"',
  ].join('\n');
  for (const name of ['gh', 'git']) writeFileSync(join(bin, name), script, { mode: 0o755 });
  return bin;
}

/** A fake GitHub API. `fail` makes one path answer with an error status. */
function setup(opts: { fail?: string; config?: object; exit?: number } = {}) {
  const configPath = join(dir, 'agent-apps.json');
  writeFileSync(configPath, JSON.stringify(opts.config ?? filled));
  const calls: Call[] = [];
  const logs: string[] = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ method: init?.method ?? 'GET', url, auth: headers.get('authorization') ?? '' });
    if (opts.fail && url.endsWith(opts.fail)) {
      // A hostile error body that echoes the token back, to prove output is scrubbed.
      return Response.json({ message: `Bad credentials ${TOKEN}` }, { status: 401 });
    }
    if (url.endsWith('/apps/docent-builder')) return Response.json({ id: 111 });
    if (url.endsWith('/repos/hartz89/docent/installation')) return Response.json({ id: 222 });
    if (url.endsWith('/app/installations/222/access_tokens')) {
      return Response.json({ token: TOKEN, expires_at: '2027-01-01T00:00:00Z' }, { status: 201 });
    }
    if (url.endsWith('/users/docent-builder%5Bbot%5D')) return Response.json(BOT);
    return Response.json({ message: 'Not Found' }, { status: 404 });
  };
  const deps: Deps = {
    fetch: fakeFetch as typeof fetch,
    env: {
      PATH: `${fakeBinaries()}:${process.env.PATH}`,
      FAKE_EXIT: String(opts.exit ?? 0),
      DOCENT_BUILDER_APP_KEY: Buffer.from(pem).toString('base64'),
    },
    log: (line) => logs.push(line),
    configPath,
    now: () => NOW,
  };
  const ran = () => readFileSync(join(dir, 'argv'), 'utf8').trim().split('\n');
  return { deps, calls, logs, ran };
}

/** The claims of the JWT a call was authorized with. */
function claims(call: Call | undefined) {
  const payload = (call?.auth ?? '').replace('Bearer ', '').split('.')[1] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString());
}

const VIEW = ['gh', 'pr', 'view', '3'];

describe('as-agent', () => {
  test('finds the app from its slug, signs a valid JWT, and gets an installation token', async () => {
    const { deps, calls } = setup();
    expect(await asAgent(['builder', '--', ...VIEW], deps)).toBe(0);

    const [app, installation, exchange, lookup] = calls;
    expect(app).toEqual({
      method: 'GET',
      url: 'https://api.github.com/apps/docent-builder',
      auth: '',
    });
    expect(installation?.url).toBe('https://api.github.com/repos/hartz89/docent/installation');
    expect(exchange?.method).toBe('POST');
    expect(exchange?.url).toBe('https://api.github.com/app/installations/222/access_tokens');
    expect(exchange?.auth).toBe(installation?.auth);
    const [header, payload, signature] = (exchange?.auth ?? '').replace('Bearer ', '').split('.');
    expect(
      verify(
        'sha256',
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature ?? '', 'base64url'),
      ),
    ).toBe(true);
    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    const jwt = claims(exchange);
    expect(jwt.iss).toBe('111');
    expect(jwt.iat).toBeLessThanOrEqual(NOW);
    expect(jwt.exp).toBeGreaterThan(NOW);
    expect(jwt.exp - jwt.iat).toBeLessThanOrEqual(600);

    expect(lookup?.url).toBe('https://api.github.com/users/docent-builder%5Bbot%5D');
    expect(lookup?.auth).toBe(`Bearer ${TOKEN}`);
  });

  test('uses an appId from the config instead of looking it up', async () => {
    const { deps, calls } = setup({ config: { builder: { slug: 'docent-builder', appId: 999 } } });
    expect(await asAgent(['builder', '--', ...VIEW], deps)).toBe(0);
    expect(calls.map((call) => call.url)).not.toContain(
      'https://api.github.com/apps/docent-builder',
    );
    expect(claims(calls[0]).iss).toBe('999');
  });

  test('suggests setting appId when GitHub hides a private app', async () => {
    const { deps, logs } = setup({ config: { builder: { slug: 'private-app' } } });
    expect(await asAgent(['builder', '--', ...VIEW], deps)).toBe(1);
    expect(logs[0]).toContain('GET /apps/private-app returned 404');
    expect(logs[0]).toContain('add its "appId"');
  });

  test('runs the command as the bot, with the token only in env', async () => {
    const { deps, logs, ran } = setup();
    expect(await asAgent(['builder', '--', 'git', 'push', '-u', 'origin', 'feat/x'], deps)).toBe(0);

    expect(ran()).toEqual(['git push -u origin feat/x']);
    expect(readFileSync(join(dir, 'probe.env'), 'utf8')).toContain(`GH_TOKEN=${TOKEN}\n`);
    expect(readFileSync(join(dir, 'probe.ident'), 'utf8')).toMatch(
      /^docent-builder\[bot\] <4242\+docent-builder\[bot\]@users\.noreply\.github\.com> /,
    );
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    expect(readFileSync(join(dir, 'probe.header'), 'utf8').trim()).toBe(
      `AUTHORIZATION: basic ${basic}`,
    );
    expect(logs).toEqual([]);
  });

  test('passes on the exit code of a failing command without printing the token', async () => {
    const { deps, logs } = setup({ exit: 3 });
    expect(await asAgent(['builder', '--', ...VIEW], deps)).toBe(3);
    expect(logs).toEqual(['as-agent: gh exited with 3']);
  });

  test('never prints the token when GitHub rejects a call', async () => {
    const { deps, logs } = setup({ fail: '/users/docent-builder%5Bbot%5D' });
    expect(await asAgent(['builder', '--', ...VIEW], deps)).toBe(1);
    expect(logs.join('\n')).toContain('returned 401');
    expect(logs.join('\n')).not.toContain(TOKEN);
  });

  test('explains what to do when the app is not set up yet', async () => {
    const { deps, calls, logs } = setup();
    expect(await asAgent(['reviewer', '--', ...VIEW], deps)).toBe(1);
    expect(calls).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("the reviewer GitHub App isn't set up yet");
    expect(logs[0]).toContain('its slug');
    expect(logs[0]).toContain('docs/process/agent-identities.md');
  });

  test('shows usage for a bad role or a missing --', async () => {
    const { deps, logs } = setup();
    expect(await asAgent(['admin', '--', ...VIEW], deps)).toBe(1);
    expect(await asAgent(['builder', ...VIEW], deps)).toBe(1);
    expect(logs.every((line) => line.startsWith('as-agent: usage:'))).toBe(true);
  });
});

describe('as-agent allowlist', () => {
  const refused: [string, string][] = [
    ['builder', 'git push --force origin feat/x'],
    ['builder', 'git push -f origin feat/x'],
    ['builder', 'git push -uf origin feat/x'],
    ['builder', 'git push --force-with-lease origin feat/x'],
    ['builder', 'git push origin +feat/x'],
    ['builder', 'git push origin feat/x:main'],
    ['builder', 'git push origin main'],
    ['builder', 'git push -u origin refs/heads/main'],
    ['builder', 'git push --delete origin feat/x'],
    ['builder', 'git push --mirror origin'],
    ['builder', 'gh pr merge 3 --squash --admin'],
    ['builder', 'gh pr merge 3 --merge'],
    ['builder', 'gh api -X POST /repos/hartz89/docent/pulls'],
    ['builder', 'gh api --method=DELETE /repos/hartz89/docent/git/refs/heads/x'],
    ['builder', 'gh api -XPATCH /repos/hartz89/docent'],
    ['builder', 'gh api /repos/hartz89/docent/issues -f title=x'],
    ['builder', 'gh api graphql --input query.json'],
    ['builder', 'gh repo delete hartz89/docent'],
    ['builder', 'rm -rf /'],
    ['reviewer', 'git push origin feat/x'],
    ['reviewer', 'gh pr merge 3 --squash'],
    ['reviewer', 'gh pr create --title x'],
  ];

  test.each(refused)('%s refuses: %s', async (role, command) => {
    const { deps, calls, logs } = setup();
    expect(await asAgent([role, '--', ...command.split(' ')], deps)).toBe(1);
    expect(calls).toEqual([]);
    expect(logs[0]).toContain(`refused "${command}"`);
    expect(logs[0]).toContain(`The ${role} may run:`);
  });

  const allowed = [
    'git push origin feat/x',
    'gh pr create --title x --body-file body.md',
    'gh pr merge 3 --squash',
    'gh api /repos/hartz89/docent/pulls -X GET --jq .[].number',
    'gh pr checks 3 --watch',
  ];

  test.each(allowed)('builder runs: %s', async (command) => {
    const { deps, ran } = setup();
    expect(await asAgent(['builder', '--', ...command.split(' ')], deps)).toBe(0);
    expect(ran()).toEqual([command]);
  });
});
