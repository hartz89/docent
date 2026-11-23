// Finds the reviewer's own Claude Code, which every agent session runs on. The Agent SDK would
// otherwise run the copy in its platform package (`@anthropic-ai/claude-agent-sdk-<os>-<cpu>`),
// a ~305 MB optional dependency. `npx --omit=optional` leaves it out; nothing in Docent's own
// package can, since npm installs a dependency's optional dependencies whatever its shrinkwrap
// says.
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

/**
 * The oldest Claude Code Docent runs on: the version this Agent SDK release was built with, so
 * the CLI knows every flag the SDK passes, the read-only ones included. `claude-code.test.ts`
 * fails when the SDK moves on without it.
 */
export const MIN_CLAUDE_CODE_VERSION = '2.1.318';

/** The env var that names a Claude Code to use instead of the one on PATH. */
export const CLAUDE_PATH_ENV = 'DOCENT_CLAUDE_PATH';

export type ClaudeCode = { path: string; version: string };

const INSTALL_HINT =
  'Install it from https://code.claude.com/docs/en/setup, then run `claude` once to sign in.';

/**
 * Finds Claude Code and checks its version. `DOCENT_CLAUDE_PATH` wins; otherwise the first
 * `claude` on PATH. Two kinds of PATH entry are skipped, because the folder Docent runs from
 * (a checkout of the very repo under review, say) controls what's in them:
 * - relative ones, like `.`;
 * - any folder inside a `node_modules`. npx, `npm run` and `pnpm run` put an absolute
 *   `node_modules/.bin` on PATH for the current folder and each one above it, ahead of the
 *   user's own entries, and a repo or any of its dependencies can put a `claude` there.
 * Throws a message for people.
 */
export async function findClaudeCode(env: NodeJS.ProcessEnv = process.env): Promise<ClaudeCode> {
  const override = env[CLAUDE_PATH_ENV];
  const path = override ? checkedOverride(override) : onPath(env.PATH ?? '');
  if (!path) {
    throw new Error(
      `Docent runs on Claude Code, and there's no \`claude\` on your PATH. ${INSTALL_HINT} ` +
        `If it's installed somewhere else, set ${CLAUDE_PATH_ENV} to its full path.`,
    );
  }
  const version = await versionOf(path);
  if (compareVersions(version, MIN_CLAUDE_CODE_VERSION) < 0) {
    throw new Error(
      `Docent needs Claude Code ${MIN_CLAUDE_CODE_VERSION} or newer, and ${path} is ${version}. ` +
        'Update it with `claude update`.',
    );
  }
  return { path, version };
}

let found: Promise<ClaudeCode> | undefined;

/**
 * `findClaudeCode`, looked up once per process. A failed lookup isn't kept, so installing
 * Claude Code while Docent runs fixes the next call.
 */
export function claudeCode(): Promise<ClaudeCode> {
  found ??= findClaudeCode().catch((error: unknown) => {
    found = undefined;
    throw error;
  });
  return found;
}

function checkedOverride(path: string): string {
  if (!isAbsolute(path)) {
    throw new Error(`${CLAUDE_PATH_ENV} must be an absolute path, and it is "${path}".`);
  }
  if (!isExecutableFile(path)) {
    throw new Error(`${CLAUDE_PATH_ENV} names ${path}, which isn't an executable file.`);
  }
  return path;
}

function onPath(pathVar: string): string | undefined {
  const names = process.platform === 'win32' ? ['claude.exe'] : ['claude'];
  for (const dir of pathVar.split(delimiter)) {
    if (!isAbsolute(dir) || dir.split(/[\\/]/).includes('node_modules')) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

async function versionOf(path: string): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)(path, ['--version'], { timeout: 15_000 }));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Couldn't run \`${path} --version\` to check Claude Code: ${reason}`);
  }
  // Like "2.1.325 (Claude Code)".
  const version = stdout.trim().match(/^(\d+\.\d+\.\d+)/)?.[1];
  if (!version) {
    throw new Error(
      `${path} doesn't look like Claude Code: \`--version\` printed "${stdout.trim().slice(0, 80)}".`,
    );
  }
  return version;
}

/** Negative, zero or positive, comparing dotted numeric versions part by part. */
export function compareVersions(a: string, b: string): number {
  const [pa, pb] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < Math.max(pa?.length ?? 0, pb?.length ?? 0); i++) {
    const diff = (pa?.[i] ?? 0) - (pb?.[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
