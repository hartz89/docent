# Harness evals

**Status:** planned (backlog). This page is the design.

The harness is everything that shapes how agents work on this repo: `AGENTS.md`, `CLAUDE.md`, skills, hooks, rules, scripts and settings. It's code, and changes to it can make agents worse without anyone noticing. So a harness change has to show it doesn't regress agent performance, and has to measure any improvement it claims.

## Shape

**The first harness eval exists:** `pnpm check:context` (`scripts/check-context-loading.ts`). It runs one real session and proves every `AGENTS.md` loads and reaches the model. It's a smoke check, not yet the benchmark described below.

- **A benchmark of real repo tasks.** Each task is a small, representative job with a mechanical grader. Examples: add a route with an integration test; fix a planted bug and add its regression test; refactor without crossing the core boundary. Tasks come from real backlog items and from mistakes agents actually made, the same way product fixtures come from real PRs.
- **Graders are mechanical first:**
  - `pnpm verify` passes
  - the expected test exists and fails without the fix
  - no forbidden imports
  - only the expected files changed

  An LLM judge is used only for what a script can't grade, such as PR description quality, against a written rubric.
- **Measured per run:** pass rate, tokens, cost, turns, wall-clock time, and how much context loaded up front.
- **Compare base against branch.** Run each task several times under the base harness and the PR's harness, because agent runs vary. Report the difference with its spread, not a single run.
- **When it runs:**
  - on every tier 2 harness PR;
  - on a schedule, to catch drift from model or Claude Code updates.

  Runs execute headlessly in throwaway worktrees, with read-only access to everything outside the worktree.

## Runner

**We use our own small runner, the same one the product evals use.** `claude plugin eval` only tests plugins. It can't see a repo's `CLAUDE.md` or `.claude/rules`, and it has no comparison between a base branch and a PR branch. (Research: [`../research/2026-11-06-context-loading.md`](../research/2026-11-06-context-loading.md).) The product evals need a runner anyway, so one runner serves both.

- Runs are headless: `claude -p --output-format stream-json --verbose`.
- From the final `result` message, read the cost, turns, duration and per-turn `usage`.
- An `InstructionsLoaded` hook logs which instruction files loaded. `Skill` tool calls show which skills ran. Together those measure context loaded.
- `--bare` gives a no-harness baseline when we want to measure what the harness adds.

**`claude plugin eval` does fit one thing: the Claude Code plugin Docent ships to users** (channel, session-id hook, batch skill). That plugin gets a suite of its own, with `--ablation with-without`.

## Open questions

- Cost per full run. The benchmark has to stay small enough to run on every harness PR.
