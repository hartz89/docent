@AGENTS.md

## Claude Code specifics

- Subagents: set `model` explicitly. Haiku for mechanical bulk work, Sonnet for small, fully specified tasks, Opus for everything else.
- Sessions this project spawns for testing (spikes, evals) must run read-only unless the task is a revision batch. Ryan's global `defaultMode` is `auto`, and forked sessions inherit it, so read-only only holds if you set it explicitly: `--tools Read,Grep,Glob --permission-mode dontAsk --strict-mcp-config`. See [`docs/research/2026-11-06-session-spike.md`](docs/research/2026-11-06-session-spike.md).
