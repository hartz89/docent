# @docent/evals

Product evals: fixed PRs with known answers, used to score each Docent job (tour, skip decision, danger flag, answer check, scrubber) on quality and cost. Background: [`docs/research/2026-11-06-eval-fixtures.md`](../../docs/research/2026-11-06-eval-fixtures.md).

- `src/manifest.ts`: the manifest types and a hand-written validator. No dependencies.
- `fixtures/public/*.json`: the public core set, one manifest per file.
- `src/check-fixtures.ts`: a slow check against GitHub. Not part of `pnpm verify`.

Diffs are never committed. A runner fetches `base...head` at run time.

## Private fixtures never live here

This repo is public. A fixture from a private repo describes that repo's code, so its manifest stays in a separate private repo, and the runner loads it from there. The schema has `visibility: "private"` for those manifests. A test fails if a manifest in `fixtures/public/` isn't `"public"`.

## The evidence bar

Every expected finding is backed by a public link that names it: a later fix PR or commit ("regression from #N", "introduced in #N", a revert), a maintainer comment, or a security advisory. Your own reading of the diff is not enough. If you can't link it, leave it out.

A negative control has no findings. Its evidence is the PR's own diff, with a note on why it's trivial.

## Adding a fixture

1. Find a merged PR in a permissively licensed public repo, with a later fix that names it. Read both.
2. Get the SHAs. `head` is the PR's head commit (`gh api repos/O/R/pulls/N --jq .head.sha`). `base` is the merge base (`gh api repos/O/R/compare/BASE...HEAD --jq .merge_base_commit.sha`, using the PR's `base.sha`).
3. Read the defect at `head`, not on `main`. Line numbers are 1-based and inclusive, in the file as it is at `head`. Every range must sit inside one diff hunk.
   - Ranges are on the new side only. A pure deletion has no new-side lines, so it can't be pinned yet. If the defect is a removed line, pin the surrounding new code, or leave the fixture out.
4. Write `fixtures/public/<id>.json`. The id is `<repo>-<pr>-<short-slug>`, and the file name matches it.
   - `expectedFindings`: what the tour must surface, with file, lines, and a one or two sentence description.
     Add `externalKnowledge` when spotting it needs facts the diff and repo can't show (how a browser or npm package behaves). The runner reports those findings separately.
   - `mustNotSkip`: the changed lines the skip decision must never collapse. Every finding must sit inside one of these.
   - `shouldSkip` (optional): noise the skip decision should collapse, as a whole file or a range. It must not overlap `mustNotSkip`. Fill it in on every skip fixture, so skip precision can be scored.
   - `expectDangerFlag`: true only when the evidence shows a security problem. It needs `"danger"` in `jobs`.
   - `negativeControl: true`: a trivial PR. Findings and `mustNotSkip` must be empty and the danger flag false. Only a negative control may list `"tour"` with no findings.
   - `scoring` (optional): overrides `DEFAULT_SCORING` in `src/manifest.ts`. A tour stop matches a finding when their ranges overlap, after widening the finding by `toleranceLines`. The description is not compared. `maxStops` caps tour length.
   - `size`: `small` under 100 changed lines, `medium` under 500, `large` otherwise.
5. Run `pnpm verify`, then `pnpm --filter @docent/evals check:fixtures`. The check confirms the SHAs, the merge base, the size, and that every range is in the diff.

**Dogfood fixtures** come from the maintainer's `Docent feedback:` comments on this repo's own PRs ([`docs/process/pull-requests.md`](../../docs/process/pull-requests.md), "Dogfooding Docent"). They follow the same steps, with one change: `head` is the commit the tour was prepared at, named in the tour-ready comment, not the PR's final head. Later pushes may have fixed the miss or moved its lines. The id is `docent-<pr>-<short-slug>`, the license is `Apache-2.0`, and the feedback comment is the evidence.

Prefer small and medium PRs, since every fixture costs model calls on every run. Keep the job mix spread: mostly tour, plus skip-decision noise (lockfiles, generated code, moved code), danger flags, and negative controls.

## Running the tour eval

```bash
pnpm eval:tours --prompt v2 --prompt v3          # A/B two prompt versions over the public tour fixtures
pnpm eval:tours --fixture ky-122-timeout-abort   # one fixture, current prompt
```

It costs real money (about $0.20 to $0.40 per fixture and prompt) and needs an authenticated `gh` and Claude Code login. It's never part of `pnpm verify`. `--budget <usd>` (default 12) caps spend: a fixture starts only if spend so far, plus $0.75 held back for each running or new tour, stays within it. A tour that retries can still run past its $0.75, so treat the cap as close, not exact.

- **What runs:** the server's real tour job (`generateTour` from `@docent/server/evals`), on every public fixture whose `jobs` include `"tour"`, once per prompt version. Old prompt versions stay in `TOUR_PROMPTS` in `apps/server/src/tour.ts` so an A/B stays reproducible. A shipped prompt is frozen by a hash test; change it by adding a version.
- **Defects:** *cited* is the manifest's scoring (a stop's new-side range overlaps the finding, within `toleranceLines`). Coverage rules make nearly every changed line cited, so it's a floor, not the headline. *Surfaced* is the headline: the judge says a stop states the defect or points the reviewer at it. Findings with `externalKnowledge` are counted apart. A failed run counts its findings as missed, and the report marks it.
- **Stop quality:** scripts check that a stop's first sentence names no code (no backticks, nothing call-shaped like `f(`) and that the body is at most 5 sentences and 100 words (`src/stop-quality.ts`). A model judge (`src/judge.ts`, sonnet by default, a fixed rubric) answers what scripts can't: does the first sentence state the behavior change, and does the stop name what's worth checking, or say nothing is? Every stop but the `verdict_prompt` is graded. The judge never sees the prompt version, but its rubric echoes v3's own wording, so treat its clarity scores as "follows the principle", not as proof a reviewer gets the point. Bump `JUDGE_RUBRIC_VERSION` when the rubric changes.
- **Output:** a summary in `docs/research/evals/<date>-tours-<label>.md` and `.json` (commit these), and the raw tours and judgments in Docent's cache folder under `evals/` (don't commit them; the path is printed).
- **Tests** replay the recorded hono#4813 review in `e2e/fixtures/` with a scripted judge, so they make no calls.
