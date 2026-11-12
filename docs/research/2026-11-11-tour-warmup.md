# Tour warm-up: where the first tour's time goes

2026-11-11 to 11-12. The maintainer worried that reviewers drop off while a fresh tour is written. [#46](https://github.com/hartz89/docent/pull/46)'s tour took 146.6s, with 2 attempts, 16 stops and $1.02 on `claude-opus-5-5`. This note measures where that time goes, and what the change in this PR did about it.

## Method

Every step of a review is now timed (`apps/server/src/timings.ts`), and `docent review --prepare` prints the breakdown. The model runner streams the guide's output token by token (`includePartialMessages`), so we can see when the model starts writing the tour, and when each stop is finished.

Three merged PRs of this repo, run cold: a fresh scratch cache folder each time (fresh checkout, no cached tour), current prompt (v2), `claude-opus-5-5`.

| PR | Size |
|---|---|
| [#38](https://github.com/hartz89/docent/pull/38) | 4 files, 126 changed lines |
| [#43](https://github.com/hartz89/docent/pull/43) | 8 files, 352 changed lines |
| [#40](https://github.com/hartz89/docent/pull/40) | 12 files, 1,017 changed lines |

Total spend for this note: about $3.20, including the eval below. Logs are in the session scratch folder, not committed.

## Where the time goes, before

Seconds from opening the review.

| Step | #38 | #43 | #40 |
|---|---|---|---|
| Fetch the PR, check out the code | 1.7 | 2.2 | 1.9 |
| Parse the diff, build the prompt | <0.1 | <0.1 | <0.1 |
| Attempt 1: guide reads the code (until it starts writing) | 11.4 | 6.7 | 6.5 |
| Attempt 1: guide writes the whole tour | 20.0 | 36.9 | 38.6 |
| Check the tour | <0.1 | <0.1 | <0.1 |
| Attempt 2: full retry | 17.5 | 34.0 | 34.6 |
| **Tour ready, the first thing a reviewer could read** | **50.6** | **79.8** | **81.6** |
| Cost | $0.26 | $0.41 | $0.52 |
| of which the retry | $0.08 (31%) | $0.15 (38%) | $0.16 (30%) |

What this says:

- **Fetching, parsing and checking are free.** Under 2.5s together.
- **The model's first token comes fast,** 1.2 to 2.1s after the call starts (that includes starting the agent process).
- **Reading the code is short:** 6.5 to 11.4s before the guide starts writing.
- **Writing the tour is most of the wait:** 20 to 39s, at roughly 3s per stop. Stop 1 is complete about 3s after writing starts.
- **The retry is the other big block:** 17 to 35s, and a third of the cost, because the guide rewrites every stop to fix a few lines.

So the reviewer waits for the whole tour to be written twice, when stop 1 exists after about 11 to 15s.

## Retries: how often, and why

- **These runs:** 3 of 3 needed a retry.
- **The maintainer's cache:** 7 of the 11 cached tours of this repo needed one.
- **Cause, every time in these runs:** "Unexplained: … has no home." A handful of changed lines (1 to 6 per tour) that no stop cites and no skip covers: an import, a blank line, a CSS rule, a re-export. Never a citation outside a file, never a bad order.

Backlog item 6 (the computed skip ledger) removes this rule, which should remove most retries outright. Until then, each retry costs a full rewrite of the tour.

## What this PR changes

1. **A useful wait screen.** As soon as the PR is read (about 2s), the tour screen opens: the PR's title, description, files and diffstat, and honest progress in the guide's own words ("Planning the route", "Writing stop 3", "Reading src/cors.ts"). No bar and no percentage while the length is unknown.
2. **Stops stream in.** The guide's JSON is read while it's written (`tour-stream.ts`). Each stop that closes goes through the same per-stop checks as the finished tour (citations land on real lines, core and edge stops cite something, kinds in order). Only then is it shown. The first stop that fails stops the stream; later stops wait for the finished tour. No prompt or schema change: the guide already writes stops in order.
3. **Retries repair instead of rewrite.** The guide sends back only the stops it changes, plus the skip list, in the same schema. A stop with an existing title replaces it in place; a new title adds a stop in kind order. The merged tour is checked in full, as before.

One thing we learned building (3): a first version gave repairs their own schema. That changed the session's tool definition, so the resumed session lost its whole prompt cache (cache read 0, 17k tokens rewritten), and the repair cost more than the full retry it replaced ($0.149 against $0.080 on #38). Keeping one schema keeps the cache.

## After

Same PRs, same method.

| | #38 | #43 | #40 |
|---|---|---|---|
| **First readable stop**, before → after | 50.6 → **12.4s** | 79.8 → **21.7s** | 81.6 → **13.2s** |
| Whole tour, before → after | 50.6 → 32.0s | 79.8 → 68.2s | 81.6 → 62.2s |
| Retry, before → after | 17.5s, $0.080 → 4.5s, $0.034 | 34.0s, $0.154 → 13.4s, $0.092 | 34.6s, $0.159 → 15.2s, $0.093 |
| Retry output tokens, before → after | 2,577 → 412 | 5,220 → 1,793 | 5,267 → 2,023 |
| Retry cache read / write | 13.5k / 3.3k → 13.4k / 2.9k | 20.8k / 5.7k → 21.1k / 6.6k | 34.5k / 5.8k → 34.6k / 5.7k |

#43's first stop took longer on this run because the guide read for 17.8s instead of 6.7s; that's run-to-run variance in how much it explores.

**Cost.** The first attempt is byte-for-byte the same request as before, so its cost doesn't change. The after-runs' first attempts read more from the prompt cache only because the same PR had been run within the hour, so their totals ($0.13, $0.25, $0.23) understate a true cold run. The honest comparison is the retry, which is the only call that changed: it costs 40 to 58% less, about $0.05 to $0.07 per tour. Against each PR's before total, that's 13 to 18% cheaper per tour that retries. Streaming adds no calls.

## Quality

The first prompt and schema are unchanged, so a tour that passes on its first attempt is the same tour as before. What changed is how a failing tour gets fixed. Measured with [#21](https://github.com/hartz89/docent/pull/21)'s eval runner (merged locally for the run, prompt v2), on four public fixtures, against #21's own recorded v2 runs:

| Fixture | Attempts | Defect explained | Unfounded opinions | v2 baseline (#21, 2026-11-10) |
|---|---|---|---|---|
| hono-4813-cors-credentials | 1 | 1/1 | 0/5 | 1/1, opinions 1/5 |
| hono-5205-etag-stream-digest | 2 (repaired) | 1/1 | 0/6 | 1/1, opinions 0/6 |
| ky-122-timeout-abort | 1 | 1/1 | 0/3 | 1/1, opinions 0/3 |
| ky-536-unknown-fetch-options | 1 | 0/1 | 1/7 | 1/1, opinions 0/7 |

ky-536's defect needs outside knowledge, and v2 missed it in 3 of #21's 4 recorded runs; this run never reached a repair, so it's the unchanged first prompt varying. First-sentence clarity matched v2's range (neutral check 6/21 here, 11/48 for v2 in #21). Citation validity holds by construction: every tour shown passed the checker, and all three PR tours passed after one repair.

## Against the targets

- **Speed: first readable stop under 30s on a typical PR.** Met: 12 to 22s, from 51 to 82s. The whole tour got faster too (32 to 68s, from 51 to 82s).
- **Cost: no more than +10%.** Met: cheaper. The repair saves $0.05 to $0.07 per retried tour, measured with real cache counts; nothing else adds calls.
- **Quality: no drop.** Held, as above.
- **UX.** Nothing is shown before it passes the same checks as a finished tour. Progress says only what's true. The tour screen keeps its layout from the first second: the route's "in progress" row is the size of a stop, so stops arriving don't move anything. The PR's description and files are readable from about 2s.

## Deferred, with numbers

- **The route first.** Asking the guide for the list of stop titles before the stops would show the whole route about 1s after writing starts. It would not move the first stop much (stop 1 already lands about 3s after writing starts), and it's a prompt and schema change, so it needs its own prompt version and eval. Design: add a `route: {kind, title}[]` field ahead of `stops`, stream it the same way, show the titles as upcoming stops, and check at the end that the stops match the route (a mismatch becomes a repair problem). Worth it once the tour screen shows the route as a plan.
- **A cheaper model for planning.** The guide reads for only 6 to 18s, and a separate planning call on another model would lose the shared prompt cache. Not worth it now.
- **Building tours before anyone asks,** for example for requested reviews. It would make the first open instant, but it spends money on tours nobody may open. If wanted: opt-in, with a daily budget, as a maintainer decision.
- **Fewer retries.** Backlog item 6's computed skip ledger removes the rule that causes every retry seen here.
- **The timing seam.** Spans go through one object (`timings.ts`), so a shared run log can take them over with a one-line change.
