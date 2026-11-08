# Tour prompt v3: guide, don't narrate

2026-11-08. Follows the finding in [`2026-11-08-first-dogfood.md`](2026-11-08-first-dogfood.md): v2 tours walked through code function by function. v3 rewrites the writing rules on that note's principle, and the new tour eval measures both.

## What changed in the prompt

- **Judging and guiding are now separate rules.** "Describe, never judge" became "Never judge" (no verdicts, no praise) plus "Always guide" (say where the reviewer's judgment is needed). Pointing at a risk is not a verdict.
- **Each stop has a fixed order:** what changed in behavior, why it matters, what's worth checking (or "nothing needs a judgment call"), and mechanics last, if at all.
- **The first sentence names no code.** It says the outcome a user or caller notices. Map stops lead with the behaviors that change; test stops lead with the behavior the tests lock in.
- **Bodies stay under 90 words,** and the intro asks the guide to look for what could go wrong.
- **The coverage rules, schema, stop kinds and checker are unchanged.**

The prompt's examples are deliberately not taken from any eval fixture, so the A/B doesn't reward the prompt for knowing the answers.

## How it was measured

`pnpm eval:tours --prompt v2 --prompt v3` runs the server's real tour job over the 9 public fixtures that exercise the tour (`vite-4118` is skip-only). Tour model `claude-opus-5-5`, judge `claude-sonnet-5`. Each run is one tour per fixture and prompt. Details: [`packages/evals/AGENTS.md`](../../packages/evals/AGENTS.md).

- **Surfaced** is the headline defect number: the judge says some stop states the defect or points the reviewer at it.
- **Cited** is the manifest's line-overlap scoring. The coverage rules make nearly every changed line cited, so it can't tell the two prompts apart.

## Results

Round 2 is the final v3. Round 1 was the first draft, kept for honesty. Its v3 text is in commit `828d26d`. Full tables: [round 1](evals/2026-11-08-tours-v2-v3-round1.md), [round 2](evals/2026-11-08-tours-v2-v3-round2.md).

| | v2 (r1) | v3 (r1) | v2 (r2) | v3 (r2, final) |
|---|---|---|---|---|
| Defects surfaced (judge) | 7/7 | 7/7 | 6/7 | 7/7 |
| External-knowledge defect surfaced | 0/1 | 0/1 | 0/1 | 0/1 |
| Danger flags missed / false alarms | 0 / 0 | 0 / 0 | 1 / 0 | 0 / 0 |
| First sentence names no code (script) | 0% | 72% | 8% | 71% |
| First sentence states the behavior change (judge) | 12% | 66% | 17% | 83% |
| Names what to check, or says nothing needs it (judge) | 63% | 77% | 58% | 76% |
| Within 5 sentences and 100 words (script) | 90% | 87% | 89% | 83% |
| Tour cost, 9 fixtures | $1.44 | $1.63 | $1.04 | $1.53 |
| Judge cost | $0.41 | $0.36 | $0.46 | $0.33 |

**Defect-finding didn't drop.** v3 surfaced every in-repo defect in both rounds. v2 missed one in round 2: the graphql-scalars ReDoS, plus its danger flag. Neither prompt surfaced the ky-536 defect, which needs knowledge of how other fetch implementations treat a second argument.

**The two v2 runs differ,** and the differences are run-to-run noise: one defect, one danger flag, and 5 points on the judge's behavior-first score. So treat gaps of a few points as noise. The behavior-first gap is 54 to 66 points, far outside that.

## What a stop looks like now

The same defect in vite#15365, where editing `.env` stops restarting the dev server:

> **v2:** `handleHMRUpdate` builds `fileName = path.basename(file)` at line 67. It then checks `getEnvFilesForMode(config.mode, config.envDir).includes(fileName)`. Since the helper now returns absolute paths, a basename like `.env` will never be in that list […]

> **v3:** Editing an env file looks like it will no longer trigger a server restart. The restart check compares the new list of absolute paths against the changed file's bare name, and those can never be equal. Check whether this should compare against `file`. […]

## What's still weak

- **Code names in the lead.** About 30% of v3 first sentences still name code. Most are user-facing names, like a header, a path or an option (`Vary: Origin`, `/index`). The script can't tell those from function names. The judge passes most of them, which is the better signal.
- **Length.** v3 bodies run slightly longer: 83% are within limits, against 89% for v2.
- **Cost.** v3 tours cost 12% (round 1) to 47% (round 2) more. That's about 5 cents a tour. Part of it is v3 looking harder for risks; part is noise.
- **Small sample.** There are 9 fixtures, run once each per round. The quality gap is large enough to trust. The defect numbers are only good enough to say "no drop".
- **The judge is one model with one rubric.** It hasn't been checked against the maintainer's own reading. The `Docent feedback:` replies on dogfooded PRs are that check.

## Decisions

- **Ship v3 as `TOUR_PROMPT_VERSION = 3`.** v2 stays in `TOUR_PROMPTS`, frozen by a hash test, so this A/B can be rerun.
- **Stop after two rounds.** Round 2 met the bar (no defect drop, a large clarity gain). A third round would chase a few points that are within noise.
- **The judge also scores defects.** Line overlap can't separate the prompts (see above), so "surfaced" is the headline.
- **Spend:** about $7.40 in total, including a $0.16 smoke run, against a $12 budget.
