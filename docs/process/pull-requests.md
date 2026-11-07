# Pull requests

PRs are sorted into risk tiers, and humans review a sample of them. Trust is earned through metrics: as defects stop escaping in a tier, review in that tier becomes rarer. This is a trial, based on [Ship / Show / Ask](https://martinfowler.com/articles/ship-show-ask.html); see [`../north-stars.md`](../north-stars.md).

| Tier | What it covers                                                                                                                                                                                                                                                    | Review                                                                                      |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 0    | Docs, comments, tests only, formatting                                                                                                                                                                                                                            | Mechanical checks                                                                           |
| 1    | Feature work inside one package, with tests                                                                                                                                                                                                                       | Checks + a fresh-context agent review; the maintainer samples some                                    |
| 2    | Security boundaries (server auth, read-only session gates, scrubbing, credentials), shared contracts (adapter interface, snapshot format, tour schema), CI, releases, dependencies, and the agent harness (`AGENTS.md`, `CLAUDE.md`, `.claude/`, `docs/process/`) | Checks + agent review + the maintainer, always (for now). Harness changes also run the harness evals. |

The tier comes from the paths a PR changes. If paths span several tiers, the highest one wins. A script will assign tiers mechanically; until then, state the tier and why.

**Trust metric:** escaped defects per tier, meaning defects found later (by sampled review or a later fix) that trace back to a merged PR. Track it once there's volume.

## The autonomy dial

Autonomy expands quickly and pulls back on evidence, not on worry. Where the dial stands today:
- Agents merge tier 0 and tier 1.
- Tier 2 waits for the maintainer.

**When to turn it down.** An agent-merged PR causes an escaped defect: a bug, a regression, or a broken rule. Then tighten that tier one step, for example sending tier 1 back to the maintainer, and record what happened and why here. When the trust metric shows the tier is clean again, turn it back up.

## The description is the author handoff

It's what Docent itself reads, and often the only part a human reads. Make it worth that attention: short, specific, with no filler.

- **Intent:** what this is for, in a sentence or two.
- **Behavior change:** what's different for a user or caller.
- **Tier,** and why.
- **Evidence:** verify output, new tests, a screenshot or recording for UI changes.
- **Look here first:** the one or two places a reviewer should start.
- **Known gaps.**
