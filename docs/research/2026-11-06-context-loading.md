# How Claude Code loads context

**2026-11-06, Claude Code 2.1.x.** Sources: [memory](https://code.claude.com/docs/en/memory.md), [skills](https://code.claude.com/docs/en/skills.md), [headless](https://code.claude.com/docs/en/headless.md).

## What loads when

| Mechanism                                     | When it loads                                                                                                                                   | Vendor-neutral?                                     |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `CLAUDE.md` in the working directory or above | At launch                                                                                                                                       | No                                                  |
| `@path` imports                               | Eagerly, with the file that imports them, up to 4 hops. They don't save context.                                                                | No                                                  |
| `AGENTS.md`, read natively (v2.1.277+)        | Only when no `CLAUDE.md` exists at that level. With both present, only `CLAUDE.md` is read, unless the `claude-md-and-agents-md` setting is on. | Yes                                                 |
| `AGENTS.md` or `CLAUDE.md` in a subdirectory  | On demand, when Claude reads or edits a file in that directory                                                                                  | AGENTS.md: yes                                      |
| `.claude/rules/*.md` without `paths:`         | At launch                                                                                                                                       | No                                                  |
| `.claude/rules/*.md` with `paths:` globs      | When a matching file is read or edited                                                                                                          | No                                                  |
| Skills                                        | Name and description stay resident (capped at 1,536 characters); the body loads on use                                                          | Partly (the skills format is shared across vendors) |
| A plain markdown link                         | Never automatically. The agent follows it when its task needs it.                                                                               | Yes                                                 |

**Size guidance:** keep `CLAUDE.md` under about 200 lines, and `SKILL.md` under about 500.

## What this means for Docent

- **The root `CLAUDE.md` imports `@AGENTS.md`.** That load is eager, which is fine: `AGENTS.md` is meant to be the resident core. Other vendors read `AGENTS.md` directly.
- **Every folder with an `AGENTS.md` gets a one-line `CLAUDE.md`: `@AGENTS.md`.** Native `AGENTS.md` loading is newer, depends on the Claude Code version, and can be switched off. Nested `CLAUDE.md` loading, by contrast, is long-established. The import guarantees the load, and Codex and other agents still read `AGENTS.md` directly. With a `CLAUDE.md` present, native loading skips the `AGENTS.md`, so it never loads twice. `pnpm verify` checks the pattern. A live check with a real session proves the load itself (`scripts/check-context-loading`).
- **Links in `AGENTS.md` are plain links, not `@` imports,** so `docs/process/` loads only when a task needs it.
- **`.claude/rules` with `paths:` is only for rules that cut across directories,** like "all `*.test.ts` files," and only where a package `AGENTS.md` can't express it. Those rules are Claude-only.

## Measuring a run

- **The final `result` message** of `--output-format json` or `stream-json` carries `total_cost_usd`, `session_id`, `permission_denials`, `duration_ms`, `num_turns`, `usage` and `modelUsage` (confirmed in a real run, see Proven below).
- **A fork's `total_cost_usd` includes the parent session's cost** (see the session spike).
- **The `InstructionsLoaded` hook** fires for each `CLAUDE.md` and rule file that loads, with a reason (`session_start`, `nested_traversal`, `path_glob_match`, `include`, `compact`). It does **not** fire for an `AGENTS.md` read natively.
- **`--bare`** skips `CLAUDE.md`, skills and hooks, for a clean baseline.

## `claude plugin eval`

- **Plugins only.** It runs each case in a fresh sandboxed `claude -p`, 3 runs by default.
- **Graders:** `regex`, `tool_used`, `tool_order`, `file_exists`, `llm`, `baseline`.
- **Comparison:** `--ablation with-without` compares the plugin against no plugin. It has no comparison between a base branch and a PR branch, and it ignores a repo's `CLAUDE.md` and rules.
- **Our use:** right for Docent's own Claude Code plugin; not for the repo harness.

## Proven

**2026-11-06, Claude Code 2.1.319, `pnpm check:context` with Haiku.** A real headless session with an `InstructionsLoaded` hook logged every load:

- **At start:** root `CLAUDE.md` with `load_reason: "session_start"`, then root `AGENTS.md` with `"include"` and `parent_file_path` set to the root `CLAUDE.md`.
- **On first read of a package file:** that package's `CLAUDE.md` with `"nested_traversal"` and `trigger_file_path` set to the file read, plus its `AGENTS.md` with `"include"`. This held for `apps/server`, `apps/web` and `e2e`. So the hook does fire for imports, lazy ones included.
- **Hook input:** the common fields plus `file_path`, `memory_type` (`"Project"`, or `"User"` for `~/.claude/CLAUDE.md`), `load_reason`, and `trigger_file_path` / `parent_file_path` where they apply.
- **The content reached the model.** It answered one question per package that only that package's `AGENTS.md` answers, without opening any instruction file.
- **Nothing loaded twice.** The transcript attached each instruction file once. Native `AGENTS.md` loading added nothing.
- **Negative check:** with `e2e/CLAUDE.md` changed so it no longer imports, `e2e/AGENTS.md` didn't load at all, natively or otherwise. The model said it had no e2e notes, and the check failed as it should. Without the import, nothing loads it.
- **Cost:** about $0.002 per run, 4 turns, about 6 seconds.
