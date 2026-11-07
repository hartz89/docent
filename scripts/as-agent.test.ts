import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { asAgent, type Deps } from './as-agent.ts';

const NOW = 1_800_000_000;
const TOKEN = 'ghs_faketoken0123456789';
const BOT = { login: 'docent-builder[bot]', id: 4242 };

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

/** A fake GitHub API. `fail` makes one path answer with an error status. */
function setup(opts: { fail?: string; config?: object } = {}) {
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
    env: { PATH: process.env.PATH, DOCENT_BUILDER_APP_KEY: Buffer.from(pem).toString('base64') },
    log: (line) => logs.push(line),
    configPath,
    now: () => NOW,
  };
  return { deps, calls, logs };
}

/** A command that records what a real child process sees: its env, git identity and git config. */
function probe(out: string): string[] {
  return [
    'sh',
    '-c',
    `env > "${out}.env"; git var GIT_AUTHOR_IDENT > "${out}.ident"; git config --get http.https://github.com/.extraheader > "${out}.header"`,
  ];
}

/** The claims of the JWT a call was authorized with. */
function claims(call: Call | undefined) {
  const payload = (call?.auth ?? '').replace('Bearer ', '').split('.')[1] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString());
}

describe('as-agent', () => {
  test('finds the app from its slug, signs a valid JWT, and gets an installation token', async () => {
    const { deps, calls } = setup();
    expect(await asAgent(['builder', '--', 'true'], deps)).toBe(0);

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
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString());
    expect(claims.iss).toBe('111');
    expect(claims.iat).toBeLessThanOrEqual(NOW);
    expect(claims.exp).toBeGreaterThan(NOW);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);

    expect(lookup?.url).toBe('https://api.github.com/users/docent-builder%5Bbot%5D');
    expect(lookup?.auth).toBe(`Bearer ${TOKEN}`);
  });

  test('uses an appId from the config instead of looking it up', async () => {
    const { deps, calls } = setup({ config: { builder: { slug: 'docent-builder', appId: 999 } } });
    expect(await asAgent(['builder', '--', 'true'], deps)).toBe(0);
    expect(calls.map((call) => call.url)).not.toContain(
      'https://api.github.com/apps/docent-builder',
    );
    expect(claims(calls[0]).iss).toBe('999');
  });

  test('suggests setting appId when GitHub hides a private app', async () => {
    const { deps, logs } = setup({ config: { builder: { slug: 'private-app' } } });
    expect(await asAgent(['builder', '--', 'true'], deps)).toBe(1);
    expect(logs[0]).toContain('GET /apps/private-app returned 404');
    expect(logs[0]).toContain('add its "appId"');
  });

  test('runs the command as the bot, with the token only in env', async () => {
    const { deps, logs } = setup();
    const out = join(dir, 'probe');
    expect(await asAgent(['builder', '--', ...probe(out)], deps)).toBe(0);

    const env = readFileSync(`${out}.env`, 'utf8');
    expect(env).toContain(`GH_TOKEN=${TOKEN}\n`);
    expect(readFileSync(`${out}.ident`, 'utf8')).toMatch(
      /^docent-builder\[bot\] <4242\+docent-builder\[bot\]@users\.noreply\.github\.com> /,
    );
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    expect(readFileSync(`${out}.header`, 'utf8').trim()).toBe(`AUTHORIZATION: basic ${basic}`);
    expect(logs).toEqual([]);
  });

  test('passes on the exit code of a failing command without printing the token', async () => {
    const { deps, logs } = setup();
    expect(await asAgent(['builder', '--', 'sh', '-c', 'exit 3'], deps)).toBe(3);
    expect(logs).toEqual(['as-agent: sh exited with 3']);
  });

  test('never prints the token when GitHub rejects a call', async () => {
    const { deps, logs } = setup({ fail: '/users/docent-builder%5Bbot%5D' });
    expect(await asAgent(['builder', '--', 'true'], deps)).toBe(1);
    expect(logs.join('\n')).toContain('returned 401');
    expect(logs.join('\n')).not.toContain(TOKEN);
  });

  test('explains what to do when the app is not set up yet', async () => {
    const { deps, calls, logs } = setup();
    expect(await asAgent(['reviewer', '--', 'true'], deps)).toBe(1);
    expect(calls).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("the reviewer GitHub App isn't set up yet");
    expect(logs[0]).toContain('its slug');
    expect(logs[0]).toContain('docs/process/agent-identities.md');
  });

  test('shows usage for a bad role or a missing --', async () => {
    const { deps, logs } = setup();
    expect(await asAgent(['admin', '--', 'true'], deps)).toBe(1);
    expect(await asAgent(['builder', 'true'], deps)).toBe(1);
    expect(logs.every((line) => line.startsWith('as-agent: usage:'))).toBe(true);
  });
});
