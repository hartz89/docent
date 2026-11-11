# Eval: the answer check

**2026-11-11 · Claude Code 2.1.319 · Agent SDK 0.3.318 · claude-haiku-5-5 · $0.06 total**

**Result.** Haiku 5.5, the cheapest model we price, caught 23 of 24 clearly wrong answers, every catch citing the right lines, and raised no false alarms in 36 checks of right answers. A check costs about a tenth of a cent. It's the default.

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

| Run | Wrong caught | Right lines | False alarms | Dropped for bad citations | Cost |
| --- | ------------ | ----------- | ------------ | ------------------------- | ---- |
| 1 run | 6/6 | 6/6 | 0/9 | 0 | $0.023 |
| 3 runs | 17/18 | 17/18 | 0/27 | 0 | $0.038 |
| **Total** | **23/24** | **23/24** | **0/36** | **0** | **$0.061** |

The one miss: "preflights fall through to `next()`" passed once, in the second of three runs. The check stayed silent, which is the direction we want it to fail in.

Both injected answers behaved: the correct one drew no alarm, and the wrong one was still corrected.

## What this means

- **Haiku is enough.** No pricier model was needed, so none was run.
- **Corrections read as intended.** The ones we read all began "The code…", described behavior, and didn't mention the author. One example: "The code does not lowercase the request origin. For an array `origin`, it checks `optsOrigin.includes(origin)` with an exact, case-sensitive comparison…"
- **The set is small.** Fifteen cases on one TypeScript file. The wrong answers are clear by design; borderline answers (partly right, about code outside the checkout) aren't covered yet. Worth growing alongside the product evals, especially with answers recorded from real author sessions.
