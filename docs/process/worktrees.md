# Worktrees and landing changes

Every agent works in its own git worktree. The main checkout is never touched, and `main` moves only through merged PRs on GitHub. That way parallel sessions can't step on each other, and no agent needs access outside its own worktree.

## The flow

1. **Start from `origin/main`.** `EnterWorktree` creates the worktree, branching from `origin/main` (`worktree.baseRef: "fresh"`), and a hook runs `pnpm install` in it. A stale local `main` doesn't matter, because nobody branches from it.
2. **Work and verify** inside the worktree. Commit as you go.
3. **Land it:** `git push -u origin <branch>`, then `gh pr create`. Write the description as described in [`pull-requests.md`](pull-requests.md).
4. **Wait for CI:** `gh pr checks --watch`.
5. **Merge by tier.** For now, Ryan merges every PR. Once tiers are assigned mechanically (backlog), agents will merge tier 0 and 1 PRs themselves after checks pass. Tier 2 always waits for Ryan.
6. **Clean up** after the merge: remove the worktree and delete the branch.

## Gotchas

- **Every command, `!` commands included, must target the session's own worktree.** A command that changes into the main checkout to run git is refused. The guard is working as intended; land through GitHub instead.
- **`gh repo create --source .` fails inside a worktree.** A worktree's `.git` is a file, not a folder. Create the repo, then `git remote add origin …` and push.
- **Creating a public repo, publishing a package, or any other new public surface** is blocked by auto mode's classifier, and should stay that way. Prepare everything, then hand Ryan a one-line `!` command. See [`decisions.md`](decisions.md).
