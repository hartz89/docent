// Runs one command as an agent's own GitHub App identity, so agent work is attributable and
// GitHub's rules can tell agents from the maintainer. Why and how: docs/process/agent-identities.md
// Run: node scripts/as-agent.ts <builder|reviewer> -- <command...>
//
// It mints a short-lived, narrowly scoped installation token, hands it to one allowlisted gh or
// git command in a minimal env, scrubs secrets from everything printed, and revokes it after.

import { execFileSync, spawn } from 'node:child_process';
import { createPrivateKey, type KeyObject, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROLES = ['builder', 'reviewer'] as const;
export type Role = (typeof ROLES)[number];

/** The slug names the app. appId is needed for private apps, which GitHub hides from lookup. */
type AppConfig = { slug: string; appId?: number };

const API = 'https://api.github.com';
const REPO = 'hartz89/docent';
const ORIGIN_URLS = [`https://github.com/${REPO}.git`, `https://github.com/${REPO}`];
const DOC = 'docs/process/agent-identities.md';
const DEFAULT_CONFIG = join(import.meta.dirname, '..', '.github', 'agent-apps.json');
/** Where gh and git are looked up. Never the caller's PATH, which an agent controls. */
const TOOL_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

/** What each role's token may do. Metadata read is always included. */
const TOKEN_PERMISSIONS: Record<Role, Record<string, 'read' | 'write'>> = {
  // checks: read lets `gh pr checks` see CI.
  builder: { contents: 'write', pull_requests: 'write', checks: 'read' },
  reviewer: { pull_requests: 'write', contents: 'read' },
};

export type Deps = {
  fetch: typeof fetch;
  /** The caller's env. Only HOME, LANG, TERM, TMPDIR and the key variable are read from it. */
  env: NodeJS.ProcessEnv;
  /** Where the child's output and our own messages go, after secrets are scrubbed. */
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  configPath?: string;
  cwd?: string;
  toolDirs?: string[];
  /** Seconds since the epoch. */
  now?: () => number;
};

/** A failure with a message meant for the person running the command. */
class AgentError extends Error {}

function isRole(value: string | undefined): value is Role {
  return ROLES.some((role) => role === value);
}

function parseArgs(argv: string[]): { role: Role; command: string[] } {
  const [role, dashes, ...command] = argv;
  if (!isRole(role) || dashes !== '--' || command.length === 0) {
    throw new AgentError(
      `usage: node scripts/as-agent.ts <${ROLES.join('|')}> -- <command...>\n` +
        '  e.g. node scripts/as-agent.ts builder -- gh pr create --body-file body.md',
    );
  }
  return { role, command };
}

// The allowlist. A broad "allow as-agent" permission rule is only safe because this is strict:
// anything not matching one of these forms is refused before a token exists. scripts/ is
// code-owned, so widening it needs the maintainer's approval.
const ALLOWED: Record<Role, string[]> = {
  builder: [
    'git push [-u] origin <branch>   (a plain branch name: not main, HEAD or refs/...; no flags but -u)',
    'gh pr create|view|checks|diff|comment|edit ...',
    'gh pr merge <number> --squash',
    'gh api <endpoint> ...           (GET only: no -X/--method other than GET, no -f/-F/--input)',
  ],
  reviewer: [
    'gh pr view|diff|checks|review|comment ...',
    'gh api <endpoint> ...           (GET only: no -X/--method other than GET, no -f/-F/--input)',
  ],
};

const PR_SUBCOMMANDS: Record<Role, string[]> = {
  builder: ['create', 'view', 'checks', 'diff', 'comment', 'edit'],
  reviewer: ['view', 'diff', 'checks', 'review', 'comment'],
};

type Allowed = { tool: 'gh' | 'git'; args: string[] };

/** Returns the exact command to run, or throws why it's refused. */
function allowed(role: Role, command: string[]): Allowed {
  const [program, sub, ...rest] = command;
  const refuse = (reason: string): never => {
    throw new AgentError(
      `refused "${command.join(' ')}": ${reason}. The ${role} may run:\n` +
        ALLOWED[role].map((form) => `  ${form}`).join('\n'),
    );
  };
  if (program === 'git' && sub === 'push' && role === 'builder') {
    return { tool: 'git', args: gitPushArgs(rest, refuse) };
  }
  if (program === 'gh' && sub === 'api') {
    checkGhApi(rest, refuse);
    return { tool: 'gh', args: ['api', ...rest] };
  }
  if (program === 'gh' && sub === 'pr') {
    const [action, ...args] = rest;
    if (args.some((arg) => arg.startsWith('--admin'))) refuse('--admin bypasses branch protection');
    if (action === 'merge' && role === 'builder') checkMerge(args, refuse);
    else if (!action || !PR_SUBCOMMANDS[role].includes(action)) {
      refuse(`"gh pr ${action ?? ''}" isn't allowed for the ${role}`);
    }
    return { tool: 'gh', args: ['pr', ...rest] };
  }
  return refuse(`the ${role} may only run the commands below`);
}

/** A plain branch name. Anything git might resolve to another ref (HEAD, @, refs/...) is out. */
const SAFE_BRANCH = /^[A-Za-z0-9._/-]+$/;
const RESERVED_BRANCH = /^(main|HEAD)$|^(refs|heads|remotes|tags)\/|\.\.|^[-./]|[/.]$|\.lock$/;

function gitPushArgs(args: string[], refuse: (reason: string) => never): string[] {
  const flags = args.filter((arg) => arg.startsWith('-'));
  const positionals = args.filter((arg) => !arg.startsWith('-'));
  const badFlag = flags.find((flag) => flag !== '-u' && flag !== '--set-upstream');
  if (badFlag) refuse(`push flag ${badFlag} isn't allowed`);
  const [remote, branch, ...extra] = positionals;
  if (remote !== 'origin' || !branch || extra.length > 0)
    refuse('push exactly one branch to origin');
  const name = branch as string;
  if (!SAFE_BRANCH.test(name) || RESERVED_BRANCH.test(name)) {
    refuse(`"${name}" isn't a plain branch name (and main moves only by merging PRs)`);
  }
  // An explicit refspec, so git can't resolve the name to some other ref.
  const upstream = flags.length > 0 ? ['-u'] : [];
  return ['push', ...upstream, 'origin', `refs/heads/${name}:refs/heads/${name}`];
}

function checkMerge(args: string[], refuse: (reason: string) => never): void {
  const [number, ...extra] = args.filter((arg) => !arg.startsWith('-'));
  const options = args.filter((arg) => arg.startsWith('-'));
  if (!number || !/^\d+$/.test(number) || extra.length > 0) refuse('merge takes one PR number');
  if (options.length !== 1 || options[0] !== '--squash') refuse('merge only with --squash');
}

/** gh api flags that take a value, so the value isn't mistaken for a flag. */
const API_VALUE_FLAGS = ['-H', '--header', '-q', '--jq', '-t', '--template', '-p', '--preview'];

function checkGhApi(args: string[], refuse: (reason: string) => never): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '-X' || arg === '--method') {
      const method = args[++i];
      if (method?.toUpperCase() !== 'GET') refuse(`gh api method ${method ?? '(none)'}`);
    } else if (arg.startsWith('--method=')) {
      if (arg.slice(9).toUpperCase() !== 'GET') refuse(`gh api ${arg}`);
    } else if (API_VALUE_FLAGS.includes(arg)) {
      // A value that looks like a flag is ambiguous; don't guess how gh will parse it.
      if (args[++i]?.startsWith('-')) refuse(`${arg} needs a value that doesn't start with -`);
    } else if (/^-[^-]./.test(arg)) {
      // Short flags must stand alone, so "-XPOST" or "-ifbody=x" can't sneak a write past.
      refuse(`write ${arg} as separate flags`);
    } else if (arg === '-f' || arg === '-F' || /^--(field|raw-field|input)(=|$)/.test(arg)) {
      refuse(`gh api ${arg} sends a request body`);
    }
  }
}

function loadConfig(path: string, role: Role): AppConfig {
  const all: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const { slug, appId } = (all as Record<string, Record<string, unknown> | undefined>)[role] ?? {};
  if (typeof slug !== 'string' || slug === '' || slug === 'REPLACE_ME') {
    throw new AgentError(
      `the ${role} GitHub App isn't set up yet: its slug in ${path} still needs a real value. ` +
        `The maintainer creates the app and fills it in; see ${DOC}. Until then, run the ` +
        'command without as-agent (it uses your own gh login) and say so in the PR.',
    );
  }
  if (appId === undefined) return { slug };
  if (!Number.isInteger(appId) || (appId as number) <= 0) {
    throw new AgentError(`the ${role} appId in ${path} must be a positive integer, or left out.`);
  }
  return { slug, appId: appId as number };
}

/** The key is stored base64-encoded (the Keychain mangles multi-line values); raw PEM also works. */
function decodeKey(stored: string): string {
  const text = stored.trim();
  return text.startsWith('-----BEGIN') ? text : Buffer.from(text, 'base64').toString('utf8');
}

function loadKey(role: Role, env: NodeJS.ProcessEnv, secrets: string[]): KeyObject {
  const envName = `DOCENT_${role.toUpperCase()}_APP_KEY`;
  const service = `docent-${role}-app-key`;
  let stored = env[envName];
  if (!stored) {
    try {
      stored = execFileSync('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      throw new AgentError(
        `no private key for the ${role} app: set ${envName}, or store it in the macOS Keychain ` +
          `as "${service}" (see ${DOC}).`,
      );
    }
  }
  secrets.push(stored.trim(), decodeKey(stored));
  try {
    return createPrivateKey(decodeKey(stored));
  } catch {
    const source = env[envName] ? envName : `Keychain "${service}"`;
    throw new AgentError(`the ${role} app's private key isn't a valid PEM key (from ${source}).`);
  }
}

/** An RS256 JWT that identifies the app. GitHub allows at most 10 minutes. */
export function appJwt(appId: number, key: KeyObject, now: number): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  // Backdate iat a minute to allow for clock drift, as GitHub recommends.
  const claims = { iat: now - 60, exp: now + 540, iss: String(appId) };
  const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part(claims)}`;
  return `${unsigned}.${sign('sha256', Buffer.from(unsigned), key).toString('base64url')}`;
}

async function github<T>(
  deps: Deps,
  request: { method: string; path: string; auth: string | null; hint: string; body?: object },
): Promise<T> {
  const { method, path, auth, hint, body } = request;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'docent-as-agent',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (auth) headers.Authorization = auth;
  const init: RequestInit = { method, headers };
  if (body) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await deps.fetch(`${API}${path}`, init);
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { message?: unknown };
    const message = typeof error.message === 'string' ? `: ${error.message}` : '';
    throw new AgentError(`GitHub ${method} ${path} returned ${response.status}${message}. ${hint}`);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

function findTool(tool: 'gh' | 'git', dirs: string[]): string {
  const dir = dirs.find((d) => existsSync(join(d, tool)));
  if (!dir) throw new AgentError(`couldn't find ${tool} in ${dirs.join(', ')}`);
  return join(dir, tool);
}

/**
 * Repo-local git config still applies, and it can send traffic elsewhere (proxies, url
 * rewrites, includes) or run programs. Refuse to hand a token to a repo configured like that.
 */
const RISKY_LOCAL_CONFIG =
  /^(http\.|url\.|credential|protocol\.|include\.|includeif\.|core\.(hookspath|fsmonitor|sshcommand|askpass|gitproxy)$|remote\.origin\.(pushurl|receivepack|uploadpack|proxy)$)/;

function checkLocalGitConfig(git: string, cwd: string | undefined, env: NodeJS.ProcessEnv): void {
  let lines: string[];
  try {
    const out = execFileSync(git, ['config', '--local', '--list'], {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    lines = out.split('\n').filter(Boolean);
  } catch {
    return; // Not a repo, so there's no local config to worry about.
  }
  for (const line of lines) {
    const split = line.indexOf('=');
    const key = line.slice(0, split);
    const value = line.slice(split + 1);
    if (RISKY_LOCAL_CONFIG.test(key)) {
      throw new AgentError(`refusing to run: this repo's git config sets ${key}. Remove it first.`);
    }
    if (key === 'remote.origin.url' && !ORIGIN_URLS.includes(value)) {
      throw new AgentError(`refusing to run: origin must be ${ORIGIN_URLS[0]}, not ${value}.`);
    }
  }
}

/** Env with nothing from the caller but HOME, LANG, TERM and TMPDIR. */
function baseEnv(caller: NodeJS.ProcessEnv, toolDirs: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: [...new Set([...toolDirs, '/usr/bin', '/bin'])].join(':'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const name of ['HOME', 'LANG', 'TERM', 'TMPDIR']) {
    if (caller[name]) env[name] = caller[name];
  }
  return env;
}

/** The env that makes gh and git act as the app's bot user, and nothing else. */
function agentEnv(
  base: NodeJS.ProcessEnv,
  token: string,
  basicAuth: string,
  ghConfigDir: string,
  bot: { login: string; id: number },
): NodeJS.ProcessEnv {
  const email = `${bot.id}+${bot.login}@users.noreply.github.com`;
  // Git reads GIT_CONFIG_KEY_n/VALUE_n at the highest priority, so the token never lands in
  // argv, a remote URL or .git/config, and hooks and odd transports are switched off.
  const gitConfig: [string, string][] = [
    ['http.https://github.com/.extraheader', `AUTHORIZATION: basic ${basicAuth}`],
    ['core.hooksPath', '/dev/null'],
    ['core.fsmonitor', 'false'],
    ['protocol.allow', 'never'],
    ['protocol.https.allow', 'always'],
  ];
  const env: NodeJS.ProcessEnv = {
    ...base,
    GH_TOKEN: token,
    GH_CONFIG_DIR: ghConfigDir,
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GIT_AUTHOR_NAME: bot.login,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: bot.login,
    GIT_COMMITTER_EMAIL: email,
    GIT_CONFIG_COUNT: String(gitConfig.length),
  };
  gitConfig.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/** Passes text through line by line, with every secret replaced. */
function scrubber(write: (text: string) => void, secrets: string[]) {
  let pending = '';
  const clean = (text: string) => {
    let safe = text;
    for (const secret of secrets) if (secret) safe = safe.replaceAll(secret, '[redacted]');
    return safe;
  };
  return {
    push(chunk: string) {
      pending += chunk;
      const end = pending.lastIndexOf('\n') + 1;
      if (end > 0) write(clean(pending.slice(0, end)));
      pending = pending.slice(end);
    },
    end() {
      if (pending) write(clean(pending));
      pending = '';
    },
  };
}

function run(
  file: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; cwd: string | undefined; deps: Deps; secrets: string[] },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const out = scrubber(opts.deps.stdout, opts.secrets);
    const err = scrubber(opts.deps.stderr, opts.secrets);
    const child = spawn(file, args, {
      env: opts.env,
      cwd: opts.cwd,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8').on('data', out.push);
    child.stderr.setEncoding('utf8').on('data', err.push);
    child.on('error', () => reject(new AgentError(`couldn't start ${file}`)));
    // A null code means the child died from a signal.
    child.on('close', (code) => {
      out.end();
      err.end();
      resolve(code ?? 1);
    });
  });
}

/** Runs the command as the role's app and returns its exit code. Never throws. */
export async function asAgent(argv: string[], deps: Deps): Promise<number> {
  const secrets: string[] = [];
  const say = (line: string) => {
    const err = scrubber(deps.stderr, secrets);
    err.push(`as-agent: ${line}\n`);
  };
  let revoke: (() => Promise<void>) | undefined;
  let ghConfigDir: string | undefined;
  try {
    const { role, command } = parseArgs(argv);
    const { tool, args } = allowed(role, command);
    const toolDirs = deps.toolDirs ?? TOOL_DIRS;
    const file = findTool(tool, toolDirs);
    const base = baseEnv(deps.env, toolDirs);
    checkLocalGitConfig(findTool('git', toolDirs), deps.cwd, base);
    const config = loadConfig(deps.configPath ?? DEFAULT_CONFIG, role);
    const key = loadKey(role, deps.env, secrets);

    const appId =
      config.appId ??
      (
        await github<{ id: number }>(deps, {
          method: 'GET',
          path: `/apps/${encodeURIComponent(config.slug)}`,
          auth: null,
          hint:
            `Check the ${role} slug in the config. If the app is private, GitHub hides it from ` +
            'this lookup: add its "appId" (from the app settings page) to the config.',
        })
      ).id;
    const jwt = appJwt(appId, key, deps.now?.() ?? Math.floor(Date.now() / 1000));
    secrets.push(jwt);
    const installation = await github<{ id: number }>(deps, {
      method: 'GET',
      path: `/repos/${REPO}/installation`,
      auth: `Bearer ${jwt}`,
      hint: `Check the ${role} app is installed on ${REPO} and that the key belongs to it.`,
    });
    const { token } = await github<{ token: string }>(deps, {
      method: 'POST',
      path: `/app/installations/${installation.id}/access_tokens`,
      auth: `Bearer ${jwt}`,
      hint: `Check that the key belongs to the ${role} app and that it has these permissions.`,
      body: { repositories: [REPO.split('/')[1]], permissions: TOKEN_PERMISSIONS[role] },
    });
    const basicAuth = Buffer.from(`x-access-token:${token}`).toString('base64');
    secrets.push(token, basicAuth);
    revoke = () =>
      github(deps, {
        method: 'DELETE',
        path: '/installation/token',
        auth: `Bearer ${token}`,
        hint: 'The token expires within the hour anyway.',
      });

    const bot = await github<{ login: string; id: number }>(deps, {
      method: 'GET',
      path: `/users/${encodeURIComponent(`${config.slug}[bot]`)}`,
      auth: `Bearer ${token}`,
      hint: `Check the slug in the config matches the ${role} app's URL name.`,
    });
    ghConfigDir = mkdtempSync(join(tmpdir(), 'as-agent-gh-'));
    const env = agentEnv(base, token, basicAuth, ghConfigDir, bot);
    const code = await run(file, args, { env, cwd: deps.cwd, deps, secrets });
    if (code !== 0) say(`${tool} exited with ${code}`);
    return code;
  } catch (error) {
    say(error instanceof AgentError ? error.message : `unexpected error (${String(error)})`);
    return 1;
  } finally {
    if (ghConfigDir) rmSync(ghConfigDir, { recursive: true, force: true });
    await revoke?.().catch((error: unknown) =>
      say(`couldn't revoke the token: ${error instanceof Error ? error.message : 'unknown error'}`),
    );
  }
}

if (import.meta.main) {
  process.exitCode = await asAgent(process.argv.slice(2), {
    fetch,
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
