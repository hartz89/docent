import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, verify } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest';
import { asAgent, type Deps } from './as-agent.ts';

const NOW = 1_800_000_000;
const TOKEN = 'ghs_faketoken0123456789';
const BOT = { login: 'docent-builder[bot]', id: 4242 };
// The same lookup order as the runner.
const REAL_GIT =
  ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git'].find((path) =>
    existsSync(path),
  ) ?? 'git';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const KEY_ENV = Buffer.from(pem).toString('base64');

const filled = {
  builder: { slug: 'docent-builder' },
  reviewer: { slug: 'REPLACE_ME' },
};

/**
 * Fake `gh` and `git` binaries, found in place of the real ones. `git config` goes to real git
 * (the runner reads repo config with it). Anything else records its argv and what a real child
 * sees into the current test's dir, sources its extra.sh, and exits with the code in its exit file.
 * They're written once: macOS scans each new executable on first run, which costs ~150ms.
 */
const shared = mkdtempSync(join(tmpdir(), 'as-agent-bin-'));
const BIN = join(shared, 'bin');
mkdirSync(BIN);
const script = [
  '#!/bin/sh',
  `if [ "$(basename "$0")" = git ] && [ "$1" = config ]; then exec "${REAL_GIT}" "$@"; fi`,
  `dir="$(cat "${shared}/current")"`,
  'echo "$(basename "$0") $*" >> "$dir/argv"',
  'env > "$dir/probe.env"',
  `"${REAL_GIT}" var GIT_AUTHOR_IDENT > "$dir/probe.ident"`,
  `"${REAL_GIT}" config --get http.https://github.com/.extraheader > "$dir/probe.header"`,
  '. "$dir/extra.sh"',
  'exit "$(cat "$dir/exit")"',
].join('\n');
for (const name of ['gh', 'git']) writeFileSync(join(BIN, name), script, { mode: 0o755 });
afterAll(() => rmSync(shared, { recursive: true, force: true }));

const CLEAN_REPO = join(shared, 'repo');
execFileSync(REAL_GIT, ['init', '-q', CLEAN_REPO]);
execFileSync(REAL_GIT, [
  '-C',
  CLEAN_REPO,
  'remote',
  'add',
  'origin',
  'https://github.com/hartz89/docent.git',
]);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'as-agent-'));
  writeFileSync(join(shared, 'current'), dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Call = { method: string; url: string; auth: string; body: unknown };

function fakeBinaries(opts: { exit?: number; extra?: string }): string {
  writeFileSync(join(dir, 'extra.sh'), `${opts.extra ?? ''}\n`);
  writeFileSync(join(dir, 'exit'), String(opts.exit ?? 0));
  return BIN;
}

/** A fake GitHub API. `fail` makes one path answer with an error status. */
function setup(
  opts: { fail?: string; config?: object; exit?: number; extra?: string; cwd?: string } = {},
) {
  const configPath = join(dir, 'agent-apps.json');
  writeFileSync(configPath, JSON.stringify(opts.config ?? filled));
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? 'GET',
      url,
      auth: headers.get('authorization') ?? '',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
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
    if (url.endsWith('/installation/token')) return new Response(null, { status: 204 });
    return Response.json({ message: 'Not Found' }, { status: 404 });
  };
  const deps: Deps = {
    fetch: fakeFetch as typeof fetch,
    env: {
      HOME: process.env.HOME,
      PATH: `/caller/controlled/bin:${process.env.PATH}`,
      DOCENT_BUILDER_APP_KEY: KEY_ENV,
      GIT_TRACE: '1',
      GIT_CURL_VERBOSE: '1',
      GH_DEBUG: 'api',
      EDITOR: 'evil',
    },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    configPath,
    toolDirs: [fakeBinaries(opts)],
    // The fakes live in a user-owned temp dir; one test below checks the real ownership rule.
    trustTool: () => true,
    now: () => NOW,
  };
  // A clean repo by default, so the tests don't depend on how this checkout is configured.
  deps.cwd = opts.cwd ?? CLEAN_REPO;
  const ran = () => readFileSync(join(dir, 'argv'), 'utf8').trim().split('\n');
  const logs = () => err.join('').trim().split('\n');
  const printed = () => out.join('') + err.join('');
  return { deps, calls, logs, ran, printed };
}

/** The claims of the JWT a call was authorized with. */
function claims(call: Call | undefined) {
  const payload = (call?.auth ?? '').replace('Bearer ', '').split('.')[1] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString());
}

const VIEW = ['gh', 'pr', 'view', '3'];

describe('as-agent', () => {
  test('finds the app, signs a valid JWT, and gets a scoped installation token', async () => {
    const { deps, calls } = setup();
    expect(await asAgent(['builder', '--', ...VIEW], deps)).toBe(0);

    const [app, installation, exchange, lookup, revoke] = calls;
    expect(app).toMatchObject({ method: 'GET', url: 'https://api.github.com/apps/docent-builder' });
    expect(app?.auth).toBe('');
    expect(installation?.url).toBe('https://api.github.com/repos/hartz89/docent/installation');
    expect(exchange?.method).toBe('POST');
    expect(exchange?.url).toBe('https://api.github.com/app/installations/222/access_tokens');
    expect(exchange?.body).toEqual({
      repositories: ['docent'],
      permissions: { contents: 'write', pull_requests: 'write', checks: 'read' },
    });
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
    expect(revoke).toMatchObject({
      method: 'DELETE',
      url: 'https://api.github.com/installation/token',
      auth: `Bearer ${TOKEN}`,
    });
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
    expect(logs()[0]).toContain('GET /apps/private-app returned 404');
    expect(logs()[0]).toContain('add its "appId"');
  });

  test('runs the command as the bot, in a minimal env that holds no key', async () => {
    const { deps, logs, ran } = setup();
    expect(await asAgent(['builder', '--', 'git', 'push', '-u', 'origin', 'feat/x'], deps)).toBe(0);

    expect(ran()).toEqual(['git push -u origin refs/heads/feat/x:refs/heads/feat/x']);
    const env = readFileSync(join(dir, 'probe.env'), 'utf8');
    expect(env).toContain(`GH_TOKEN=${TOKEN}\n`);
    expect(env).toContain('GIT_CONFIG_GLOBAL=/dev/null\n');
    expect(env).toContain('GIT_TERMINAL_PROMPT=0\n');
    expect(env).toContain('PATH=/usr/bin:/bin\n');
    expect(env).toMatch(/GIT_CONFIG_KEY_\d=push\.recurseSubmodules\n/);
    expect(env).not.toContain(KEY_ENV);
    expect(env).not.toContain('DOCENT_BUILDER_APP_KEY');
    for (const leaked of ['GIT_TRACE', 'GIT_CURL_VERBOSE', 'GH_DEBUG', 'EDITOR', '/caller/']) {
      expect(env).not.toContain(leaked);
    }
    expect(readFileSync(join(dir, 'probe.ident'), 'utf8')).toMatch(
      /^docent-builder\[bot\] <4242\+docent-builder\[bot\]@users\.noreply\.github\.com> /,
    );
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    expect(readFileSync(join(dir, 'probe.header'), 'utf8').trim()).toBe(
      `AUTHORIZATION: basic ${basic}`,
    );
    expect(logs()).toEqual(['']);
  });

  test('runs git with hooks switched off', async () => {
    const repo = join(dir, 'repo');
    execFileSync(REAL_GIT, ['init', '-q', repo]);
    execFileSync(REAL_GIT, [
      '-C',
      repo,
      'remote',
      'add',
      'origin',
      'https://github.com/hartz89/docent.git',
    ]);
    const hook = join(repo, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, `#!/bin/sh\ntouch "${dir}/hook-ran"\n`, { mode: 0o755 });
    // The fake git commits instead of pushing: a hook that runs offline, with the runner's env.
    const { deps } = setup({ cwd: repo, extra: `"${REAL_GIT}" commit -q --allow-empty -m x` });
    expect(await asAgent(['builder', '--', 'git', 'push', 'origin', 'feat/x'], deps)).toBe(0);
    expect(execFileSync(REAL_GIT, ['-C', repo, 'log', '--format=%an'], { encoding: 'utf8' })).toBe(
      'docent-builder[bot]\n',
    );
    expect(existsSync(join(dir, 'hook-ran'))).toBe(false);
  });

  test.each([
    [['config', 'http.proxy', 'http://evil:8080'], 'http.proxy'],
    [['config', 'include.path', '/tmp/x'], 'include.path'],
    [['config', 'alias.push', '!evil'], 'alias.push'],
    [['config', 'core.sshCommand', 'evil'], 'core.sshcommand'],
    [['remote', 'add', 'origin', 'https://github.com/someone/else.git'], 'origin must be'],
  ])('refuses a repo whose git config sets %j', async (gitArgs, message) => {
    const repo = join(dir, 'repo');
    execFileSync(REAL_GIT, ['init', '-q', repo]);
    execFileSync(REAL_GIT, ['-C', repo, ...gitArgs]);
    const { deps, calls, logs } = setup({ cwd: repo });
    expect(await asAgent(['builder', '--', ...VIEW], deps)).toBe(1);
    expect(calls).toEqual([]);
    expect(logs()[0]).toContain(message);
  });

  test('checks worktree-scope git config too', async () => {
    const repo = join(dir, 'repo');
    execFileSync(REAL_GIT, ['init', '-q', repo]);
    execFileSync(REAL_GIT, ['-C', repo, 'config', 'extensions.worktreeConfig', 'true']);
    execFileSync(REAL_GIT, [
      '-C',
      repo,
      'config',
      '--worktree',
      'url.https://evil/.insteadOf',
      'x',
    ]);
    const { deps, calls, logs } = setup({ cwd: repo });
    expect(await asAgent(['builder', '--', ...VIEW], deps)).toBe(1);
    expect(calls).toEqual([]);
    expect(logs()[0]).toContain('git config sets url.https://evil/.insteadof');
  });

  test('refuses gh or git that a non-root user could replace', async () => {
    const { deps, calls, logs } = setup();
    delete deps.trustTool;
    expect(await asAgent(['builder', '--', ...VIEW], deps)).toBe(1);
    expect(calls).toEqual([]);
    expect(logs()[0]).toContain('gh must be installed in a root-owned location for as-agent');
  });

  test('on SIGTERM, kills the command, revokes the token and exits', async () => {
    const { deps, calls } = setup({ extra: `touch "${dir}/started"; exec sleep 5` });
    let exitCode: number | undefined;
    deps.exit = (code) => {
      exitCode = code;
    };
    const running = asAgent(['builder', '--', ...VIEW], deps);
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    while (!existsSync(join(dir, 'started')) && !settled) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(settled).toBe(false);
    process.emit('SIGTERM', 'SIGTERM');
    await running;
    expect(exitCode).toBe(143);
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
  });

  test('scrubs the token from what the command prints', async () => {
    const { deps, printed } = setup({
      extra:
        'echo "token=$GH_TOKEN"; echo "$GIT_CONFIG_VALUE_0" >&2; printf "no newline $GH_TOKEN"',
    });
    expect(await asAgent(['builder', '--', ...VIEW], deps)).toBe(0);
    expect(printed()).toContain('token=[redacted]');
    expect(printed()).toContain('no newline [redacted]');
    expect(printed()).not.toContain(TOKEN);
    expect(printed()).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString('base64'));
  });

  test('passes on a failing exit code, and still revokes the token', async () => {
    const { deps, logs, calls } = setup({ exit: 3 });
    expect(await asAgent(['builder', '--', ...VIEW], deps)).toBe(3);
    expect(logs()).toEqual(['as-agent: gh exited with 3']);
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', auth: `Bearer ${TOKEN}` });
  });

  test('never prints the token when GitHub rejects a call', async () => {
    const { deps, printed, calls } = setup({ fail: '/users/docent-builder%5Bbot%5D' });
    expect(await asAgent(['builder', '--', ...VIEW], deps)).toBe(1);
    expect(printed()).toContain('returned 401');
    expect(printed()).not.toContain(TOKEN);
    expect(calls.at(-1)?.method).toBe('DELETE');
  });

  test('explains what to do when the app is not set up yet', async () => {
    const { deps, calls, logs } = setup();
    expect(await asAgent(['reviewer', '--', ...VIEW], deps)).toBe(1);
    expect(calls).toEqual([]);
    expect(logs()).toHaveLength(1);
    expect(logs()[0]).toContain("the reviewer GitHub App isn't set up yet");
    expect(logs()[0]).toContain('docs/process/agent-identities.md');
  });

  test('shows usage for a bad role or a missing --', async () => {
    const { deps, logs } = setup();
    expect(await asAgent(['admin', '--', ...VIEW], deps)).toBe(1);
    expect(await asAgent(['builder', ...VIEW], deps)).toBe(1);
    expect(logs().filter((line) => line.startsWith('as-agent: '))).toEqual([
      expect.stringContaining('usage:'),
      expect.stringContaining('usage:'),
    ]);
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
    ['builder', 'git push origin heads/main'],
    ['builder', 'git push origin HEAD'],
    ['builder', 'git push origin @'],
    ['builder', 'git push -u origin refs/heads/main'],
    ['builder', 'git push origin refs/heads/feat/x'],
    ['builder', 'git push --delete origin feat/x'],
    ['builder', 'git push --mirror origin'],
    ['builder', 'gh pr merge 3 --squash --admin'],
    ['builder', 'gh pr merge 3 --merge'],
    ['builder', 'gh pr merge 3 --squash --auto --admin'],
    ['builder', 'gh pr merge 3 --auto'],
    ['builder', 'gh pr merge 3 --auto --merge'],
    ['builder', 'gh pr merge 3 --auto --rebase'],
    ['builder', 'gh pr merge 3 --squash --auto --body x'],
    ['builder', 'gh pr merge 3 --squash --auto --delete-branch'],
    ['builder', 'gh pr merge 3 --squash --auto --auto'],
    ['builder', 'gh pr merge 3 4 --squash --auto'],
    ['builder', 'gh api -X POST /repos/hartz89/docent/pulls'],
    ['builder', 'gh api --method=DELETE /repos/hartz89/docent/git/refs/heads/x'],
    ['builder', 'gh api -XPATCH /repos/hartz89/docent'],
    ['builder', 'gh api /repos/hartz89/docent/issues -f title=x'],
    ['builder', 'gh api /repos/hartz89/docent/issues -F'],
    ['builder', 'gh api /repos/hartz89/docent/issues --field=title=x'],
    ['builder', 'gh api graphql --input query.json'],
    ['builder', 'gh api graphql --input=query.json'],
    ['builder', 'gh api /repos/hartz89/docent --jq --method=POST'],
    ['builder', 'gh api /user --jq $ENV.GH_TOKEN|@base64'],
    ['builder', 'gh api /user -q .login'],
    ['builder', 'gh api /user -q.login'],
    ['builder', 'gh api /user --jq=.login'],
    ['builder', 'gh pr view 3 --json title --template {{.title}}'],
    ['builder', 'gh pr view 3 --json title -t x'],
    ['builder', 'gh pr view 3 --json title --template=x'],
    ['builder', 'gh pr create --web'],
    ['builder', 'gh pr create -w'],
    ['builder', 'gh pr edit 3 --editor'],
    ['builder', 'gh pr comment 3 -e'],
    ['reviewer', 'gh pr review 3 --web'],
    ['reviewer', 'gh pr view 3 --json body --jq .body'],
    ['builder', 'gh repo delete hartz89/docent'],
    ['builder', 'rm -rf /'],
    ['reviewer', 'git push origin feat/x'],
    ['reviewer', 'gh pr merge 3 --squash'],
    ['reviewer', 'gh pr merge 3 --squash --auto'],
    ['reviewer', 'gh pr create --title x'],
  ];

  test.each(refused)('%s refuses: %s', async (role, command) => {
    const { deps, calls, logs } = setup();
    expect(await asAgent([role, '--', ...command.split(' ')], deps)).toBe(1);
    expect(calls).toEqual([]);
    expect(logs()[0]).toContain(`refused "${command}"`);
    expect(logs().join('\n')).toContain(`The ${role} may run:`);
  });

  const allowed: [string, string][] = [
    ['git push origin feat/x', 'git push origin refs/heads/feat/x:refs/heads/feat/x'],
    ['gh pr create --title x --body-file body.md', 'gh pr create --title x --body-file body.md'],
    ['gh pr merge 3 --squash', 'gh pr merge 3 --squash'],
    ['gh pr merge 3 --squash --auto', 'gh pr merge 3 --squash --auto'],
    [
      'gh api /repos/hartz89/docent/pulls -X GET --paginate',
      'gh api /repos/hartz89/docent/pulls -X GET --paginate',
    ],
  ];

  test.each(allowed)('builder runs: %s', async (command, expected) => {
    const { deps, ran } = setup();
    expect(await asAgent(['builder', '--', ...command.split(' ')], deps)).toBe(0);
    expect(ran()).toEqual([expected]);
  });
});
