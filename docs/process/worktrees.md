# Worktrees and landing changes

Every agent works in its own git worktree. The main checkout is never touched, and `main` moves only through merged PRs on GitHub. That way parallel sessions can't step on each other, and no agent needs access outside its own worktree.

## The flow

1. **Start from `origin/main`.** `EnterWorktree` creates the worktree, branching from `origin/main` (`worktree.baseRef: "fresh"`), and a hook runs `pnpm install` in it. A stale local `main` doesn't matter, because nobody branches from it.
2. **Work and verify** inside the worktree. Commit as you go.
3. **Land it:** `git push -u origin <branch>`, then `gh pr create`. Write the description as described in [`pull-requests.md`](pull-requests.md). Run both as the `builder` app (`node scripts/as-agent.ts builder -- …`) once it exists; see [`agent-identities.md`](agent-identities.md).
4. **Wait for CI:** `gh pr checks --watch`.
5. **Post the review** as the `reviewer` app: `gh pr review <number> --comment --body-file <path>`, or `--request-changes` when something blocks. Agents never approve. Tier 2b gets a security-focused review. Do this before queueing the merge, and never in the same command. See "Reviews live on the PR" in [`pull-requests.md`](pull-requests.md).
6. **If the PR escalates, label it and prepare a Docent tour.** Escalation is rare; see "Escalation" in [`pull-requests.md`](pull-requests.md). Add the `needs-maintainer` label, and keep the PR a draft if two others are already waiting. Once CI passes and the review is posted:
   - From the worktree, run `pnpm docent review <pr-url> --prepare`. It writes the tour to the shared cache and prints its cost, so the maintainer's first open is instant and costs nothing. It needs no browser.
   - Post one comment as the `builder`: `node scripts/as-agent.ts builder -- gh pr comment <number> --body-file <path>`. Say the tour is ready, give its cost and the head commit it was prepared at, and give the one command to open it: `pnpm docent review <pr-url>`. Ask for feedback as described in "Dogfooding Docent" in [`pull-requests.md`](pull-requests.md).
   - Every later push changes the head, so the cached tour no longer matches. Prepare again and post a fresh comment.
   - If the prepare step fails, say so in that comment, with the error. Don't hold the PR for it.
7. **Queue the merge, then let GitHub decide when it lands.** Once the review is posted with no blockers open, queue the PR with `gh pr merge <number> --squash --auto`, as the `builder`. GitHub merges it once CI's `check` passes. Tier 2a also needs a log entry in `backlog/decisions.md`. An escalated PR isn't queued until the maintainer's approval is on it, and nobody pushes to it while it waits. Until a script assigns tiers, state the tier in the description and take the higher one when in doubt. This autonomy is meant to grow fast and to be dialed back on evidence: see "The autonomy dial" in [`pull-requests.md`](pull-requests.md).
8. **Clean up your own worktree** once `gh pr view <number> --json state` says `MERGED`. With `--auto` that's usually later, so do it the next time you see the PR merged, or leave it for a later sweep. Use explicit absolute paths, one git command per call (the worktree guard refuses loops and compound git commands):
   - `git worktree remove <absolute-path>`. Never `--force`: a refusal means uncommitted work, so stop and report.
   - `git branch -D <branch>`. A squash merge makes `-d` say "not fully merged", so `-D` is right once the PR shows `MERGED`.

   Never glob over `.claude/worktrees/`. That catches other agents' live worktrees, and `locked` ones belong to agents still running.

## Gotchas

- **One worktree per branch, and never share a worktree between agents.** Don't switch the branch of a worktree another agent may still be using; create a new worktree instead. This holds for orchestrators too: once an orchestrating session lends its worktree to an agent, or an agent is working on that branch, the orchestrator stops writing there. Any further writes go to agents running in their own worktrees. (On 2026-11-07 an orchestrator switched a shared worktree mid-task, and the agent working there had to stop.)
- **Every command, `!` commands included, must target the session's own worktree.** A command that changes into the main checkout to run git is refused. The guard is working as intended; land through GitHub instead.
- **Pass PR descriptions as a file** (`gh pr create --body-file <path>`). A command whose inline text mentions git, such as a heredoc body, can trip the worktree guard.
- **`gh repo create --source .` fails inside a worktree.** A worktree's `.git` is a file, not a folder. Create the repo, then `git remote add origin …` and push.
- **Creating a public repo, publishing a package, or any other new public surface** is blocked by auto mode's classifier, and should stay that way. Prepare everything, then hand the maintainer a one-line `!` command. See [`decisions.md`](decisions.md).
