# First dogfood: tours narrate when they should guide

2026-11-08. The maintainer reviewed [#14](https://github.com/hartz89/docent/pull/14) through Docent: the first real review of a real PR, done late in the day, which is how reviews actually happen.

## What happened

One stop read:

> `serve()` holds the old top-level flow unchanged: start the server, print the token link, open the browser, and register the SIGINT/SIGTERM handlers. The old inline subscribe logging moved into `report()` with the same messages. `prepare()` calls `report()`, then awaits `review.done` […] It flushes stdout, then calls `process.exit` with 0 or 1, so leftover agent subprocesses can't keep the process alive.

Every sentence is accurate and cited. The reviewer still couldn't get anything out of it. The stop walks through the code function by function. It never says what changed for a user, or which part needs a human's judgment. The one judgment call, a deliberate force-quit, is in the last clause.

What the stop should have said:

> **The CLI now has two modes.** Normal mode is unchanged. The new prepare mode builds the tour and exits. It force-quits on purpose, so stray agent processes can't hang it. That exit is the one thing worth checking.

(2026-11-09: under the corrected principle below, that last sentence goes. The stop states the force-quit as a fact, and the reviewer decides whether it matters.)

## Why it happened

The tour prompt (`apps/server/src/tour.ts`, `TOUR_PROMPT_VERSION = 2`) opens its writing rules with "Describe, never judge." That rule exists so the docent never issues a verdict. Combined with "every claim cites lines" and a script that checks every changed line is covered, it pushes the model toward transcription: say what each piece of code does, in order.

The prompt doesn't separate two things:
- **Judging:** "this is fine", "approve". That's the reviewer's call, and the docent should never make it.
- **Guiding:** "this is the part that needs your judgment, and here's why". That's the docent's whole job. A museum docent doesn't paint, but it does tell you where to look.

## The principle

> **Corrected 2026-11-09.** The first version of this principle had a step for "what's worth checking": the judgment call, the risky assumption. Prompt v3 followed it, and the maintainer's next review found tours that led the reviewer to conclusions and flagged concerns that weren't well-founded ("check that nobody relies on the old error", when nothing did). That breaks the brief's "describe, don't judge". Docent is the guide, not the reviewer. An AI reviewer, if a project wants one, is a separate concern. The principle is now explain-only.

Each stop answers, in this order:
1. **What changed in behavior,** in one sentence a tired reviewer gets on first read. Use user or caller terms, not function names.
2. **How it connects:** facts verified in the code, such as who calls it, what depends on it, and which tests cover it. Stated as facts, never as warnings.
3. **Mechanics,** only where needed, and briefly. The citations carry the detail; the prose doesn't have to.

No review advice, no speculative concerns, no hedged risks. If the reviewer's judgment matters, the facts should make that visible on their own. Two flags stay, because they're facts: "mismatch" (the description against the code) and "danger" (obvious, dangerous problems only, with cited evidence).

**The test:** read only the first sentence of each stop. If that tells you what the PR does, the tour works.

## How we'll know it's better

This is a prompt change, so measure it rather than argue it. Run tour prompt v2 against a v3 that follows the principle above, on the public eval fixtures. Score both on:
- **Mechanical checks,** where scripts can decide: the first sentence names no function or identifier; stops stay within length.
- **A model judge,** where scripts can't: "Does the first sentence state the behavior change?" and (since 2026-11-09) "Does the stop give advice or a concern the code doesn't back?"
- **Human samples:** the maintainer's `Docent feedback:` replies on dogfooded PRs (see `docs/process/pull-requests.md`).

Defect-finding must not get worse. A clearer tour that misses more problems is a regression.

## Other rough edges from this review

- **Editing a PR's description doesn't refresh its cached tour.** The cache key is base, head, model and prompt version, so the tour still quotes the old description.
- **Each push throws away the prepared tour.** A review-then-fix cycle paid for two tours, about $0.40 in total.
- **Citations are uneven:** one-line ranges (`cli.ts:2-2`), overlapping ranges, a whole test file, one range nested inside another.
- **A process-doc change was labeled "edge"** when it was half the PR. The prompt's stop kinds treat docs as peripheral.
- **`--prepare` rebuilds the whole web app,** and the build output is noisy.
- **The cache only hits when everything matches.** A different prompt version or `DOCENT_MODEL` setting in the reviewer's checkout misses it and pays for a fresh tour.

## Result

Tour prompt v3 follows the corrected principle (2026-11-09). In a neutral, blind check, 78 to 89% of its first sentences read clearly to a reader, against 23 to 30% for v2. Stops with review advice or unbacked concerns fell from 47% (the first v3) to 1 in 92. Defect-finding dropped: v3 explained 4 of 7 planted defects in each of two runs, against 5 of 7 for v2. Numbers and caveats: [`2026-11-08-tour-prompt-v3.md`](2026-11-08-tour-prompt-v3.md).
