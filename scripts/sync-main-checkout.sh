#!/bin/sh
# Fast-forwards the main checkout to origin/main, so it's current whenever Ryan browses it.
# Agents never work there (see docs/process/worktrees.md), so this only keeps it fresh.
# Runs from a SessionStart hook. It does nothing unless that's safe, and never fails the session:
# it skips if the main checkout isn't on main or has changes, and only ever fast-forwards.

common_dir="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || exit 0
cd "$common_dir/.." || exit 0

[ "$(git symbolic-ref --short -q HEAD)" = "main" ] || exit 0
git diff --quiet 2>/dev/null && git diff --cached --quiet 2>/dev/null || exit 0

git fetch -q origin main 2>/dev/null || exit 0
git merge -q --ff-only origin/main 2>/dev/null
exit 0
