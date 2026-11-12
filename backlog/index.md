# Backlog

The work lives in GitHub issues. This file ranks them. The top unclaimed issue is next. To claim one, comment on it with your branch name, and link the issue from your PR (`Closes #N` when the PR finishes it). How agents file and triage issues: [`agent-identities.md`](../docs/process/agent-identities.md).

**How it's ranked.** Version one is the brief's loop: open a PR, take the tour, ask a question, leave feedback, send the batch ([`docs/brief.md`](../docs/brief.md), "V1 scope"). Feedback and interactive review come first, by the maintainer's priority. Then proven skips, then cost and speed, then the rest of what makes Docent trustworthy and pleasant to keep using. Dev-environment work is ranked alongside product work, by what it unblocks.

An open `backlog` issue that isn't listed here yet ranks below this list until someone places it. Whoever files or triages an issue adds it here in the same PR that places it, or in the next backlog PR.

**Waiting on the maintainer:** [#46](https://github.com/hartz89/docent/pull/46) (line comments), [#52](https://github.com/hartz89/docent/pull/52) (the launcher), [#55](https://github.com/hartz89/docent/pull/55) (the author side).

1. [#62](https://github.com/hartz89/docent/issues/62) Feedback: finish line comments
2. [#63](https://github.com/hartz89/docent/issues/63) Interactive review: send the batch to the author's agent
3. [#64](https://github.com/hartz89/docent/issues/64) Wire proven skips into tours
4. [#65](https://github.com/hartz89/docent/issues/65) Tours: reuse work across pushes and checkouts
5. [#66](https://github.com/hartz89/docent/issues/66) Questions: honest cost estimates, and cheaper "why" answers
6. [#67](https://github.com/hartz89/docent/issues/67) Tour warm-up: fix repair edge cases, then show the route first
7. [#68](https://github.com/hartz89/docent/issues/68) Tour prompt v4: win back defect-finding, and tidier citations
8. [#69](https://github.com/hartz89/docent/issues/69) An eval for every agent job, in CI
9. [#70](https://github.com/hartz89/docent/issues/70) Inline code references in stop prose
10. [#71](https://github.com/hartz89/docent/issues/71) Explorer: jump to definition in the UI, and find references
11. [#72](https://github.com/hartz89/docent/issues/72) The code map
12. [#73](https://github.com/hartz89/docent/issues/73) Questions: threads survive a reload, and the run log records the check
13. [#74](https://github.com/hartz89/docent/issues/74) Author side: sturdier session finding
14. [#75](https://github.com/hartz89/docent/issues/75) Launcher follow-ups
15. [#76](https://github.com/hartz89/docent/issues/76) "Take a tour in Docent" links for any repo
16. [#77](https://github.com/hartz89/docent/issues/77) Snapshots and scrubbing
17. [#78](https://github.com/hartz89/docent/issues/78) Show the PR's existing review comments in the tour
18. [#79](https://github.com/hartz89/docent/issues/79) Support GitHub Enterprise hosts
19. [#80](https://github.com/hartz89/docent/issues/80) Learning across reviews
20. [#81](https://github.com/hartz89/docent/issues/81) Release follow-ups: a smaller install, and npx polish
21. [#82](https://github.com/hartz89/docent/issues/82) Trust ledger: propose the autonomy rule
22. [#83](https://github.com/hartz89/docent/issues/83) Expand CI, and fix the known flaky tests
23. [#84](https://github.com/hartz89/docent/issues/84) An independent reviewer that posts a required status check
24. [#85](https://github.com/hartz89/docent/issues/85) First scheduled maintenance agents

## After v1

Not ranked yet. From the brief's roadmap and "later" notes, roughly in this order:

- **A Codex adapter,** a CONTRIBUTING guide for adapters, and vendor comparisons in the evals.
- **Practice mode:** planted bugs for reviewers to find, using the eval fixtures. Other engagement ideas: predict which files a PR touches, and a small, satisfying finish for a thorough review.
- **Multiple reviewers** on the same snapshot.
- **A canonical cloud session,** where vendors support it.
- **Learning on a threshold,** then scheduled in CI for teams.
- **More themes:** popular editor themes (license-checked) and VS Code theme files.
- **Language packs** for the deep features beyond the first languages.
