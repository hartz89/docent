# Backlog

Ranked. The top unclaimed item is next. Each item states the outcome it buys. Before starting work on an item, add your branch name to it.

1. **Tours that guide instead of narrate.** The first dogfood review found stops that walk through code function by function, without saying what changed or what's worth checking. Write tour prompt v3 on the principle in [`docs/research/2026-11-08-first-dogfood.md`](../docs/research/2026-11-08-first-dogfood.md): behavior change first, then why it matters, then what needs the reviewer's judgment. Mechanics come last, if at all. Measure v2 against v3 on the public fixtures, and don't let defect-finding drop. This needs the eval runner (item 4) first, so build its smallest version as part of this item. _Outcome: a tired reviewer gets the point of each stop from its first sentence. This is the product's core value._
2. **Inline code references in stop prose.** When a stop mentions a function or a piece of logic, hovering that phrase highlights the exact lines in the code view. Use them sparingly, only where they help: a few per stop at most, never every identifier. The prose stays plain and the detail lives one hover away, which suits the principle in item 1.
   - **Model output:** spans in the stop body that point to `{path, side, startLine, endLine}`. They're checked by the same validator as stop citations: a reference must land on real lines in the diff or its context.
   - **Core:** a stop body becomes text plus reference spans. References heal like stop anchors, and a reference whose code is gone is flagged as out of date, never left pointing at the wrong lines. This is a contract change (tier 2a).
   - **UI:** hover and keyboard focus both highlight, and a tap on mobile does too. The highlight scrolls the code into view if needed. Fold it into the tour-screen design (item 5).
   - **Measure:** run after item 1, as its own prompt version against the same fixtures, so the gain can be credited to the right change. Check the density stays low and the references resolve.

   _Outcome: tours point at code at the level of a phrase, not just a stop._
3. **Question path.** _(Branch `question-path`.)_ Fork the author's session through the Agent SDK, with read-only enforcement and a per-session lock. Use the stack from [`docs/research/2026-11-06-session-spike.md`](../docs/research/2026-11-06-session-spike.md). Integration tests use a fake adapter; one e2e test uses a real session. _Outcome: proves the core bet in-product._
4. **Eval harness, plus the public core fixture set.** The manifest schema, a runner, and 8–10 open-source PRs with known defects. Report quality and cost together. _Outcome: prompt and model changes become measured._ _(First half, fixtures and schema, merged in #6.)_
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
11. **Dogfood rough edges** from the first review, listed in [`docs/research/2026-11-08-first-dogfood.md`](../docs/research/2026-11-08-first-dogfood.md): stale tours after description edits, re-paying for a tour on every push, uneven citations, process docs labeled "edge", a noisy rebuild on `--prepare`, and cache misses across checkouts. _Outcome: dogfooding stays cheap and trustworthy enough to keep doing._
12. **Cheaper questions on long author sessions.** A question forked from a 250k-token session cost $1.63, and a second question two minutes later cost the same: each fork wrote about 196k tokens of prompt cache instead of reading the last fork's. Find out why the cache isn't reused, and try forking at the PR's last message or a cheaper model for questions. Check the session's size before forking too, since a session big enough to hit the $2 cap fails and then falls back to the guide, after paying. Evidence: [`docs/research/2026-11-08-question-path-live.md`](../docs/research/2026-11-08-question-path-live.md). _Outcome: asking the author costs cents, not dollars._
