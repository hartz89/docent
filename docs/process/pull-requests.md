# Pull requests

PRs are sorted into risk tiers, and humans review a sample of them. Trust is earned through metrics: as defects stop escaping in a tier, review in that tier becomes rarer. This is a trial, based on [Ship / Show / Ask](https://martinfowler.com/articles/ship-show-ask.html); see [`../north-stars.md`](../north-stars.md).

Tiers set how deep the agent review goes. They don't send a PR to the maintainer: that's [escalation](#escalation), which is separate and rare.

| Tier | What it covers | Review |
| ---- | -------------- | ------ |
| 0 | Docs, comments, tests only, formatting | Mechanical checks + a posted agent review |
| 1 | Feature work inside one package, with tests | Checks + a fresh-context agent review; the maintainer samples some |
| 2a | Shared contracts (core model, adapter interface, snapshot format, tour schema) that don't touch a security gate; dependencies without install or build scripts, outside `apps/server`; version bumps and lockfile-only changes; the agent harness (`AGENTS.md`, `CLAUDE.md`, `.claude/`, `docs/process/`, skills, hooks), except what 2b names | Checks + a fresh-context agent review with no blockers open. Harness changes also run the harness evals. The merge is logged in `backlog/decisions.md` for the maintainer's veto. |
| 2b | Security-sensitive. See the checklist and path floor below. | Checks + a security-focused fresh-context review, posted on the PR before merge |

**Who picks the tier.** The reviewer agent decides, using the 2b checklist. The path list is a floor: it can only raise a PR's tier, never lower it. If paths span several tiers, the highest one wins. The builder states the tier and why. The reviewer runs `node scripts/tier.ts --pr <n>` for the path floor, then confirms the tier or raises it.

**The 2b checklist.** A PR is 2b if it changes any of these:
- the agent runner (`scripts/as-agent.ts`), app keys, or credentials;
- CI, the ruleset, or anything else in `.github/`;
- permission rules or hooks in `.claude/settings*.json`;
- the tier definitions, the escalation rules, or the merge practice, wherever they live;
- code that acts as the maintainer: runs `gh` with their login, or posts to GitHub as them;
- code that protects the reviewer's machine from the PR's code: checkout hardening, read-only session options, and the tests that pin and prove them;
- the server's request gates, or the check that ties a PR's session link to an author session;
- logic that decides what the reviewer sees: skip proofs (`packages/core/src/proof.ts`, `detect.ts`, `rename.ts`, `gitattributes.ts`, `ledger.ts`, `coverage.ts`), and scrubbing;
- the prompt framing that tells agents to treat PR content as data;
- scripts that run a session or git as the maintainer (`scripts/check-context-loading.ts`, `scripts/sync-main-checkout.sh`);
- dependencies with install scripts, or used by `apps/server`.

**The path floor.** These paths always make a PR 2b: `.github/`, `scripts/as-agent.ts`, `.claude/settings*.json`, `apps/server/package.json`, everything in `apps/server/src/` except tests (but including `agent.test.ts` and `agent.live.test.ts`), and the skip-proof files above. Without the `apps/server/src/` line, a backtest found that PRs like [#19](https://github.com/hartz89/docent/pull/19) (the question path) fell to 2a.

**Our own agents are trusted; the gates guard against outside input.** That means a PR's own code, other websites, and anything else that doesn't come from us. The ceiling on what an agent can do is each GitHub App's permissions. The maintainer sets those on GitHub, outside this repo. For example, the builder has no Workflows permission, so GitHub refuses its pushes to `.github/workflows/`. Those pushes are the one thing the maintainer always does by hand.

## The merge gate

**GitHub enforces green CI, and nothing else.** The `main` ruleset needs a PR, CI's `check` job, and squash merges. It requires no approvals and no code owners.

**The agent review is a practice.** It's posted on the PR before auto-merge is queued. GitHub doesn't check that today.

**Reviews live on the PR.** Every review is posted to its PR as the `reviewer` app, before anything merges. That includes security reviews and reviews run inside a building agent. A review that's only reported back doesn't count. Post it as a comment, or as a request for changes when something blocks. Agents never approve. Posting the review is a separate step from queueing the merge, never folded into the same command. That way the review is on record, and the merge can point to it. A 2b PR whose security review found issues, which were then fixed, gets a follow-up review saying so, and merges like any other.

**Findings go on their lines.** Post the review with the reviewer form in [`agent-identities.md`](agent-identities.md), with each finding as an inline comment on the lines it concerns. The review body holds only the verdict, plus feedback no line can carry, like "the premise is wrong". An inline comment must sit on a line inside the PR's diff, or GitHub rejects the whole review; feedback about lines outside the diff goes in the body.

**Each finding starts with its kind and weight,** in bold, like `**Bug · must-fix:**`.
- Kinds: `Bug`, `Security`, `Design`, `Test gap`, `Docs`.
- Weights: `must-fix` (blocks the merge), `should-fix` (fix it or say why not), `nit` (take it or leave it).

**The builder answers every finding in its thread,** with the builder reply form: `Fixed in <sha>`, `Won't fix: <why>`, or `Deferred to #<issue>`. These outcomes are the record that the trust metric and learning across reviews read.

**Follow-up, not done yet: a GitHub-enforced agent gate.** An independent reviewer runs outside the builder's session and posts a required status check. That needs the `reviewer` app to get Checks: write. Required approvals can't do this job: the builder's session can't approve its own PR, and the reviewer app has no write access.

## Escalation

The maintainer's words: "some escalations to me are fine, and they're a useful way to dogfood docent, but i don't want to walk into a 5-deep stack of pull requests every time i revive a session."

**What escalates.** Only a change that does one of these:
- grants agents new powers: the runner's allowlist, token permissions, `.claude` permission rules or hooks;
- acts as the maintainer in a new way: new things posted with their `gh` login or credentials;
- weakens a gate: the ruleset, the merge practice, read-only session options, checkout hardening, scrubbing, or skip proofs made laxer;
- leaves the security reviewer's concern unresolved, or turns on a product or values judgment that belongs to the maintainer.

Being 2b isn't enough. A 2b PR whose security review found issues that were then fixed does not escalate.

**Expect it to be rare.** Roughly one per session. That's an expectation, not a quota. If escalations are frequent, the bar is too low.

**Everything else merges without the maintainer,** 2b included, once its review is posted with no blockers open.

**How to escalate.** The builder adds the `needs-maintainer` label (`gh pr edit <number> --add-label needs-maintainer`) and says why in a PR comment, naming which rule above applies.

**At most two PRs wait on the maintainer at once.** "Waiting" means open and labeled `needs-maintainer`. Count them with `gh api 'search/issues?q=repo:hartz89/docent+is:pr+is:open+label:needs-maintainer'`, which returns `total_count`. If a third would escalate, it gets the `escalation-queued` label instead, and agents work on something else. When a slot frees, the builder swaps the labels (`gh pr edit <number> --remove-label escalation-queued --add-label needs-maintainer`). The builder can't mark PRs draft or ready (`gh pr ready` isn't on its allowlist), so the label does that job. Once the morning brief exists, it lists the queue.

**No stacking on a waiting PR.** Agents don't push to a PR that's waiting on the maintainer, or build on its branch, unless the maintainer asks. A new commit would also dismiss their approval.

**Tour ready on arrival.** An escalated PR comes with a Docent tour pre-built (`--prepare`), so reviewing it is dogfooding. See "Prepare a Docent tour" in [`worktrees.md`](worktrees.md).

**Merge signal.** The ruleset requires no approvals, so GitHub won't hold an escalated PR by itself. Don't queue auto-merge on it until the maintainer's approval is on the PR. Then the builder queues it.

**Trust metric:** escaped defects per tier, meaning defects found later (by sampled review or a later fix) that trace back to a merged PR. Track it once there's volume.

## The autonomy dial

Autonomy expands quickly and pulls back on evidence, not on worry. Where the dial stands today:
- Agents merge every tier once CI is green and the agent review is posted with no blockers open.
- A 2a merge is logged in `backlog/decisions.md` for veto.
- A 2b merge needs the security-focused review first.
- An escalated PR merges only after the maintainer approves it.

This was set on 2026-11-07, at the maintainer's direction: merge autonomously when PRs pass the quality and risk gates, and escalate only when it's genuinely critical. On 2026-11-10, code ownership was removed, and escalation became the rare, separate step above.

**When to turn it down.** An agent-merged PR causes an escaped defect: a bug, a regression, or a broken rule. Then tighten that tier one step, for example requiring a second, independent review for that tier, and record what happened and why here. When the trust metric shows the tier is clean again, turn it back up.

## The description is the author handoff

It's what Docent itself reads, and often the only part a human reads. Make it worth that attention: short, specific, with no filler.

- **Intent:** what this is for, in a sentence or two.
- **Behavior change:** what's different for a user or caller.
- **Tier,** and why.
- **Evidence:** verify output, new tests, a screenshot or recording for UI changes.
- **Look here first:** the one or two places a reviewer should start.
- **Known gaps,** in a collapsed `<details>` section.

**Keep the visible part to about 300 words.** "Visible" means everything outside `<details>`. The maintainer reviews in Docent and on GitHub, and long descriptions cost the attention this process exists to save. Put detail and known gaps in collapsed `<details>` sections, or in a linked doc. Reviews posted on the PR already carry their own evidence, so the description gives the outcome in a line and doesn't repeat them.

## Dogfooding Docent

Every escalated PR gets a Docent tour, prepared ahead of time. The steps are in [`worktrees.md`](worktrees.md), under "Prepare a Docent tour". Each of these reviews is also a chance to find out where the tour falls short.

**Feedback goes on the PR.** If the tour missed something or got something wrong, the maintainer replies to the tour-ready comment with a line starting `Docent feedback:`. Point at the file and lines, and say what was missed or wrong. Silence means the tour was fine. To find feedback, list the PRs with `gh api search/issues -X GET -f q='repo:hartz89/docent commenter:hartz89 "Docent feedback" in:comments'`. That returns PRs, not comments, so read each PR's comments and keep the maintainer's that start with `Docent feedback:`.

**A miss becomes an eval fixture.** An agent turns each miss into a manifest in [`packages/evals/fixtures/public/`](../../packages/evals/fixtures/public/), with the same schema and checks as every other fixture (see [`packages/evals/AGENTS.md`](../../packages/evals/AGENTS.md)). The id starts with `docent-<pr>-`. The maintainer's feedback comment is the evidence link. This repo is public, so these fixtures are public too.

**Wrong claims wait for the schema.** The manifest can say what a tour must find, but not what it must never claim. So a wrong claim stays in the PR thread for now. Once three have piled up, propose a schema field for them, with those three as its first cases.
