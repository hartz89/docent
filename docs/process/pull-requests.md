# Pull requests

PRs are sorted into risk tiers, and humans review a sample of them. Trust is earned through metrics: as defects stop escaping in a tier, review in that tier becomes rarer. This is a trial, based on [Ship / Show / Ask](https://martinfowler.com/articles/ship-show-ask.html); see [`../north-stars.md`](../north-stars.md).

Tiers set how deep the review goes. They don't decide who approves: no path waits for the maintainer.

| Tier | What it covers | Review |
| ---- | -------------- | ------ |
| 0 | Docs, comments, tests only, formatting | Mechanical checks + an approving agent review |
| 1 | Feature work inside one package, with tests | Checks + a fresh-context agent review; the maintainer samples some |
| 2a | Shared contracts (core model, adapter interface, snapshot format, tour schema) that don't touch a security gate; dependencies without install or build scripts, outside `apps/server`; version bumps and lockfile-only changes; the agent harness (`AGENTS.md`, `CLAUDE.md`, `.claude/`, `docs/process/`, skills, hooks) | Checks + a fresh-context agent review with no blockers open. Harness changes also run the harness evals. The merge is logged in `backlog/decisions.md` for the maintainer's veto. |
| 2b | Security-sensitive: the agent runner (`scripts/as-agent.ts`) and app keys; CI, the ruleset and anything else in `.github/`; the code that runs `gh` as the maintainer, including posting reviews, and hardens the PR's checkout (`apps/server/src/github.ts`); the read-only session options (`apps/server/src/agent.ts`); the server's request gates (`apps/server/src/app.ts`, `server.ts`) and the check that ties a PR's session link to an author session (`author-session.ts`); scrubbing and credentials; dependencies with install scripts or used by `apps/server` | Checks + a security-focused fresh-context review, posted on the PR, before the approving review |

The tier comes from the paths a PR changes. If paths span several tiers, the highest one wins. A script will assign tiers mechanically; until then, state the tier and why.

**One approving review gates every merge.** The `main` ruleset needs green CI and one approving review. The `reviewer` app gives it, after a fresh-context review finds no blockers. The ruleset dismisses an approval when new commits land, so a later push needs a fresh approval.

**Our own agents are trusted; the gates guard against outside input.** That means a PR's own code, other websites, and anything else that doesn't come from us. The ceiling on what an agent can do is each GitHub App's permissions. The maintainer sets those on GitHub, outside this repo. For example, the builder has no Workflows permission, so GitHub refuses its pushes to `.github/workflows/`.

**The maintainer decides; they don't approve.** Their part is answering decision briefs (see [`decisions.md`](decisions.md)), sampling merged work, and vetoing a logged merge. A change to the tiers, the ruleset or the autonomy dial is still tier 2b, and a big one goes to them as a decision brief.

**Reviews live on the PR.** Post the fresh-context agent review on the PR, as the `reviewer` app, before anything merges. It approves (`gh pr review --approve`) only when no blockers are open; otherwise it comments or requests changes. Posting it is a separate step from the merge, never folded into the same command. That way the review is on record, and the merge can point to it.

**Trust metric:** escaped defects per tier, meaning defects found later (by sampled review or a later fix) that trace back to a merged PR. Track it once there's volume.

## The autonomy dial

Autonomy expands quickly and pulls back on evidence, not on worry. Where the dial stands today:
- Agents merge every tier, once CI is green and the reviewer app has approved.
- A 2a merge needs a fresh-context review with no open blockers, and is logged in `backlog/decisions.md` for veto.
- A 2b merge needs a security-focused review posted before the approval.

This was set on 2026-11-07, at the maintainer's direction: merge autonomously when PRs pass the quality and risk gates, and escalate only when it's genuinely critical. On 2026-11-10, code ownership was removed, so tier 2b no longer waits for the maintainer.

**When to turn it down.** An agent-merged PR causes an escaped defect: a bug, a regression, or a broken rule. Then tighten that tier one step, for example requiring a second, independent review for that tier, and record what happened and why here. When the trust metric shows the tier is clean again, turn it back up.

## The description is the author handoff

It's what Docent itself reads, and often the only part a human reads. Make it worth that attention: short, specific, with no filler.

- **Intent:** what this is for, in a sentence or two.
- **Behavior change:** what's different for a user or caller.
- **Tier,** and why.
- **Evidence:** verify output, new tests, a screenshot or recording for UI changes.
- **Look here first:** the one or two places a reviewer should start.
- **Known gaps.**

## Dogfooding Docent

Every tier 2b PR gets a Docent tour, prepared ahead of time, so the maintainer can sample it cheaply. The steps are in [`worktrees.md`](worktrees.md), under "Prepare a Docent tour". Each of these reviews is also a chance to find out where the tour falls short.

**Feedback goes on the PR.** If the tour missed something or got something wrong, the maintainer replies to the tour-ready comment with a line starting `Docent feedback:`. Point at the file and lines, and say what was missed or wrong. Silence means the tour was fine. To find feedback, list the PRs with `gh api search/issues -X GET -f q='repo:hartz89/docent commenter:hartz89 "Docent feedback" in:comments'`. That returns PRs, not comments, so read each PR's comments and keep the maintainer's that start with `Docent feedback:`.

**A miss becomes an eval fixture.** An agent turns each miss into a manifest in [`packages/evals/fixtures/public/`](../../packages/evals/fixtures/public/), with the same schema and checks as every other fixture (see [`packages/evals/AGENTS.md`](../../packages/evals/AGENTS.md)). The id starts with `docent-<pr>-`. The maintainer's feedback comment is the evidence link. This repo is public, so these fixtures are public too.

**Wrong claims wait for the schema.** The manifest can say what a tour must find, but not what it must never claim. So a wrong claim stays in the PR thread for now. Once three have piled up, propose a schema field for them, with those three as its first cases.
