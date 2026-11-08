# Backlog

Ranked. The top unclaimed item is next. Each item states the outcome it buys. Before starting work on an item, add your branch name to it.

1. **Tours that guide instead of narrate.** The first dogfood review found stops that walk through code function by function, without saying what changed or what's worth checking. Write tour prompt v3 on the principle in [`docs/research/2026-11-08-first-dogfood.md`](../docs/research/2026-11-08-first-dogfood.md): behavior change first, then why it matters, then what needs the reviewer's judgment. Mechanics come last, if at all. Measure v2 against v3 on the public fixtures, and don't let defect-finding drop. This needs the eval runner (item 3) first, so build its smallest version as part of this item. _Outcome: a tired reviewer gets the point of each stop from its first sentence. This is the product's core value._
2. **Question path.** Fork the author's session through the Agent SDK, with read-only enforcement and a per-session lock. Use the stack from [`docs/research/2026-11-06-session-spike.md`](../docs/research/2026-11-06-session-spike.md). Integration tests use a fake adapter; one e2e test uses a real session. _Outcome: proves the core bet in-product._
3. **Eval harness, plus the public core fixture set.** The manifest schema, a runner, and 8–10 open-source PRs with known defects. Report quality and cost together. _Outcome: prompt and model changes become measured._ _(First half, fixtures and schema, merged in #6.)_
4. **Design exploration for the tour screen,** before building the real UI. _Outcome: the brief's design bar is set by a mockup, not discovered in code._
5. **Harness evals, version 1.** A small benchmark of repo tasks with mechanical graders, run under the base and branch harness, reporting pass rate, tokens, cost and turns. Design: [`docs/process/harness-evals.md`](../docs/process/harness-evals.md). Add a context-footprint check to `pnpm verify` too: it fails if the always-loaded context (`AGENTS.md` + `CLAUDE.md`) grows past a token budget, the same way bonsai measures its own footprint. _Outcome: harness changes are measured, not guessed._
6. **Mechanical PR risk tiering.** A script that assigns tier 0–2 from changed paths, and posts it to the PR. _Outcome: sampling and trust metrics can run without anyone judging tiers by hand._
7. **Expand CI, now that the public repo gets free minutes:**
   - verify and e2e on Linux and macOS;
   - nightly runs that catch flaky tests;
   - nightly mutation testing;
   - performance budgets.

   Model-backed jobs run on a label or in a merge queue, since fork PRs get no secrets.
8. **First scheduled maintenance agents:** dependency updates, architecture audits against the guards, and doc drift checks (does AGENTS.md still match the code?).
9. **Briefs.** Briefs are triggered by how much the repo changed, not by the calendar. Add a skill that writes them, and keep notes on what the maintainer finds useful.
10. **Dogfood rough edges** from the first review, listed in [`docs/research/2026-11-08-first-dogfood.md`](../docs/research/2026-11-08-first-dogfood.md): stale tours after description edits, re-paying for a tour on every push, uneven citations, process docs labeled "edge", a noisy rebuild on `--prepare`, and cache misses across checkouts. _Outcome: dogfooding stays cheap and trustworthy enough to keep doing._
