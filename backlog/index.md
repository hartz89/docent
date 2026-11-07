# Backlog

Ranked. The top unclaimed item is next. Each item states the outcome it buys. Before starting work on an item, add your branch name to it.

1. **Thin path through the whole loop.** `docent review <PR>` → fetch the PR with `gh` → one tour from a model call → shown in the web app. Ugly is fine, as long as it's real end to end. Log cost from the first call. _Outcome: every later piece has somewhere to plug in._
2. **Core data model.** Review, tour stop with its anchor, question thread, batch, and cost record, written as types that can't represent bad states. Property tests for the anchor and diff-coverage rules. _(SDD experiment: approach C, spec-anchored.)_ Branch: `core/data-model`.
3. **Question path.** Fork the author's session through the Agent SDK, with read-only enforcement and a per-session lock. Use the stack from [`docs/research/2026-11-06-session-spike.md`](../docs/research/2026-11-06-session-spike.md). Integration tests use a fake adapter; one e2e test uses a real session. _Outcome: proves the core bet in-product._
4. **Eval harness, plus the public core fixture set.** The manifest schema, a runner, and 8–10 open-source PRs with known defects. Report quality and cost together. _Outcome: prompt and model changes become measured._
5. **Design exploration for the tour screen,** before building the real UI. _Outcome: the brief's design bar is set by a mockup, not discovered in code._
6. **Harness evals, version 1.** A small benchmark of repo tasks with mechanical graders, run under the base and branch harness, reporting pass rate, tokens, cost and turns. Design: [`docs/process/harness-evals.md`](../docs/process/harness-evals.md). Add a context-footprint check to `pnpm verify` too: it fails if the always-loaded context (`AGENTS.md` + `CLAUDE.md`) grows past a token budget, the same way bonsai measures its own footprint. _Outcome: harness changes are measured, not guessed._
7. **Mechanical PR risk tiering.** A script that assigns tier 0–2 from changed paths, and posts it to the PR. _Outcome: sampling and trust metrics can run without anyone judging tiers by hand._
8. **Expand CI, now that the public repo gets free minutes:**
   - verify and e2e on Linux and macOS;
   - nightly runs that catch flaky tests;
   - nightly mutation testing;
   - performance budgets.

   Model-backed jobs run on a label or in a merge queue, since fork PRs get no secrets.
9. **First scheduled maintenance agents:** dependency updates, architecture audits against the guards, and doc drift checks (does AGENTS.md still match the code?).
10. **Briefs.** Briefs are triggered by how much the repo changed, not by the calendar. Add a skill that writes them, and keep notes on what the maintainer finds useful.
