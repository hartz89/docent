# Tour prompt v3: explain, don't narrate

2026-11-08, reworked 2026-11-09. Follows the finding in [`2026-11-08-first-dogfood.md`](2026-11-08-first-dogfood.md): v2 tours walked through code function by function. v3 makes each stop lead with what changed in behavior.

## 2026-11-09: explain, don't advise

### Why it changed

The first v3 (rounds 1 to 3, below) told the docent to "look hard for what could go wrong", and gave every stop a "what's worth checking" step. The maintainer's dogfood review of [PR #21](https://github.com/hartz89/docent/pull/21) found that this leads the reviewer to conclusions and flags concerns that aren't well-founded:

> "One thing to check: editing those shared pieces silently changes v2 too, and only the hash test catches that..." but the fact that the test catches it is more than enough right? This is why i don't want opinions, just explanations. docent is not the reviewer, it's the guide. if a project has an AI reviewer, that's a separate concern. […] "check that nobody relies on the old error" is another example... like does anyone actually rely on it? […] we don't want to instill paranoia in reviewers.

That's the brief's "describe, don't judge, except for obvious, dangerous problems". v3 had drifted from it, and the eval rewarded the drift: its judge scored a stop well for naming "what's worth checking".

### What changed

**The prompt** (v3 was unshipped, so it was edited in place):
- **Each stop:** what changed in behavior (the first sentence, unchanged), then how it connects (facts verified in the code: callers, dependents, the tests that cover it), then mechanics, only if needed.
- **No advice.** No "check that…", no speculative concerns, no hedged risks. If a reader's judgment matters, the facts should make it visible on their own.
- **Gone:** "look hard for what could go wrong", the "what's worth checking" step, and the "check that nobody relies on the old error" example. The verdict question no longer names judgment calls.
- **Kept:** plain words, behavior first, the first-sentence test, no step-by-step narration, the `mismatch` flag (a fact: the description against the code), and the `danger` flag (obvious, dangerous problems only, now with cited evidence).

**The eval** (judge rubric v2, so its scores don't compare with rubric v1's):
- **Defects explained** replaces *surfaced*. A defect counts when a stop accurately explains the behavior where it lives, clearly enough that a reader would see the problem, and that stop cites its lines. The tour doesn't have to call it a problem. The old rubric also counted "points the reviewer at it as worth checking", which rewarded advice.
- **Unfounded opinions** is new, with a target of zero: stops that give review advice, or raise a concern the cited code doesn't establish.
- **The neutral check** is now part of the runner (`src/neutral.ts`), not a one-off script: each fixture's first sentences from both prompts, backticks stripped, mixed in one list, with one plain question.
- **The judge still never sees the prompt** or which version wrote a tour.

### Results

Two A/B runs of v2 against the new v3 over the same 9 fixtures: [run 1](evals/2026-11-10-tours-v2-v3-explain.md), [run 2](evals/2026-11-10-tours-v2-v3-explain-run2.md). The old v3 (round 3) tours, from the cache, were re-judged under rubric v2 by a one-off script ($0.39) as a baseline for opinions.

| | v2 (run 1 / 2) | old v3, re-judged | **new v3 (run 1 / 2)** |
|---|---|---|---|
| Defects explained, cited (7 in-repo) | 5 / 5 | 6 | **4 / 4** |
| Stops with an unfounded opinion | 1 of 48 / 3 of 54 | **20 of 43 (47%)** | **1 of 46 / 0 of 46** |
| First sentence clear to a blind reader (neutral) | 23% / 30% | not run | **78% / 89%** |
| First sentence states the behavior change (judge) | 23% / 22% | not run | 80% / 85% |
| First sentence names no code (script) | 6% / 11% | | 57% / 59% |
| Within 5 sentences and 100 words (script) | 85% / 87% | | 87% / 96% |
| Danger flags missed / false alarms | 0 / 0, 0 / 0 | | 1 / 0, 0 / 0 |
| Tour cost, 9 fixtures | $1.52 / $1.03 | | $1.61 / $1.09 |

**Opinions are gone.** The old v3 gave advice or an unbacked concern in nearly half its stops ("Check whether that override is acceptable", "check that separators line up"). The new v3 had one in 92 stops, and that one is borderline: "anything that matched the old wording will no longer match" follows from the change, but the judge wanted a cited dependent. v2 had 4 in 102.

**Clarity holds.** The neutral check gives 78% and 89% for v3, against 23% and 30% for v2, close to round 3's 81% against 28%.

### The regression: v3 explains fewer defects

**v3 explained 4 of 7 in both runs, against 5 of 7 for v2 and 6 of 7 for the old v3.** That's a real drop, and two runs say it isn't only noise.
- **hono-5205 (ETag buffer reuse): v3 missed it both times, and v2 found it both times.** v3 says small chunks are copied and whole blocks hashed in place, but never says a leftover partial chunk is kept as a view across reads. That's the defect.
- **graphql-scalars ReDoS:** v3 missed it in run 1, and its danger flag with it. It explained the regex's loose matching but not its backtracking. It found both in run 2.
- **hono-4267:** v2 missed it both times, and v3 missed it once.
- **yargs-766:** every prompt missed it in every run, including the old v3 (round 3 found half).

The likely cause is the dropped "look hard for what could go wrong". It made the docent probe edge cases, such as reused buffers and pathological input, and those are where these defects live. Explaining the happy path accurately doesn't reach them. This is a tradeoff, not a bug in the rubric: the same instruction that found more defects also produced the advice the maintainer doesn't want. The fix this note would try next is to tell the docent to *verify* behavior at the edges (large or malformed input, partial reads, errors), and state what it finds as fact. That's a prompt change, so it needs its own A/B. It wasn't tried here, to keep this change to what was asked.

### Caveats

- **The defects count is coarse.** 7 defects and two runs per prompt. One defect moves the score by 14 points.
- **The judge's line is fuzzy at the edges.** "This could break X" is an opinion; "both callers catch the old error, which is no longer thrown" is a fact. The judge was strict on one v3 stop, and is uncalibrated against the maintainer.
- **Explained is stricter than surfaced.** The stop the judge names must also cite the defect's lines, so the new numbers don't compare with rounds 1 to 3.
- **The verdict_prompt stop isn't graded** for opinions. A leading closing question wouldn't be caught.

### Spend

$7.79 for this rework: $4.19 and $3.21 for the two A/B runs (tours, judge and neutral check), and $0.39 to re-judge the old v3 tours. The cap was $15.

## History: rounds 1 to 3 (2026-11-08)

These numbers use judge rubric v1, which rewarded "names what to check". They're kept for the record; the new rubric doesn't compare.

v3 went through three drafts. Each draft ran once over the 9 fixtures, and v2 ran twice.
- **Round 1** was the first draft (commit `e786fd5` on PR #21's branch).
- **Round 2** added guidance for map and test stops.
- **Round 3** dropped a list of "what to look for" that lined up too closely with the fixture defects, and narrowed "say when nothing needs a judgment call", which read like a soft verdict.

Full tables: [round 1](evals/2026-11-08-tours-v2-v3-round1.md), [round 2](evals/2026-11-08-tours-v2-v3-round2.md), and round 3 in two parts ([8 fixtures](evals/2026-11-08-tours-v3-round3.md) and [yargs](evals/2026-11-08-tours-v3-round3-yargs.md)).

| | v2 (run 1) | v2 (run 2) | v3 r1 | v3 r2 | v3 r3 |
|---|---|---|---|---|---|
| Defects surfaced (judge, rubric v1) | 7/7 | 6/7 | 7/7 | 7/7 | 6/7 |
| Danger flags missed / false alarms | 0 / 0 | 1 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| First sentence states the behavior change (judge) | 12% | 17% | 66% | 83% | 81% |
| Names what to check, or says nothing needs it (judge) | 63% | 58% | 77% | 76% | 74% |
| First sentence names no code (script) | 0% | 8% | 72% | 71% | 56% |
| Tour cost, 9 fixtures | $1.44 | $1.04 | $1.63 | $1.53 | $1.61 |

**The neutral check started here.** The judge's behavior-first question echoes v3's own wording, so a blind check read only first sentences, backticks stripped, v2 and v3 shuffled together, with one question: "Reading only this sentence, can you tell what this change does for a user or caller of the code?" v2 scored 28% (15/53) and round-3 v3 scored 81% (35/43).

The "Names what to check" row is the metric this rework removed. Round 3's 74% is the same behavior the re-judge above counts as 47% unfounded opinions.

Spend for rounds 1 to 3: about $9.50.

## What's still weak

- **Calibration.** The judge hasn't been checked against the maintainer's own reading. The `Docent feedback:` replies on dogfooded PRs are that check.
- **Code names in the lead.** About 40% of v3 first sentences still trip the script. Most are user-facing names, like a header, a path or an option, which the script can't tell from function names. The neutral check is the better signal.
- **Only the first prompt is versioned.** The schema, checker and retry prompt are shared by every version, so an A/B compares first prompts only.

## Decisions

- **Ship the reworked v3 as `TOUR_PROMPT_VERSION = 3`.** The maintainer's call is explain-only, and v3 now meets it: almost no opinions, and clarity well above v2. The cost is one defect in seven against v2, and it's recorded above, not hidden.
- **v2 stays in `TOUR_PROMPTS`,** frozen by a hash test, so the A/B can be rerun.
- **Next:** try "verify the edges, state what you find" as its own prompt version, and add harder in-repo defects so the eval can tell one defect's difference from noise.
