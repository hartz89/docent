# Worktrees and landing changes

Every agent works in its own git worktree. The main checkout is never touched, and `main` moves only through merged PRs on GitHub. That way parallel sessions can't step on each other, and no agent needs access outside its own worktree.

## The flow

1. **Start from `origin/main`.** `EnterWorktree` creates the worktree, branching from `origin/main` (`worktree.baseRef: "fresh"`), and a hook runs `pnpm install` in it. A stale local `main` doesn't matter, because nobody branches from it.
2. **Work and verify** inside the worktree. Commit as you go.
3. **Land it:** `git push -u origin <branch>`, then `gh pr create`. Write the description as described in [`pull-requests.md`](pull-requests.md). Run both as the `builder` app (`node scripts/as-agent.ts builder -- …`) once it exists; see [`agent-identities.md`](agent-identities.md).
4. **Wait for CI:** `gh pr checks --watch`.
5. **Merge by tier.** Agents merge tier 0 and tier 1 PRs themselves once CI passes; tier 1 also needs a fresh-context agent review first. Tier 2 waits for the maintainer. Until a script assigns tiers, state the tier in the description and take the higher one when in doubt. This autonomy is meant to grow fast and to be dialed back on evidence: see "The autonomy dial" in [`pull-requests.md`](pull-requests.md).
6. **Clean up** after the merge: remove the worktree and delete the branch.

## Gotchas

- **Every command, `!` commands included, must target the session's own worktree.** A command that changes into the main checkout to run git is refused. The guard is working as intended; land through GitHub instead.
- **Pass PR descriptions as a file** (`gh pr create --body-file <path>`). A command whose inline text mentions git, such as a heredoc body, can trip the worktree guard.
- **`gh repo create --source .` fails inside a worktree.** A worktree's `.git` is a file, not a folder. Create the repo, then `git remote add origin …` and push.
- **Creating a public repo, publishing a package, or any other new public surface** is blocked by auto mode's classifier, and should stay that way. Prepare everything, then hand the maintainer a one-line `!` command. See [`decisions.md`](decisions.md).
