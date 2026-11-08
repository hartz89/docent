# Pull requests

PRs are sorted into risk tiers, and humans review a sample of them. Trust is earned through metrics: as defects stop escaping in a tier, review in that tier becomes rarer. This is a trial, based on [Ship / Show / Ask](https://martinfowler.com/articles/ship-show-ask.html); see [`../north-stars.md`](../north-stars.md).

| Tier | What it covers                                                                                                                                                                                                                                                    | Review                                                                                      |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 0    | Docs, comments, tests only, formatting                                                                                                                                                                                                                            | Mechanical checks                                                                           |
| 1 | Feature work inside one package, with tests | Checks + a fresh-context agent review; the maintainer samples some |
| 2a | Shared contracts (core model, adapter interface, snapshot format, tour schema) that don't touch scrubbing, auth or session gates; new dependencies without install or build scripts, outside `apps/server`; version bumps and lockfile-only changes | Checks + a fresh-context agent review with no blockers open. An agent merges, and logs the merge in `backlog/decisions.md` for the maintainer's veto. |
| 2b | Security boundaries (server auth, read-only session gates, scrubbing, credentials, agent identities: the GitHub Apps, `scripts/as-agent.ts`, and app keys), permissions and settings (`.claude/`), CI and releases, the agent harness (`AGENTS.md`, `CLAUDE.md`, `docs/process/`), the tier definitions and merge rules themselves, any contract change that touches scrubbing, auth or session gates, and dependencies with install scripts or used by `apps/server` | Checks + agent review + the maintainer, always (for now). Harness changes also run the harness evals. |

The tier comes from the paths a PR changes. If paths span several tiers, the highest one wins. A script will assign tiers mechanically; until then, state the tier and why.

**Changing the rules is tier 2b.** Any change to tier definitions, the autonomy dial or merge rules is 2b, wherever it lives, so agents can't loosen their own gates.

**Reviews live on the PR.** Post the fresh-context agent review as its own PR comment before anything merges. Posting it is a separate step from the merge, never folded into the same command. That way the review is on record, and the merge can point to it.

**Trust metric:** escaped defects per tier, meaning defects found later (by sampled review or a later fix) that trace back to a merged PR. Track it once there's volume.

## The autonomy dial

Autonomy expands quickly and pulls back on evidence, not on worry. Where the dial stands today:
- Agents merge tiers 0, 1 and 2a. A 2a merge needs a fresh-context review with no open blockers, and is logged in `backlog/decisions.md` for veto.
- Tier 2b waits for the maintainer.

This was set on 2026-11-07, at the maintainer's direction: merge autonomously when PRs pass the quality and risk gates, and escalate only when it's genuinely critical.

**When to turn it down.** An agent-merged PR causes an escaped defect: a bug, a regression, or a broken rule. Then tighten that tier one step, for example sending tier 1 back to the maintainer, and record what happened and why here. When the trust metric shows the tier is clean again, turn it back up.

## The description is the author handoff

It's what Docent itself reads, and often the only part a human reads. Make it worth that attention: short, specific, with no filler.

- **Intent:** what this is for, in a sentence or two.
- **Behavior change:** what's different for a user or caller.
- **Tier,** and why.
- **Evidence:** verify output, new tests, a screenshot or recording for UI changes.
- **Look here first:** the one or two places a reviewer should start.
- **Known gaps.**

## Dogfooding Docent

Every PR that needs the maintainer gets a Docent tour, prepared ahead of time. The steps are in [`worktrees.md`](worktrees.md), under "Prepare a Docent tour". Each of these reviews is also a chance to find out where the tour falls short.

**Feedback goes on the PR.** If the tour missed something or got something wrong, the maintainer replies to the tour-ready comment with a line starting `Docent feedback:`. Point at the file and lines, and say what was missed or wrong. Silence means the tour was fine. To find feedback, list the PRs with `gh api search/issues -X GET -f q='repo:hartz89/docent commenter:hartz89 "Docent feedback" in:comments'`. That returns PRs, not comments, so read each PR's comments and keep the maintainer's that start with `Docent feedback:`.

**A miss becomes an eval fixture.** An agent turns each miss into a manifest in [`packages/evals/fixtures/public/`](../../packages/evals/fixtures/public/), with the same schema and checks as every other fixture (see [`packages/evals/AGENTS.md`](../../packages/evals/AGENTS.md)). The id starts with `docent-<pr>-`. The maintainer's feedback comment is the evidence link. This repo is public, so these fixtures are public too.

**Wrong claims wait for the schema.** The manifest can say what a tour must find, but not what it must never claim. So a wrong claim stays in the PR thread for now. Once three have piled up, propose a schema field for them, with those three as its first cases.
