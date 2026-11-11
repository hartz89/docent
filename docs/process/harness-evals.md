# Harness evals

**Status:** version 1 is built: a context-footprint check in `pnpm verify`, and a small benchmark (`pnpm bench:harness`). This page is the design; "Version 1" below says what exists.

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

## Version 1

**The context footprint is checked in `pnpm verify`** (`scripts/check-context-footprint.ts`). It sums what loads at the start of every session: the root `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules` files without `paths:`, and everything they `@`-import. It estimates tokens as characters / 4, and fails past `BUDGET_TOKENS`. The budget started about 15% over the size when the check was added. Raising it is a harness change, so the PR says why.

**The benchmark is `pnpm bench:harness`** (`scripts/harness-bench.ts`). It runs each task under the base harness (`--base`, default `origin/main`) and the branch harness (`--head`, default `HEAD`). It prints a markdown table of pass rate, cost, tokens, turns and time, plus each harness's resident context.

- **Six tasks, all graded by script.**
  - Three questions. The reply, minus code fences and quotes, must be exactly the right file or tier.
  - One process rule: the reply must be `pnpm exec tsc --version`, not `npx`.
  - Add agent notes to a folder. The `CLAUDE.md` pairing must pass `check-agents-md`.
  - Add a function with tests. `pnpm verify` must pass, and the tests must fail against a `clamp` that does nothing.
  - Write tasks fail if files outside the task changed. The check compares file hashes taken before the session, held in the runner's memory, so a commit or an edit to `.git` can't hide a change. It runs before any grader runs repo code, so the graders run the repo's own scripts and config, not the agent's. The agent's own tests in `packages/core/src/` do run, outside the sandbox.

  `scripts/harness-bench.test.ts` checks the graders against good and bad work.
- **Each run gets a throwaway copy:** `git archive` of the ref into a temp folder, made a fresh one-commit git repo with no remote, plus `pnpm install` for write tasks. It shares nothing with the real checkout's `.git`. Only committed files are copied.
- **Sessions are locked down.**
  - Read tasks get `Read,Grep,Glob` only.
  - Write tasks add `Edit` and `Write`, limited to the copy, and a `Bash` that always runs in Claude Code's sandbox (`allowUnsandboxedCommands: false`): no writes outside the copy, and no network. `gh`, `git push` and `as-agent` are denied outright.
  - Only the copy's project settings load, never the user's.
- **Spend is capped** by `--max-usd`, default $3. Each session's `--max-budget-usd` is what's left less a $0.25 reserve, and at most twice its fair share, so one runaway can't starve the rest. The reserve is there because Claude Code stops a session only after the turn that crosses its budget. A single turn can cost more than $0.25 (a big cache write on opus, say), so the cap can overshoot by part of one turn. A session cut short fails. A session with no readable result counts its whole budget as spent. Tasks the budget can't cover are listed as skipped, and the totals cover only tasks both harnesses ran.
- **Options:** `--model` (default `sonnet`), `--runs N` to repeat every task, `--only a,b` to pick tasks. The two harnesses take turns going first, so neither always gets a warm prompt cache.

**Not yet:**
- the `InstructionsLoaded` hook and skill counts;
- a no-harness `--bare` arm;
- spread across runs (`--runs` reports means only);
- CI, or a schedule;
- tasks drawn from real agent mistakes.

The user's own `~/.claude/CLAUDE.md` still loads in every run, the same for both arms.

## Runner

**We use our own small runner, the same one the product evals use.** `claude plugin eval` only tests plugins. It can't see a repo's `CLAUDE.md` or `.claude/rules`, and it has no comparison between a base branch and a PR branch. (Research: [`../research/2026-11-06-context-loading.md`](../research/2026-11-06-context-loading.md).) The product evals need a runner anyway, so one runner serves both.

- Runs are headless: `claude -p --output-format stream-json --verbose`.
- From the final `result` message, read the cost, turns, duration and per-turn `usage`.
- An `InstructionsLoaded` hook logs which instruction files loaded. `Skill` tool calls show which skills ran. Together those measure context loaded.
- `--bare` gives a no-harness baseline when we want to measure what the harness adds.

**`claude plugin eval` does fit one thing: the Claude Code plugin Docent ships to users** (channel, session-id hook, batch skill). That plugin gets a suite of its own, with `--ablation with-without`.

## Open questions

- Cost per full run. The benchmark has to stay small enough to run on every harness PR. Version 1 cost $0.45 for all six tasks under both harnesses on sonnet, about 2 minutes.
- Version 1's tasks are easy: both harnesses passed all six on the first real run. Harder tasks, drawn from real agent mistakes, will tell harnesses apart better.
