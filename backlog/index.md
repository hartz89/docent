# Backlog

Ranked. The top unclaimed item is next. Each item states the outcome it buys. Before starting work on an item, add your branch name to it.

1. **Question path.** Fork the author's session through the Agent SDK, with read-only enforcement and a per-session lock. Use the stack from [`docs/research/2026-11-06-session-spike.md`](../docs/research/2026-11-06-session-spike.md). Integration tests use a fake adapter; one e2e test uses a real session. _Outcome: proves the core bet in-product._
2. **Eval harness, plus the public core fixture set.** The manifest schema, a runner, and 8–10 open-source PRs with known defects. Report quality and cost together. _Outcome: prompt and model changes become measured._ _(First half, fixtures and schema, merged in #6.)_
3. **Design exploration for the tour screen,** before building the real UI. _Outcome: the brief's design bar is set by a mockup, not discovered in code._
4. **Harness evals, version 1.** A small benchmark of repo tasks with mechanical graders, run under the base and branch harness, reporting pass rate, tokens, cost and turns. Design: [`docs/process/harness-evals.md`](../docs/process/harness-evals.md). Add a context-footprint check to `pnpm verify` too: it fails if the always-loaded context (`AGENTS.md` + `CLAUDE.md`) grows past a token budget, the same way bonsai measures its own footprint. _Outcome: harness changes are measured, not guessed._
5. **Mechanical PR risk tiering.** A script that assigns tier 0–2 from changed paths, and posts it to the PR. _Outcome: sampling and trust metrics can run without anyone judging tiers by hand._
6. **Expand CI, now that the public repo gets free minutes:**
   - verify and e2e on Linux and macOS;
   - nightly runs that catch flaky tests;
   - nightly mutation testing;
   - performance budgets.

   Model-backed jobs run on a label or in a merge queue, since fork PRs get no secrets.
7. **First scheduled maintenance agents:** dependency updates, architecture audits against the guards, and doc drift checks (does AGENTS.md still match the code?).
8. **Briefs.** Briefs are triggered by how much the repo changed, not by the calendar. Add a skill that writes them, and keep notes on what the maintainer finds useful.
