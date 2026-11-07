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
4. Write `fixtures/public/<id>.json`. The id is `<repo>-<pr>-<short-slug>`, and the file name matches it.
   - `expectedFindings`: what the tour must surface, with file, lines, and a one or two sentence description.
   - `mustNotSkip`: the changed lines the skip decision must never collapse. Every finding must sit inside one of these.
   - `expectDangerFlag`: true only when the evidence shows a security problem. It needs `"danger"` in `jobs`.
   - `size`: `small` under 100 changed lines, `medium` under 500, `large` otherwise.
5. Run `pnpm verify`, then `pnpm --filter @docent/evals check:fixtures`. The check confirms the SHAs, the merge base, the size, and that every range is in the diff.

Prefer small and medium PRs, since every fixture costs model calls on every run. Keep the job mix spread: mostly tour, plus skip-decision noise (lockfiles, generated code, moved code), danger flags, and negative controls.
