# Experiment: how much spec-driven development pays off

**Question.** For a project built mostly by agents, does writing specs first pay for itself, compared with looser iteration? If it does, for which kinds of work?

**Status:** planned. The maintainer hasn't decided, and wants the evidence to decide.

## The approaches

These are the levels from [Birgitta Böckeler's survey of SDD tools](https://www.martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html):

- **A. Loose.** A short goal and acceptance checks, then iterate. No spec file.
- **B. Spec-first.** Write a spec, get it reviewed, build it. The spec isn't maintained afterwards.
- **C. Spec-anchored.** The spec lives next to the code and changes in the same PR as the code. Checks tie the two together where possible.

Spec-as-source, where humans edit only specs, is out of scope for now. Böckeler describes it as "fully dependent on a non-deterministic compiler."

## Plan

1. In the early phases, label each piece of work A, B or C. Rotate the labels, so that each approach gets work of a similar size and kind.
2. My hunch, which this is meant to test: C fits the contracts (adapter interface, snapshot format, tour schema, which the brief already says must be documented), and A fits UI work, where taste comes from trying things.
3. Record per item:
   - defects found later
   - rework (follow-up PRs to the same area)
   - wall-clock time and tokens, from session history
   - The maintainer's review time, and their read on how easy the PR was to judge
4. After about 10 items, write up the result and change the radar entry in [`../north-stars.md`](../north-stars.md).

## Log

| Item | Approach | Size | Defects later | Rework | Notes |
| ---- | -------- | ---- | ------------- | ------ | ----- |
| 2. Core data model ([PR #5](https://github.com/hartz89/docent/pull/5)) | C | M: 1.6k lines, about 40% code and spec, 60% tests | | | Spec took about 5 of 15 minutes. Writing it surfaced two design conflicts before any code: a map stop would "double-home" lines that core stops explain (resolved as C2), and guide answers must not carry an answer check (Q3). A spec-citation test then caught 10 of 39 invariants with no test. A fresh-context review found 8 should-fixes before merge (the spec hadn't covered duplicate code, stale skips, a stuck lock or the Node boundary); all fixed in the same PR, spec first. |
