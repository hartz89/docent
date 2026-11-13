#!/usr/bin/env node
// @ts-check
// Docent's session hook for Claude Code. On SessionStart and SubagentStart it writes one small
// JSON record, so Docent can later find the session (or subagent) that wrote a pull request.
//
// It only reads: the hook input on stdin and a few files inside the checkout's .git folder. It
// never runs git, never touches the network, and never writes inside the repo. It prints nothing,
// because SessionStart output would land in the session's context, and it always exits 0, so a
// problem here never gets in the author's way.
//
// Plain JavaScript on purpose: Node starts it in about 30 ms, where a .ts file takes about 50.
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** Bumped when the record's shape changes. Docent ignores versions it doesn't know. */
const RECORD_VERSION = 1;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * @typedef {object} SessionRecord
 * @property {1} version
 * @property {'SessionStart' | 'SubagentStart'} event
 * @property {string} sessionId The top-level session. A subagent's records carry this id too.
 * @property {string | null} agentId The subagent's id, or null for a top-level session.
 * @property {string | null} parentSessionId The session that started the subagent, or null.
 * @property {string} cwd
 * @property {string | null} branch The checked-out branch when the hook ran; null if detached.
 * @property {string | null} origin The `origin` remote's URL, with any credentials removed.
 * @property {string} transcriptPath Where Claude Code writes this session's (or subagent's) transcript.
 * @property {string} recordedAt ISO 8601.
 */

/**
 * Docent's data folder: the same rules as `defaultDataDir` in apps/server/src/github.ts, which
 * also keeps run logs and question threads there. The hook runs standalone and can't import it,
 * so keep the two in step; a test in apps/server/src/github.test.ts checks they agree.
 * @param {NodeJS.ProcessEnv} env
 */
function dataDir(env = process.env) {
  if (env.DOCENT_DATA_DIR) return env.DOCENT_DATA_DIR;
  if (process.platform === 'darwin')
    return join(homedir(), 'Library', 'Application Support', 'docent');
  if (process.platform === 'win32') {
    return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'docent');
  }
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'docent');
}

/**
 * The record for one hook call, or null when the input isn't a session or subagent start.
 * @param {unknown} input The hook's stdin, parsed.
 * @param {Date} now
 * @returns {SessionRecord | null}
 */
function recordFor(input, now = new Date()) {
  if (!input || typeof input !== 'object') return null;
  const hook = /** @type {Record<string, unknown>} */ (input);
  const event = hook.hook_event_name;
  if (event !== 'SessionStart' && event !== 'SubagentStart') return null;
  const { session_id: sessionId, transcript_path: transcript, cwd } = hook;
  if (typeof sessionId !== 'string' || !UUID.test(sessionId)) return null;
  if (typeof transcript !== 'string' || !isAbsolute(transcript)) return null;
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return null;

  let agentId = null;
  let transcriptPath = transcript;
  if (event === 'SubagentStart') {
    if (typeof hook.agent_id !== 'string' || !AGENT_ID.test(hook.agent_id)) return null;
    agentId = hook.agent_id;
    // The hook gets the parent's transcript. Claude Code writes the subagent's beside it:
    // <project>/<session>/subagents/agent-<id>.jsonl.
    transcriptPath = join(dirname(transcript), sessionId, 'subagents', `agent-${agentId}.jsonl`);
  }
  const git = readGit(cwd);
  return {
    version: RECORD_VERSION,
    event,
    sessionId,
    agentId,
    parentSessionId: agentId ? sessionId : null,
    cwd,
    branch: git.branch,
    origin: git.origin,
    transcriptPath,
    recordedAt: now.toISOString(),
  };
}

/**
 * Writes the record as `sessions/<session>.json`, or `sessions/<session>.agent-<id>.json`.
 * A later start of the same session (a resume, say) replaces it. Written to a temporary file
 * first and renamed, so Docent never reads half a record.
 * @param {SessionRecord} record
 * @param {string} root
 */
function writeRecord(record, root) {
  const dir = join(root, 'sessions');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A linked folder could point the write somewhere else; Docent's other folders refuse one too.
  if (!lstatSync(dir).isDirectory()) return null;
  // The mode above only applies to a folder this call creates.
  chmodSync(dir, 0o700);
  const name = record.agentId
    ? `${record.sessionId}.agent-${record.agentId}.json`
    : `${record.sessionId}.json`;
  const path = join(dir, name);
  const temp = `${path}.${process.pid}.tmp`;
  // 'wx' never follows a link or reuses a file someone else put there.
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
  return path;
}

/**
 * The branch and origin of the checkout holding `cwd`, read straight from .git. A worktree's
 * .git is a file naming its git folder, and its shared config lives in the main git folder.
 * @param {string} cwd
 * @returns {{ branch: string | null, origin: string | null }}
 */
function readGit(cwd) {
  const none = { branch: null, origin: null };
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const dotGit = join(dir, '.git');
    const info = statOrNull(dotGit);
    if (info) {
      let gitDir = dotGit;
      if (info.isFile()) {
        const target = /^gitdir:\s*(.+)$/m.exec(readOrEmpty(dotGit))?.[1]?.trim();
        if (!target) return none;
        gitDir = resolve(dir, target);
      }
      const commonPath = readOrEmpty(join(gitDir, 'commondir')).trim();
      const commonDir = commonPath ? resolve(gitDir, commonPath) : gitDir;
      const head = readOrEmpty(join(gitDir, 'HEAD'));
      const branch = /^ref: refs\/heads\/(.+)$/m.exec(head)?.[1]?.trim() ?? null;
      return { branch, origin: originUrl(readOrEmpty(join(commonDir, 'config'))) };
    }
    if (dirname(dir) === dir) return none;
  }
}

/**
 * The `url` of `[remote "origin"]` in a git config file, without any user name or token.
 * @param {string} config
 */
function originUrl(config) {
  let inOrigin = false;
  for (const raw of config.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(line);
    } else if (inOrigin) {
      const url = /^url\s*=\s*(.+)$/.exec(line)?.[1]?.trim();
      if (url) return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');
    }
  }
  return null;
}

/** @param {string} path */
function statOrNull(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/** @param {string} path */
function readOrEmpty(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  try {
    const record = recordFor(JSON.parse(readFileSync(0, 'utf8')));
    if (record) writeRecord(record, dataDir());
  } catch {
    // Never block or slow the author's session. A missing record only means Docent falls back
    // to searching transcripts.
  }
}

main();
