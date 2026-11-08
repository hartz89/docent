# Tour prompt v3: guide, don't narrate

2026-11-08. Follows the finding in [`2026-11-08-first-dogfood.md`](2026-11-08-first-dogfood.md): v2 tours walked through code function by function. v3 rewrites the writing rules on that note's principle, and the new tour eval measures both.

## What changed in the prompt

- **Judging and guiding are now separate rules.** "Describe, never judge" became "Never judge" (no verdicts, no praise, never call a change fine, correct or safe) plus "Always guide" (say where the reviewer's judgment is needed).
- **Each stop has a fixed order:** what changed in behavior, why it matters, what's worth checking, and mechanics last, if at all. A stop that changes no behavior at all, like a pure move or rename, says so plainly.
- **The first sentence names no code.** It states the outcome a user or caller notices. Map stops lead with the behaviors that change; test stops lead with the behavior the tests lock in.
- **Bodies stay under 90 words.** The intro asks the guide to look hard for what could go wrong.
- **The coverage rules, schema, stop kinds, checker and retry prompt are unchanged.**

## How it was measured

`pnpm eval:tours --prompt v2 --prompt v3` runs the server's real tour job over the 9 public fixtures that exercise the tour (`vite-4118` is skip-only). Tour model `claude-opus-5-5`, judge `claude-sonnet-5`. Details: [`packages/evals/AGENTS.md`](../../packages/evals/AGENTS.md).

- **Surfaced** is the headline defect number: the judge says some stop states the defect or points the reviewer at it. There are 7 in-repo defects, plus one that needs outside knowledge.
- **Cited** is the manifest's line-overlap scoring. The coverage rules make nearly every changed line cited, so it can't separate the prompts.

## Results

v3 went through three drafts. Each draft ran once over the 9 fixtures, and v2 ran twice.
- **Round 1** was the first draft (commit `e786fd5` on PR #21's branch).
- **Round 2** added guidance for map and test stops.
- **Round 3, the final text, is the one that ships.** After a fresh-context review, it dropped a list of "what to look for" that lined up too closely with the fixture defects. It also narrowed "say when nothing needs a judgment call", which read like a soft verdict.

Full tables: [round 1](evals/2026-11-08-tours-v2-v3-round1.md), [round 2](evals/2026-11-08-tours-v2-v3-round2.md), and round 3 in two parts ([8 fixtures](evals/2026-11-08-tours-v3-round3.md) and [yargs](evals/2026-11-08-tours-v3-round3-yargs.md), because the budget guard held yargs back on the first pass).

| | v2 (run 1) | v2 (run 2) | v3 r1 | v3 r2 | **v3 r3 (final)** |
|---|---|---|---|---|---|
| Defects surfaced (judge) | 7/7 | 6/7 | 7/7 | 7/7 | **6/7** |
| External-knowledge defect | 0/1 | 0/1 | 0/1 | 0/1 | 0/1 |
| Danger flags missed / false alarms | 0 / 0 | 1 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| First sentence states the behavior change (judge) | 12% | 17% | 66% | 83% | **81%** |
| Names what to check, or says nothing needs it (judge) | 63% | 58% | 77% | 76% | **74%** |
| First sentence names no code (script) | 0% | 8% | 72% | 71% | **56%** |
| Within 5 sentences and 100 words (script) | 90% | 89% | 87% | 83% | **86%** |
| Tour cost, 9 fixtures | $1.44 | $1.04 | $1.63 | $1.53 | **$1.61** |
| Judge cost | $0.41 | $0.46 | $0.36 | $0.33 | $0.34 |

### Defects: no drop detected, and the eval can't see a small one

- **The final v3 surfaced 6 of 7.** It missed half of the yargs defect. It found and danger-flagged one half: handlers now run before validation. It missed the other half: in strict mode, a command's own positionals are reported as unknown. The judge counts that as a miss, and so does this note.
- **v2 also scored 6/7 in one of its two runs.** It missed the graphql-scalars ReDoS and its danger flag.
- **Every prompt missed the one defect that needs outside knowledge** (ky-536: how other fetch implementations treat a second argument).

So no drop is detected. But with 7 defects and v2 already near the ceiling, the eval can't resolve a drop smaller than one defect. The run-to-run noise estimate comes from only two v2 runs. Before trusting this number for v4, add harder in-repo defects.

### Clarity: the gain is real, but the rubric is partly v3's own wording

**The judge's rubric repeats v3's own instructions.** The behavior-first question uses nearly the same words as v3's rule for the first sentence, so 17% → 81% partly measures v3 following its own rules. The judge can't truly be blind either: a first sentence with no backticks gives v3 away.

**A rubric-independent check gave the same picture.** The same judge model read only the first sentences, with backticks stripped and v2 and v3 shuffled together in one list per fixture. It answered one neutral question: "Reading only this sentence, can you tell what this change does for a user or caller of the code?" (v2 run 2 against the final v3, $0.17, a one-off script.)

| | v2 | v3 (final) |
|---|---|---|
| "Can you tell what this change does for a user or caller?" | 28% (15/53) | 81% (35/43) |

That's still one model judging, not the maintainer. It's the cheapest check that doesn't lean on v3's wording.

## What a stop looks like now

The same defect in vite#15365, where editing `.env` stops restarting the dev server (round 1 tours):

> **v2:** `handleHMRUpdate` builds `fileName = path.basename(file)` at line 67. It then checks `getEnvFilesForMode(config.mode, config.envDir).includes(fileName)`. Since the helper now returns absolute paths, a basename like `.env` will never be in that list […]

> **v3:** Editing an env file looks like it will no longer trigger a server restart. The restart check compares the new list of absolute paths against the changed file's bare name, and those can never be equal. Check whether this should compare against `file`. […]

## What's still weak

- **Calibration.** The judge hasn't been checked against the maintainer's own reading. The `Docent feedback:` replies on dogfooded PRs are that check.
- **Code names in the lead.** 44% of final-v3 first sentences still trip the script. Most are user-facing names, like a header, a path or an option, which the script can't tell from function names. The neutral check, which strips backticks, is the better signal.
- **Cost.** v3 tours cost more than v2: 12% to 55% across these runs, or about 3 to 6 cents a tour. Some of that is noise.
- **Small sample.** There are 9 fixtures, each draft ran once, and v2 ran twice.
- **Only the first prompt is versioned.** The schema, checker and retry prompt are shared by every version, so an A/B compares first prompts only.

## Decisions

- **Ship round 3 as `TOUR_PROMPT_VERSION = 3`, over round 2.** Round 2 scored 7/7 against round 3's 6/7. But round 2's hunt list matched the fixture defect types, so its score may be overfit, and round 3's miss is within the noise v2 shows. The difference between them is one partly-found defect in one run.
- **v2 stays in `TOUR_PROMPTS`,** frozen by a hash test, so the A/B can be rerun.
- **Stop iterating here.** That's three drafts, the cap set for this task. The next step is better fixtures, not more prompt rounds.
- **The judge also scores defects.** Line overlap can't separate the prompts, so "surfaced" is the headline.
- **Spend:** about $9.50 in total against a $12 budget. That covers three A/B rounds, the yargs rerun, a $0.16 smoke run and the $0.17 neutral check.
