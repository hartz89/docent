# First dogfood: tours narrate when they should guide

2026-11-08. The maintainer reviewed [#14](https://github.com/hartz89/docent/pull/14) through Docent: the first real review of a real PR, done late in the day, which is how reviews actually happen.

## What happened

One stop read:

> `serve()` holds the old top-level flow unchanged: start the server, print the token link, open the browser, and register the SIGINT/SIGTERM handlers. The old inline subscribe logging moved into `report()` with the same messages. `prepare()` calls `report()`, then awaits `review.done` […] It flushes stdout, then calls `process.exit` with 0 or 1, so leftover agent subprocesses can't keep the process alive.

Every sentence is accurate and cited. The reviewer still couldn't get anything out of it. The stop walks through the code function by function. It never says what changed for a user, or which part needs a human's judgment. The one judgment call, a deliberate force-quit, is in the last clause.

What the stop should have said:

> **The CLI now has two modes.** Normal mode is unchanged. The new prepare mode builds the tour and exits. It force-quits on purpose, so stray agent processes can't hang it. That exit is the one thing worth checking.

## Why it happened

The tour prompt (`apps/server/src/tour.ts`, `TOUR_PROMPT_VERSION = 2`) opens its writing rules with "Describe, never judge." That rule exists so the docent never issues a verdict. Combined with "every claim cites lines" and a script that checks every changed line is covered, it pushes the model toward transcription: say what each piece of code does, in order.

The prompt doesn't separate two things:
- **Judging:** "this is fine", "approve". That's the reviewer's call, and the docent should never make it.
- **Guiding:** "this is the part that needs your judgment, and here's why". That's the docent's whole job. A museum docent doesn't paint, but it does tell you where to look.

## The principle

Each stop answers, in this order:
1. **What changed in behavior,** in one sentence a tired reviewer gets on first read. Use user or caller terms, not function names.
2. **Why it matters:** what it connects to, and what would break.
3. **What's worth checking,** if anything: the judgment call, the risky assumption, the place the description and code disagree. Say "nothing here needs a judgment call" when that's true. Pointing at a risk is not a verdict.
4. **Mechanics,** only where they're needed to check point 3, and briefly. The citations carry the detail; the prose doesn't have to.

**The test:** read only the first sentence of each stop. If that tells you what the PR does and where to look, the tour works.

## How we'll know it's better

This is a prompt change, so measure it rather than argue it. Run tour prompt v2 against a v3 that follows the principle above, on the public eval fixtures. Score both on:
- **Mechanical checks,** where scripts can decide: the first sentence names no function or identifier; stops stay within length.
- **A model judge,** where scripts can't: "Does the first sentence state the behavior change?" and "Does the stop name what's worth checking, or say nothing is?"
- **Human samples:** the maintainer's `Docent feedback:` replies on dogfooded PRs (see `docs/process/pull-requests.md`).

Defect-finding must not get worse. A clearer tour that misses more problems is a regression.

## Other rough edges from this review

- **Editing a PR's description doesn't refresh its cached tour.** The cache key is base, head, model and prompt version, so the tour still quotes the old description.
- **Each push throws away the prepared tour.** A review-then-fix cycle paid for two tours, about $0.40 in total.
- **Citations are uneven:** one-line ranges (`cli.ts:2-2`), overlapping ranges, a whole test file, one range nested inside another.
- **A process-doc change was labeled "edge"** when it was half the PR. The prompt's stop kinds treat docs as peripheral.
- **`--prepare` rebuilds the whole web app,** and the build output is noisy.
- **The cache only hits when everything matches.** A different prompt version or `DOCENT_MODEL` setting in the reviewer's checkout misses it and pays for a fresh tour.
