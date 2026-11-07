# Where eval fixtures come from

**2026-11-06.** An eval fixture is a fixed PR with known answers. The answers are the behavior changes and intent mismatches the tour should surface, the code the skip decision must never collapse, and the dangers that should get flagged.

**Result.** The best fixtures are PRs whose defects were later named by a fix. Agent-written repos produce many of these. We surveyed one private repo with about 165 merged PRs, 99% of them opened by agents, and found 14 strong candidates.

## Sources of ground truth, best first

1. **A later fix that names the PR.** For example, "raise the timeout #N added." The defect and its location are known.
2. **Review-fix commits on the same PR.** Take the PR at its first commit as the fixture. The review commits that came after are the expected findings. Agent workflows produce these all the time, which multiplies the supply.
3. **Mismatches between title and diff.** The title promises one thing, and the diff also does something else.
4. **Noise that hides one change.** Generated data, file moves or lockfiles with one real logic change buried inside. These test the skip decision.
5. **Negative controls.** A trivial PR that should be skipped and never flagged. These test for false alarms.

## Private vs public

Fixtures and their expected answers describe the code they come from. Private repos can't be committed here.

- **Public core set (committed):** about 8–10 open-source PRs where a later "fixes regression from #N" pins the defect. Diffs are not committed; they are fetched at run time from base and head, the same as the private set. (Updated 2026-11-07.)
- **Private set:** manifests (repo, base and head SHAs, expected findings, lines that must not be skipped) live in a separate private repo, and diffs are fetched at run time. They run locally or nightly, never in public CI.
- The runner and the manifest schema live here.

## Watch for

- **Numbers in titles aren't always PR numbers.** Backlog ids like "#156" can overlap with PR numbers, so the answer checker must not treat every `#N` as a PR link.
- **Agent-generated PR descriptions often lack intent and risk.** The author handoff should make them required. That's the PR description format in AGENTS.md.
