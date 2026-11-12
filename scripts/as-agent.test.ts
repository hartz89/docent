import { execFileSync, spawn } from 'node:child_process';
import { generateKeyPairSync, verify } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest';
import { asAgent, type Deps, keyEnvName, ROLES } from './as-agent.ts';

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
/** Every role's key variable, so no role's test can fall through to the Keychain. */
const KEYS = Object.fromEntries(ROLES.map((role) => [keyEnvName(role), KEY_ENV]));
/** Tests never read the real Keychain: a test that needs it stubs this hook itself. */
const noKeychain = (service: string): never => {
  throw new Error(`a test reached the real Keychain for ${service}; stub deps.keychain`);
};

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
      ...KEYS,
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
    keychain: noKeychain,
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
    // A path that can't exist: an include of a real file would list that file's keys instead.
    [['config', 'include.path', '<dir>/never-created'], 'include.path'],
    [['config', 'alias.push', '!evil'], 'alias.push'],
    [['config', 'core.sshCommand', 'evil'], 'core.sshcommand'],
    [['remote', 'add', 'origin', 'https://github.com/someone/else.git'], 'origin must be'],
  ])('refuses a repo whose git config sets %j', async (gitArgs, message) => {
    const repo = join(dir, 'repo');
    execFileSync(REAL_GIT, ['init', '-q', repo]);
    execFileSync(REAL_GIT, ['-C', repo, ...gitArgs.map((arg) => arg.replace('<dir>', dir))]);
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

  test('reads the key from the Keychain when no key variable is set', async () => {
    const { deps } = setup();
    delete deps.env[keyEnvName('builder')];
    const asked: string[] = [];
    deps.keychain = (service) => {
      asked.push(service);
      return KEY_ENV;
    };
    expect(await asAgent(['builder', '--', ...VIEW], deps)).toBe(0);
    expect(asked).toEqual(['docent-builder-app-key']);
  });

  test('says where to put the key when neither the env nor the Keychain has it', async () => {
    const { deps, calls, logs } = setup();
    delete deps.env[keyEnvName('builder')];
    deps.keychain = () => undefined;
    expect(await asAgent(['builder', '--', ...VIEW], deps)).toBe(1);
    expect(calls).toEqual([]);
    expect(logs()[0]).toContain(
      `no private key for the builder app: set ${keyEnvName('builder')}, or store it in the ` +
        'macOS Keychain as "docent-builder-app-key"',
    );
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
    ['builder', 'gh issue delete 4'],
    ['builder', 'gh issue transfer 4 other/repo'],
    ['builder', 'gh issue create --web'],
    ['builder', 'gh issue comment 4 -e'],
    ['builder', 'gh issue view 4 --json body --jq .body'],
    ['reviewer', 'gh issue create --title x'],
    // Agents never approve, in any spelling, as either role.
    ['reviewer', 'gh pr review 3 --approve'],
    ['reviewer', 'gh pr review 3 --approve=true'],
    ['reviewer', 'gh pr review 3 -a'],
    ['reviewer', 'gh pr review 3 -ab lgtm'],
    ['reviewer', 'gh pr review 3 --comment -cab x'],
    ['builder', 'gh pr review 3 --approve'],
    ['builder', 'gh pr review 3 -a'],
    // gh accepts -w bundled with other short flags, so -wl opens a browser too.
    ['builder', 'gh issue create --title x -wl bug'],
    ['builder', 'gh pr create --title x -wl bug'],
  ];

  test.each(refused)('%s refuses: %s', async (role, command) => {
    const { deps, calls, logs } = setup();
    expect(await asAgent([role, '--', ...command.split(' ')], deps)).toBe(1);
    expect(calls).toEqual([]);
    expect(logs()[0]).toContain(`refused "${command}"`);
    expect(logs().join('\n')).toContain(`The ${role} may run:`);
  });

  test('refuses to approve a PR, and says to post a comment instead', async () => {
    const { deps, calls, logs } = setup({ config: { reviewer: { slug: 'docent-builder' } } });
    expect(await asAgent(['reviewer', '--', 'gh', 'pr', 'review', '3', '--approve'], deps)).toBe(1);
    expect(calls).toEqual([]);
    expect(logs()[0]).toContain('--approve approves the PR, and agents never approve');

    const ok = setup({ config: { reviewer: { slug: 'docent-builder' } } });
    const review = ['gh', 'pr', 'review', '3', '--comment', '--body-file', 'review.md'];
    expect(await asAgent(['reviewer', '--', ...review], ok.deps)).toBe(0);
    expect(ok.ran()).toEqual([review.join(' ')]);
  });

  const allowed: [string, string][] = [
    ['git push origin feat/x', 'git push origin refs/heads/feat/x:refs/heads/feat/x'],
    ['gh pr create --title x --body short', 'gh pr create --title x --body short'],
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

  // Issues access is requested only for the commands that need it, so every other command keeps
  // working on an app that hasn't been granted the Issues permission.
  const scoped: [string, Record<string, string>][] = [
    ['gh issue create --title x --label backlog', { issues: 'write' }],
    ['gh issue edit 4 --add-label backlog', { issues: 'write' }],
    ['gh issue edit 4 --remove-label backlog', { issues: 'write' }],
    ['gh issue comment 4 --body-file triage.md', { issues: 'write' }],
    ['gh issue list --label backlog', { issues: 'read' }],
    ['gh issue view 4', { issues: 'read' }],
    ['gh api /repos/hartz89/docent/issues/4/comments', { issues: 'read' }],
    ['gh pr view 3', {}],
    ['gh api /repos/hartz89/docent/pulls', {}],
  ];

  test.each(scoped)('builder token for "%s" adds %o', async (command, extra) => {
    const { deps, calls, ran } = setup();
    expect(await asAgent(['builder', '--', ...command.split(' ')], deps)).toBe(0);
    expect(ran()).toEqual([command]);
    const exchange = calls.find((call) => call.url.endsWith('/access_tokens'));
    expect(exchange?.body).toEqual({
      repositories: ['docent'],
      permissions: { contents: 'write', pull_requests: 'write', checks: 'read', ...extra },
    });
  });
});

describe('as-agent review and reply forms', () => {
  const REVIEWS = '/repos/hartz89/docent/pulls/7/reviews';
  const REPLIES = '/repos/hartz89/docent/pulls/7/comments/123/replies';
  const review = {
    body: 'Verdict: fix two things.',
    event: 'COMMENT',
    commit_id: 'a'.repeat(40),
    comments: [
      { path: 'scripts/as-agent.ts', line: 12, side: 'RIGHT', body: '**Bug · must-fix:** x' },
      { path: 'a.ts', start_line: 3, start_side: 'RIGHT', line: 5, side: 'RIGHT', body: 'y' },
    ],
  };
  const reviewerConfig = { ...filled, reviewer: { slug: 'docent-builder' } };
  const comment = (extra: object) => ({
    ...review,
    comments: [{ path: 'a', line: 1, body: 'x', ...extra }],
  });

  /** Writes the JSON body to a file and returns the command that posts it. */
  function post(endpoint: string, body: unknown): string[] {
    const path = join(dir, 'body.json');
    writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
    return ['gh', 'api', '--method', 'POST', endpoint, '--input', path];
  }

  test('the reviewer posts a review: gh reads the checked JSON on stdin', async () => {
    const { deps, ran } = setup({ config: reviewerConfig, extra: `cat > "${dir}/stdin"` });
    expect(await asAgent(['reviewer', '--', ...post(REVIEWS, review)], deps)).toBe(0);
    expect(ran()).toEqual([`gh api --method POST ${REVIEWS} --input -`]);
    expect(JSON.parse(readFileSync(join(dir, 'stdin'), 'utf8'))).toEqual(review);
  });

  test('the builder replies to a review comment', async () => {
    const { deps, ran } = setup({ extra: `cat > "${dir}/stdin"` });
    const reply = { body: 'Fixed in abc1234.' };
    expect(await asAgent(['builder', '--', ...post(REPLIES, reply)], deps)).toBe(0);
    expect(ran()).toEqual([`gh api --method POST ${REPLIES} --input -`]);
    expect(JSON.parse(readFileSync(join(dir, 'stdin'), 'utf8'))).toEqual(reply);
  });

  test('sends the bytes it checked, even if the file changes after', async () => {
    // The fake gh rewrites the file before reading stdin, as a racing agent might.
    const command = post(REVIEWS, review);
    const evil = JSON.stringify({ ...review, event: 'APPROVE', extra: 1 });
    const { deps } = setup({
      config: reviewerConfig,
      extra: `printf '%s' '${evil}' > "${command[6]}"; cat > "${dir}/stdin"`,
    });
    expect(await asAgent(['reviewer', '--', ...command], deps)).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'stdin'), 'utf8'))).toEqual(review);
  });

  test('reads a relative input path from the working directory', async () => {
    const repo = join(dir, 'repo');
    execFileSync(REAL_GIT, ['init', '-q', repo]);
    writeFileSync(join(repo, 'reply.json'), JSON.stringify({ body: 'Fixed in abc1234.' }));
    const { deps } = setup({ cwd: repo, extra: `cat > "${dir}/stdin"` });
    const command = ['gh', 'api', '--method', 'POST', REPLIES, '--input', 'reply.json'];
    expect(await asAgent(['builder', '--', ...command], deps)).toBe(0);
    expect(readFileSync(join(dir, 'stdin'), 'utf8')).toBe('{"body":"Fixed in abc1234."}');
  });

  test('passes on the exit code when gh fails without reading the body', async () => {
    const { deps, calls } = setup({ config: reviewerConfig, exit: 1 });
    const big = { ...review, body: 'x'.repeat(900_000) };
    expect(await asAgent(['reviewer', '--', ...post(REVIEWS, big)], deps)).toBe(1);
    expect(calls.at(-1)?.method).toBe('DELETE');
  });

  test('sends one value per key, so a duplicate key cannot hide an unchecked one', async () => {
    const { deps } = setup({ extra: `cat > "${dir}/stdin"` });
    const command = post(REPLIES, '{"body": "first", "body": "second"}');
    expect(await asAgent(['builder', '--', ...command], deps)).toBe(0);
    expect(readFileSync(join(dir, 'stdin'), 'utf8')).toBe('{"body":"second"}');
  });

  const badReviews: [string, unknown, string][] = [
    ['an unknown top-level key', { ...review, path: 'x' }, 'may not have "path"'],
    ['a missing event', { body: 'x' }, 'needs "event"'],
    ['a pending event', { ...review, event: 'PENDING' }, 'bad "event"'],
    ['a lowercase event', { ...review, event: 'comment' }, 'bad "event"'],
    ['an approval: agents never approve', { ...review, event: 'APPROVE' }, 'bad "event"'],
    ['a short commit_id', { ...review, commit_id: 'abc' }, 'bad "commit_id"'],
    ['a non-string body', { ...review, body: 1 }, 'bad "body"'],
    ['comments that are not a list', { ...review, comments: {} }, 'bad "comments"'],
    ['an unknown comment key', comment({ position: 2 }), 'may not have "position"'],
    ['a comment with no line', comment({ line: undefined }), 'needs "line"'],
    ['a comment with a string line', comment({ line: '1' }), 'bad "line"'],
    ['a comment with line 0', comment({ line: 0 }), 'bad "line"'],
    ['a comment with a fractional line', comment({ line: 1.5 }), 'bad "line"'],
    ['a comment with a bad side', comment({ side: 'UP' }), 'bad "side"'],
    ['a comment with an empty path', comment({ path: '' }), 'bad "path"'],
    ['a comment that is not an object', { ...review, comments: ['x'] }, 'must be a JSON object'],
    ['a __proto__ key', '{"event":"COMMENT","__proto__":{"x":1}}', 'may not have "__proto__"'],
    ['a list', [review], 'must be a JSON object'],
    ['invalid JSON', '{"event":', "isn't valid JSON"],
  ];

  test.each(badReviews)('refuses a review with %s', async (_, body, reason) => {
    const { deps, calls, logs } = setup({ config: reviewerConfig });
    expect(await asAgent(['reviewer', '--', ...post(REVIEWS, body)], deps)).toBe(1);
    expect(calls).toEqual([]);
    expect(logs()[0]).toContain(reason);
  });

  test.each([
    ['an extra key', { body: 'x', in_reply_to: 1 }, 'may not have "in_reply_to"'],
    ['no body', {}, 'needs "body"'],
    ['a non-string body', { body: ['x'] }, 'bad "body"'],
  ])('refuses a reply with %s', async (_, body, reason) => {
    const { deps, calls, logs } = setup();
    expect(await asAgent(['builder', '--', ...post(REPLIES, body)], deps)).toBe(1);
    expect(calls).toEqual([]);
    expect(logs()[0]).toContain(reason);
  });

  const ENDPOINT = "can't POST to";
  const SHAPE = 'gh api --input only as';
  /** gh api arguments around a valid body file, so only the command's shape is wrong. */
  const shapes: [string, string, (file: string) => string[], string][] = [
    [
      'reviewer',
      'another repo',
      (f) => ['--method', 'POST', '/repos/evil/docent/pulls/7/reviews', '--input', f],
      ENDPOINT,
    ],
    [
      'reviewer',
      'an {owner} placeholder',
      (f) => ['--method', 'POST', 'repos/{owner}/{repo}/pulls/7/reviews', '--input', f],
      ENDPOINT,
    ],
    [
      'reviewer',
      'a query string',
      (f) => ['--method', 'POST', `${REVIEWS}?x=1`, '--input', f],
      ENDPOINT,
    ],
    [
      'reviewer',
      'a full URL',
      (f) => ['--method', 'POST', `https://api.github.com${REVIEWS}`, '--input', f],
      ENDPOINT,
    ],
    [
      'reviewer',
      'a dot segment',
      (f) => [
        '--method',
        'POST',
        '/repos/hartz89/docent/pulls/7/../../issues/7/comments',
        '--input',
        f,
      ],
      ENDPOINT,
    ],
    [
      'reviewer',
      'pull 0',
      (f) => ['--method', 'POST', '/repos/hartz89/docent/pulls/0/reviews', '--input', f],
      ENDPOINT,
    ],
    [
      'reviewer',
      'a review events endpoint',
      (f) => ['--method', 'POST', `${REVIEWS}/1/events`, '--input', f],
      ENDPOINT,
    ],
    [
      'reviewer',
      'the reply endpoint',
      (f) => ['--method', 'POST', REPLIES, '--input', f],
      ENDPOINT,
    ],
    ['reviewer', 'PUT', (f) => ['--method', 'PUT', REVIEWS, '--input', f], SHAPE],
    ['reviewer', 'a lowercase post', (f) => ['--method', 'post', REVIEWS, '--input', f], SHAPE],
    ['reviewer', '-X POST', (f) => ['-X', 'POST', REVIEWS, '--input', f], SHAPE],
    ['reviewer', '--method=POST', (f) => ['--method=POST', REVIEWS, '--input', f], SHAPE],
    [
      'reviewer',
      '--input=',
      (f) => ['--method', 'POST', REVIEWS, `--input=${f}`],
      'gh api method POST',
    ],
    ['reviewer', 'the endpoint first', (f) => [REVIEWS, '--method', 'POST', '--input', f], SHAPE],
    [
      'reviewer',
      'an extra -f',
      (f) => ['--method', 'POST', REVIEWS, '--input', f, '-f', 'event=APPROVE'],
      SHAPE,
    ],
    [
      'reviewer',
      'an extra -F',
      (f) => ['--method', 'POST', REVIEWS, '--input', f, '-F', 'x=@/etc/passwd'],
      SHAPE,
    ],
    [
      'reviewer',
      'an extra --raw-field',
      (f) => ['--method', 'POST', REVIEWS, '--input', f, '--raw-field', 'x=y'],
      SHAPE,
    ],
    [
      'reviewer',
      'a method override header',
      (f) => ['--method', 'POST', REVIEWS, '--input', f, '-H', 'X-HTTP-Method-Override: DELETE'],
      SHAPE,
    ],
    [
      'reviewer',
      '--hostname',
      (f) => ['--method', 'POST', REVIEWS, '--input', f, '--hostname', 'evil.example'],
      SHAPE,
    ],
    [
      'reviewer',
      'two inputs',
      (f) => ['--method', 'POST', REVIEWS, '--input', f, '--input', f],
      SHAPE,
    ],
    [
      'reviewer',
      'stdin as the input',
      () => ['--method', 'POST', REVIEWS, '--input', '-'],
      '--input needs a file',
    ],
    [
      'reviewer',
      'no input file',
      () => ['--method', 'POST', REVIEWS, '--input'],
      '--input needs a file',
    ],
    [
      'reviewer',
      '--jq',
      (f) => ['--method', 'POST', REVIEWS, '--input', f, '--jq', '.'],
      'scrubber',
    ],
    [
      'builder',
      'the review endpoint',
      (f) => ['--method', 'POST', REVIEWS, '--input', f],
      ENDPOINT,
    ],
    [
      'builder',
      'another repo',
      (f) => ['--method', 'POST', '/repos/evil/docent/pulls/7/comments/1/replies', '--input', f],
      ENDPOINT,
    ],
    [
      'builder',
      'a new review comment',
      (f) => ['--method', 'POST', '/repos/hartz89/docent/pulls/7/comments', '--input', f],
      ENDPOINT,
    ],
    [
      'builder',
      'an issue comment',
      (f) => ['--method', 'POST', '/repos/hartz89/docent/issues/7/comments', '--input', f],
      ENDPOINT,
    ],
  ];

  test.each(shapes)('%s refuses %s', async (role, _, build, reason) => {
    const file = join(dir, 'body.json');
    writeFileSync(file, JSON.stringify(role === 'reviewer' ? review : { body: 'x' }));
    const { deps, calls, logs } = setup({ config: reviewerConfig });
    expect(await asAgent([role, '--', 'gh', 'api', ...build(file)], deps)).toBe(1);
    expect(calls).toEqual([]);
    expect(logs()[0]).toContain(reason);
  });

  test('refuses an input that is not a regular file, without hanging on it', async () => {
    const fifo = join(dir, 'fifo');
    execFileSync('/usr/bin/mkfifo', [fifo]);
    const { deps, calls, logs } = setup({ config: reviewerConfig });
    const command = ['gh', 'api', '--method', 'POST', REVIEWS, '--input'];
    for (const path of [fifo, dir, join(dir, 'missing.json')]) {
      expect(await asAgent(['reviewer', '--', ...command, path], deps)).toBe(1);
    }
    expect(calls).toEqual([]);
    expect(logs().filter((line) => /isn't a regular file|couldn't read/.test(line))).toHaveLength(
      3,
    );
  });

  test('refuses an oversized input', async () => {
    const { deps, calls, logs } = setup({ config: reviewerConfig });
    const big = { ...review, body: 'x'.repeat(1_000_001) };
    expect(await asAgent(['reviewer', '--', ...post(REVIEWS, big)], deps)).toBe(1);
    expect(calls).toEqual([]);
    expect(logs()[0]).toContain('is over 1000000 bytes');
  });
});

describe('as-agent PR descriptions', () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
  /** Writes a description file and returns its path. */
  function description(text: string): string {
    const path = join(dir, 'body.md');
    writeFileSync(path, text);
    return path;
  }

  test('refuses a description over the budget, and says to move detail into <details>', async () => {
    const { deps, calls, logs } = setup();
    const file = description(`## Intent\n\n${words(349)}\n`);
    const command = ['gh', 'pr', 'create', '--title', 'x', '--body-file', file];
    expect(await asAgent(['builder', '--', ...command], deps)).toBe(1);
    expect(calls).toEqual([]);
    expect(logs()[0]).toContain('has 351 visible words, over the limit of 350');
    expect(logs()[0]).toContain('about 300 visible words');
    expect(logs()[0]).toContain('collapsed <details> sections');
  });

  test('counts only what sits outside <details>', async () => {
    const { deps, ran } = setup();
    const hidden = `<details>\n<summary>Known gaps</summary>\n\n${words(2000)}\n</details>`;
    const file = description(`${words(300)}\n\n${hidden}\n\n${words(40)}`);
    const command = ['gh', 'pr', 'create', '--title', 'x', '--body-file', file];
    expect(await asAgent(['builder', '--', ...command], deps)).toBe(0);
    expect(ran()).toEqual([command.join(' ')]);
  });

  test('counts a <details> tag written as code, since it hides nothing', async () => {
    const { deps, logs } = setup();
    const file = description(`Put gaps in \`<details>\`.\n\n${words(400)}\n\n\`</details>\``);
    const command = ['gh', 'pr', 'create', '--body-file', file];
    expect(await asAgent(['builder', '--', ...command], deps)).toBe(1);
    expect(logs()[0]).toContain('over the limit of 350');
  });

  test.each([
    ['gh pr edit 3 --body <long>', ['edit', '3', '--body', words(400)]],
    ['gh pr edit 3 --body=<long>', ['edit', '3', `--body=${words(400)}`]],
    ['gh pr create -dF <long file>', ['create', '-dF', '<file>']],
    ['gh pr create --body-file=<long file>', ['create', '--body-file=<file>']],
    // gh would read "--body" as the title and send the file; the runner checks the file anyway.
    [
      'gh pr create --title --body --body-file <long file>',
      ['create', '--title', '--body', '--body-file', '<file>'],
    ],
  ])('refuses a long description however it is passed: %s', async (_, args) => {
    const { deps, calls, logs } = setup();
    const file = description(words(400));
    const command = ['gh', 'pr', ...args.map((arg) => arg.replace('<file>', file))];
    expect(await asAgent(['builder', '--', ...command], deps)).toBe(1);
    expect(calls).toEqual([]);
    expect(logs()[0]).toContain('400 visible words');
  });

  test.each([
    ['no description', ['create', '--title', 'x'], 'needs --body-file'],
    ['a description on stdin', ['create', '--body-file', '-'], 'needs a file path'],
  ])('refuses a create with %s, since it cannot check it', async (_, args, reason) => {
    const { deps, calls, logs } = setup();
    expect(await asAgent(['builder', '--', 'gh', 'pr', ...args], deps)).toBe(1);
    expect(calls).toEqual([]);
    expect(logs()[0]).toContain(reason);
  });
});

describe('as-agent as a process', () => {
  /**
   * The real runner, launched the way agents launch it, with nothing real behind it. The key is
   * the throwaway one above. A preload swaps the global fetch for one that only reaches a fake
   * GitHub on localhost, so the runner itself is unchanged. The command is a real git push, but
   * "origin" isn't configured, so git reads it as a local path, refuses that transport, and exits
   * 128 without touching the network.
   */
  async function launch(command: string[]) {
    const calls: string[] = [];
    const server = createServer((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      const reply = (status: number, body?: object) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body && JSON.stringify(body));
      };
      if (req.url === '/repos/hartz89/docent/installation') reply(200, { id: 222 });
      else if (req.url === '/app/installations/222/access_tokens') reply(201, { token: TOKEN });
      else if (req.url?.startsWith('/users/')) reply(200, BOT);
      else if (req.url === '/installation/token') reply(204);
      else reply(404, { message: 'Not Found' });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const preload = join(dir, 'fake-github.mjs');
    writeFileSync(
      preload,
      [
        'const real = globalThis.fetch;',
        'globalThis.fetch = (input, init) => {',
        '  const url = String(input);',
        "  const api = 'https://api.github.com/';",
        '  if (!url.startsWith(api)) throw new Error("test refuses to fetch " + url);',
        `  return real('http://127.0.0.1:${port}/' + url.slice(api.length), init);`,
        '};',
      ].join('\n'),
    );
    const repo = join(dir, 'repo');
    // A repo with branch x, made without the developer's git config (signing, hooks and the like).
    const git = (args: string[]) =>
      execFileSync(REAL_GIT, args, {
        env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      });
    git(['init', '-q', '-b', 'x', repo]);
    const who = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];
    git(['-C', repo, ...who, 'commit', '-q', '--allow-empty', '-m', 'x']);
    const runner = join(import.meta.dirname, 'as-agent.ts');
    const child = spawn(process.execPath, ['--import', preload, runner, ...command], {
      cwd: repo,
      env: { HOME: dir, PATH: '/usr/bin:/bin', DOCENT_BUILDER_APP_KEY: pem },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Under vitest's own 5s limit, so a hung runner is killed rather than left behind. SIGKILL,
      // because the runner catches SIGTERM and would wait on a hung revoke.
      timeout: 4_000,
      killSignal: 'SIGKILL',
    });
    // Whoever reads the output goes away at once, as `| head` does after its lines.
    child.stdout.destroy();
    child.stderr.destroy();
    try {
      const [code, signal] = await once(child, 'close');
      return { code, signal, calls };
    } finally {
      server.close();
    }
  }

  test('revokes the token and exits normally when its output reader closes early', async () => {
    const { code, signal, calls } = await launch(['builder', '--', 'git', 'push', 'origin', 'x']);
    // git's own exit code. A crash on the closed pipe would exit 1, before the revoke.
    expect({ code, signal }).toEqual({ code: 128, signal: null });
    // The runner reads the real .github/agent-apps.json: its appId skips the /apps lookup, and
    // its slug names the bot.
    expect(calls).toEqual([
      'GET /repos/hartz89/docent/installation',
      'POST /app/installations/222/access_tokens',
      'GET /users/docent-builder-hartz89%5Bbot%5D',
      'DELETE /installation/token',
    ]);
  });
});
