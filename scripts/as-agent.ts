// Runs one command as an agent's own GitHub App identity, so agent work is attributable and
// GitHub's rules can tell agents from the maintainer. Why and how: docs/process/agent-identities.md
// Run: node scripts/as-agent.ts <builder|reviewer> -- <command...>
//
// It mints a short-lived installation token and hands it to the command through env only.
// The token and the private key are never printed, error messages included.

import { execFileSync, spawn } from 'node:child_process';
import { createPrivateKey, type KeyObject, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROLES = ['builder', 'reviewer'] as const;
export type Role = (typeof ROLES)[number];

/** Only the slug is needed. appId is an optional override for when the lookup can't see the app. */
type AppConfig = { slug: string; appId?: number };

const API = 'https://api.github.com';
const REPO = 'hartz89/docent';
const DOC = 'docs/process/agent-identities.md';
const DEFAULT_CONFIG = join(import.meta.dirname, '..', '.github', 'agent-apps.json');

export type Deps = {
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  /** Where errors and notes go. Everything written here is scrubbed of secrets first. */
  log: (line: string) => void;
  configPath?: string;
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
    'git push [-u] origin <branch>   (not main; no force, +refspec, :refspec, --delete, --mirror)',
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

/** Returns why the command is refused, or null if it's allowed. */
function refusal(role: Role, command: string[]): string | null {
  const [program, sub, ...rest] = command;
  if (program === 'git' && sub === 'push' && role === 'builder') return refuseGitPush(rest);
  if (program === 'gh' && sub === 'api') return refuseGhApi(rest);
  if (program === 'gh' && sub === 'pr') {
    const [action, ...args] = rest;
    if (args.some((arg) => arg.startsWith('--admin'))) return '--admin bypasses branch protection';
    if (action === 'merge' && role === 'builder') return refuseMerge(args);
    if (action && PR_SUBCOMMANDS[role].includes(action)) return null;
    return `"gh pr ${action ?? ''}" isn't allowed for the ${role}`;
  }
  return `the ${role} may only run the commands below`;
}

function refuseGitPush(args: string[]): string | null {
  const flags = args.filter((arg) => arg.startsWith('-'));
  const positionals = args.filter((arg) => !arg.startsWith('-'));
  const badFlag = flags.find((flag) => flag !== '-u' && flag !== '--set-upstream');
  if (badFlag) return `push flag ${badFlag} isn't allowed`;
  const [remote, branch, ...extra] = positionals;
  if (remote !== 'origin' || !branch || extra.length > 0) {
    return 'push exactly one branch to origin';
  }
  if (branch.includes('+') || branch.includes(':')) return `refspec ${branch} isn't allowed`;
  if (branch === 'main' || branch === 'refs/heads/main') return 'main moves only by merging PRs';
  return null;
}

function refuseMerge(args: string[]): string | null {
  const [number, ...flags] = args.filter((arg) => !arg.startsWith('-'));
  const options = args.filter((arg) => arg.startsWith('-'));
  if (!number || !/^\d+$/.test(number) || flags.length > 0) return 'merge takes one PR number';
  if (options.length !== 1 || options[0] !== '--squash') return 'merge only with --squash';
  return null;
}

/** gh api flags that take a value, so the value isn't mistaken for a flag. */
const API_VALUE_FLAGS = ['-H', '--header', '-q', '--jq', '-t', '--template', '-p', '--preview'];

function refuseGhApi(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '-X' || arg === '--method') {
      const method = args[++i];
      if (method?.toUpperCase() !== 'GET')
        return `gh api method ${method ?? '(none)'} isn't allowed`;
    } else if (arg.startsWith('--method=')) {
      if (arg.slice(9).toUpperCase() !== 'GET') return `gh api ${arg} isn't allowed`;
    } else if (API_VALUE_FLAGS.includes(arg)) {
      i++;
    } else if (/^-[^-]./.test(arg)) {
      // Short flags must stand alone, so "-XPOST" or "-ifbody=x" can't sneak a write past.
      return `write ${arg} as separate flags`;
    } else if (arg === '-f' || arg === '-F' || /^--(field|raw-field|input)(=|$)/.test(arg)) {
      return `gh api ${arg} sends a request body, which isn't allowed`;
    }
  }
  return null;
}

function checkAllowed(role: Role, command: string[]): void {
  const reason = refusal(role, command);
  if (reason) {
    throw new AgentError(
      `refused "${command.join(' ')}": ${reason}. The ${role} may run:\n` +
        ALLOWED[role].map((form) => `  ${form}`).join('\n'),
    );
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

function loadKey(role: Role, env: NodeJS.ProcessEnv): KeyObject {
  const envName = `DOCENT_${role.toUpperCase()}_APP_KEY`;
  const service = `docent-${role}-app-key`;
  let stored = env[envName];
  if (!stored) {
    try {
      stored = execFileSync('security', ['find-generic-password', '-s', service, '-w'], {
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
  try {
    return createPrivateKey(decodeKey(stored));
  } catch {
    throw new AgentError(
      `the ${role} app's private key isn't a valid PEM key (from ${env[envName] ? envName : `Keychain "${service}"`}).`,
    );
  }
}

/** An RS256 JWT that identifies the app. GitHub allows at most 10 minutes. */
export function appJwt(appId: number, key: KeyObject, now: number): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  // Backdate iat a minute to allow for clock drift, as GitHub recommends.
  const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  return `${unsigned}.${sign('sha256', Buffer.from(unsigned), key).toString('base64url')}`;
}

async function github<T>(
  deps: Deps,
  method: string,
  path: string,
  auth: string | null,
  hint: string,
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'docent-as-agent',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (auth) headers.Authorization = auth;
  const response = await deps.fetch(`${API}${path}`, { method, headers });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: unknown };
    const message = typeof body.message === 'string' ? `: ${body.message}` : '';
    throw new AgentError(`GitHub ${method} ${path} returned ${response.status}${message}. ${hint}`);
  }
  return (await response.json()) as T;
}

/** The env that makes gh and git act as the app's bot user. */
function agentEnv(
  base: NodeJS.ProcessEnv,
  token: string,
  bot: { login: string; id: number },
): NodeJS.ProcessEnv {
  const email = `${bot.id}+${bot.login}@users.noreply.github.com`;
  // Git reads extra config from GIT_CONFIG_KEY_n/VALUE_n, so the token never lands in argv,
  // a remote URL or .git/config. Append after any entries the caller already set.
  const n = Number(base.GIT_CONFIG_COUNT ?? 0) || 0;
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    ...base,
    GH_TOKEN: token,
    GIT_AUTHOR_NAME: bot.login,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: bot.login,
    GIT_COMMITTER_EMAIL: email,
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: 'http.https://github.com/.extraheader',
    [`GIT_CONFIG_VALUE_${n}`]: `AUTHORIZATION: basic ${basic}`,
  };
}

function run(command: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const [file, ...args] = command as [string, ...string[]];
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: 'inherit' });
    child.on('error', (error: NodeJS.ErrnoException) =>
      reject(
        new AgentError(
          error.code === 'ENOENT' ? `command not found: ${file}` : `couldn't start ${file}`,
        ),
      ),
    );
    // A null code means the child died from a signal.
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** Runs the command as the role's app and returns its exit code. Never throws. */
export async function asAgent(argv: string[], deps: Deps): Promise<number> {
  const secrets: string[] = [];
  const say = (line: string) => {
    let safe = line;
    for (const secret of secrets) safe = safe.replaceAll(secret, '[redacted]');
    deps.log(safe);
  };
  try {
    const { role, command } = parseArgs(argv);
    checkAllowed(role, command);
    const config = loadConfig(deps.configPath ?? DEFAULT_CONFIG, role);
    const key = loadKey(role, deps.env);
    const appId =
      config.appId ??
      (
        await github<{ id: number }>(
          deps,
          'GET',
          `/apps/${encodeURIComponent(config.slug)}`,
          null,
          `Check the ${role} slug in the config. If the app is private, GitHub hides it from ` +
            'this lookup: add its "appId" (from the app settings page) to the config.',
        )
      ).id;
    const jwt = appJwt(appId, key, deps.now?.() ?? Math.floor(Date.now() / 1000));
    secrets.push(jwt);
    const installation = await github<{ id: number }>(
      deps,
      'GET',
      `/repos/${REPO}/installation`,
      `Bearer ${jwt}`,
      `Check the ${role} app is installed on ${REPO} and that the key belongs to it.`,
    );
    const { token } = await github<{ token: string }>(
      deps,
      'POST',
      `/app/installations/${installation.id}/access_tokens`,
      `Bearer ${jwt}`,
      `Check that the key belongs to the ${role} app.`,
    );
    secrets.push(token);
    const bot = await github<{ login: string; id: number }>(
      deps,
      'GET',
      `/users/${encodeURIComponent(`${config.slug}[bot]`)}`,
      `Bearer ${token}`,
      `Check the slug in the config matches the ${role} app's URL name.`,
    );
    const code = await run(command, agentEnv(deps.env, token, bot));
    if (code !== 0) say(`as-agent: ${command[0]} exited with ${code}`);
    return code;
  } catch (error) {
    const message =
      error instanceof AgentError ? error.message : `unexpected error (${String(error)})`;
    say(`as-agent: ${message}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await asAgent(process.argv.slice(2), {
    fetch,
    env: process.env,
    log: (line) => console.error(line),
  });
}
