# Spike: answering questions by forking the author's session

**2026-11-06 · Claude Code 2.1.319 · macOS · about $0.30 total spend**

**Result.** Forking the author's session to answer a question works. Each question costs about 1–7 cents and takes 4–13 seconds, and the original session is left untouched. Three findings shape the design: read-only access has to be set explicitly, Claude Code has no session lock, and fork cost reports are misleading.

## What we checked

| Question                | Verdict                     | What we saw                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Headless author session | Works                       | `claude -p ... --output-format json` returns `session_id`. The transcript is at `~/.claude/projects/<cwd, with / and . replaced by ->/<id>.jsonl`, about 260 KB for a 4-turn session.                                                                                                                                                                                                     |
| Forked question         | Works                       | `--resume <id> --fork-session`. Each fork gets a new id. The answer used reasoning that exists only in the transcript, not in the code. The original file was byte-for-byte unchanged, and a second fork didn't see the first one.                                                                                                                                                        |
| Read-only enforcement   | Works, if flags are stacked | With no flags, the fork edited files: it inherits the user's `defaultMode` (`auto` here). `plan` mode only works because the model chooses not to act, and it wrote a plan file to `~/.claude/plans/`. What holds: `--tools Read,Grep,Glob --permission-mode dontAsk --strict-mcp-config`. Denials show up in `permission_denials`. It held even when the repo's settings allowed writes. |
| Resume while running    | **No protection**           | A plain resume while the session was live succeeded, and both processes appended to the same `.jsonl`. A fork taken mid-run saw a half-finished state and answered wrongly.                                                                                                                                                                                                               |
| Portability             | Works with a copy           | `--resume <id>` finds the transcript in any project folder on the machine. On another machine, copying the `.jsonl` into `~/.claude/projects/<encoded path>/` makes it resumable. Absolute paths inside the transcript stay as they were; the model coped. File-history (undo) isn't copied.                                                                                              |
| Agent SDK               | Works                       | `@anthropic-ai/claude-agent-sdk` has `resume`, `forkSession`, `sessionId`, `resumeSessionAt`, `tools`, `permissionMode`, `strictMcpConfig` and a `canUseTool` callback. There are also standalone `forkSession(id, {upToMessageId})`, `listSessions`, `getSessionMessages`, and an alpha `sessionStore`.                                                                                  |
| Channels                | Research preview            | `--channels` is hidden from `--help`. A channel is an MCP server sending `notifications/claude/channel` into a live session. Only allowlisted plugins can register, unless a dev flag is used, and Team and Enterprise orgs must turn it on. Not ready to build on.                                                                                                                       |

## Gotchas

- **A fork's `total_cost_usd` includes the original session's cost.** Use the per-turn `usage` field, or subtract the original's cost.
- **Variadic flags (`--tools`, `--allowedTools`, `--disallowedTools`) swallow a prompt placed after them.** Put the prompt right after `-p`. To pass no tools, use `--tools=`; `--tools ""` doesn't work.
- **Changing the tool set breaks prompt caching.** A no-tools fork cost about 4x a Read/Grep/Glob fork. Keep the question tool set identical every time.
- **Each fork is a full copy of the transcript** (250–550 KB). Docent should clean up its forks.

## What this means for Docent

- **Use the Agent SDK in the server, not CLI subprocesses.** It gives typed options, streaming, a hard `canUseTool` gate, and the ability to fork from an exact message.
- **Questions:** fork from the author session at the PR's last message. Give the fork Read, Grep and Glob only, with `dontAsk`, `strictMcpConfig`, and a deny-all `canUseTool`. Fork only idle sessions.
- **Revision batches:** resume the real session with write tools, behind a lock Docent holds. Claude Code won't stop two writers.
- **Snapshots:** ship the `.jsonl`, and on load drop it into the encoded project folder.
