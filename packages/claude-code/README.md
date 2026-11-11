# Docent for Claude Code: the author side

This plugin is for people who write pull requests with Claude Code. It does two things:

- **A hook** records which session, or which subagent, worked in which checkout. When someone reviews your PR in Docent on this machine, their questions go to a read-only copy of the session that wrote the code. Without the hook, Docent can only find a session through the `Claude-Session:` link in the PR, and that link names the coordinating session, not the subagent that did the work.
- **A skill**, `author-handoff`, has your agent leave a short note on the PR when it opens it: intent, key decisions, known gaps and where to look first. Docent shows it on the tour's first stop, as your claims, and its guide checks them against the code.

## Install

You need Claude Code 2.1.275 or later, and Node 18 or later on your `PATH` (Docent itself needs Node 24).

In Claude Code:

```
/plugin install docent --marketplace hartz89/docent
```

On older versions, add the marketplace first:

```
/plugin marketplace add hartz89/docent
/plugin install docent@docent
```

The hook starts recording with your next session. Sessions that started before you installed it have no record; Docent still finds them by their link, as before.

### Without the plugin system

Copy `hooks/record-session.mjs` somewhere stable and add it to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node /path/to/record-session.mjs", "timeout": 5 }] }
    ],
    "SubagentStart": [
      { "hooks": [{ "type": "command", "command": "node /path/to/record-session.mjs", "timeout": 5 }] }
    ]
  }
}
```

The skill is optional. To use it without the plugin, copy `skills/author-handoff/` into `~/.claude/skills/`.

## What the hook records

On every session start (new, resumed, cleared or compacted) and every subagent start, it writes one small JSON file:

```json
{
  "version": 1,
  "event": "SubagentStart",
  "sessionId": "7e2cfb5b-77c5-46af-9de2-27ca9a1c1f85",
  "agentId": "a56fac17cea3321fb",
  "parentSessionId": "7e2cfb5b-77c5-46af-9de2-27ca9a1c1f85",
  "cwd": "/Users/you/code/web/.claude/worktrees/agent-a56fac17cea3321fb",
  "branch": "worktree-agent-a56fac17cea3321fb",
  "origin": "https://github.com/acme/web.git",
  "transcriptPath": "/Users/you/.claude/projects/-Users-you-code-web/7e2cfb5b-77c5-46af-9de2-27ca9a1c1f85/subagents/agent-a56fac17cea3321fb.jsonl",
  "recordedAt": "2026-11-10T21:04:11.000Z"
}
```

- `sessionId` is the top-level session. A subagent shares it, and has its own `agentId`. For a top-level session, `agentId` and `parentSessionId` are null.
- `branch` is the branch checked out when the session started, or null if detached. Agents often create the PR's branch later, so Docent doesn't rely on it (see below).
- `origin` is the checkout's `origin` remote. Any user name or token in the URL is removed first.
- `transcriptPath` is where Claude Code keeps that session's or subagent's transcript.

It records nothing else: no prompts, no code, no transcript text.

### Where

One file per session or subagent, in Docent's data folder:

| System | Folder |
| --- | --- |
| macOS | `~/Library/Application Support/docent/sessions/` |
| Linux | `$XDG_DATA_HOME/docent/sessions/`, or `~/.local/share/docent/sessions/` |
| Windows | `%LOCALAPPDATA%\docent\sessions\` |

Set `DOCENT_DATA_DIR` to use another folder; the hook and Docent both read it. The folder is readable only by you, and so is each file. Delete the folder at any time; nothing else depends on it.

### What it doesn't do

- **No network,** and no `git` commands: it reads the branch and origin straight from the checkout's `.git` files.
- **Never writes to your repo.**
- **Prints nothing** (SessionStart output would land in your session's context) and **always exits 0**, so it can't block or break a session. It takes about 30 ms.

## How Docent uses the records

A record only says where to look. Anything that can write to the data folder could write one, so Docent proves each candidate from Claude Code's own transcript before it trusts it:

1. The transcript is inside `~/.claude/projects`, at the exact path Claude Code uses for that session or subagent, and its records carry those ids.
2. One of its records shows it on the PR's head branch, in a checkout whose `origin` is the PR's repo. The PR's branch must be in that repo, not a fork.
3. It did work in the PR: one of its own command outputs shows a commit or a push of one of the PR's commits.

Among the sessions that pass, Docent picks the one that committed or pushed the newest PR commit. A tie goes to a subagent over the coordinator that delegated to it. If none pass, Docent falls back to the session link in the PR.

A subagent's transcript can't be forked as it is. Docent forks a private copy instead, converted to look like a top-level session, and deletes the copy when it exits. Your transcripts are only ever read.

## Developing

The hook is plain JavaScript, so Node starts it fast, and its test runs it the way Claude Code does: `pnpm verify` from the repo root. Check the plugin's shape with `claude plugin validate packages/claude-code`.
