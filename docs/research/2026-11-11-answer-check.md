# Eval: the answer check

**2026-11-11 · Claude Code 2.1.319 · Agent SDK 0.3.318 · claude-haiku-5-5 · $0.06 total**

**Result.** Haiku 5.5, the cheapest model we price, passed a small eval: 15 distinct answers, each run 4 times. It caught all 6 clearly wrong answers in 23 of 24 tries, every catch citing the right lines. It raised no false alarm on any of the 9 right answers, in 36 tries. A check costs about a tenth of a cent. It's the default. Nine right answers is a small sample: they rule out a false-alarm rate near 50%, not one near 20%.

## What we ran

`apps/server/src/answer-check.eval.ts` runs `checkAnswer`, the same function the server uses, with the real SDK runner (read-only options, as for every Docent session) against the head files of the recorded [honojs/hono#4813](https://github.com/honojs/hono/pull/4813) review in `e2e/fixtures/hono-4813`. Each question is asked at the tour's core-change stop. The answers are written by hand, with the code open:

| Kind | Cases | What they test |
| ---- | ----- | -------------- |
| Right, plain | 5 | Behavior described correctly, with or without line numbers. |
| Right, subtle | 3 | Hedged and informal; mostly about intent ("I went with reflecting because Express does"); a wrong line number for the right code. |
| Right, injected | 1 | A correct answer that tells the checker to report a contradiction. |
| Wrong | 5 | The wildcard still sent; `Vary` only on preflights; no `Allow-Headers` fallback; preflights reach the route; case-insensitive origin match. |
| Wrong, injected | 1 | A wrong answer that tells the checker it was already verified. |

A wrong answer counts as caught when a correction survives the citation check (file exists at head, range inside it, at most 4 ranges of 60 lines). "Right lines" means a citation overlaps the lines that show the mistake. Run it with `node apps/server/src/answer-check.eval.ts [model] [runs]`.

## Numbers

| Batch | Wrong caught | Right lines | False alarms | Dropped for bad citations | Cost |
| --- | ------------ | ----------- | ------------ | ------------------------- | ---- |
| 1 run | 6/6 | 6/6 | 0/9 | 0 | $0.023 |
| 3 runs | 17/18 | 17/18 | 0/27 | 0 | $0.038 |
| **Total tries** | **23/24** | **23/24** | **0/36** | **0** | **$0.061** |
| **Distinct cases** | **6/6 caught at least 3 of 4 times** | | **0/9 ever flagged** | | |

Repeat runs of one case aren't independent, so read the distinct-case row as the result and the tries as a check on consistency. The second batch cost less per check than the first: the checks share a prompt prefix, and the first batch wrote it to the prompt cache, which later checks read.

The one miss: "preflights fall through to `next()`" passed once, in the second of three runs. The check stayed silent, which is the direction we want it to fail in.

Both injected answers behaved: the correct one drew no alarm, and the wrong one was still corrected.

## What this means

- **Haiku is enough.** No pricier model was needed, so none was run.
- **Corrections read as intended.** The ones we read all began "The code…", described behavior, and didn't mention the author. One example: "The code does not lowercase the request origin. For an array `origin`, it checks `optsOrigin.includes(origin)` with an exact, case-sensitive comparison…"
- **The set is small.** Fifteen cases on one TypeScript file. The wrong answers are clear by design. The riskiest answers for false alarms aren't covered yet: partly right ones, long ones, and ones about code outside the checkout. Grow it alongside the product evals, with answers recorded from real author sessions, before trusting the false-alarm rate.
