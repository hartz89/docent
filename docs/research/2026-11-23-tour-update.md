# Tour updates: a push keeps the stops it didn't touch

2026-11-23. Issue [#65](https://github.com/hartz89/docent/issues/65). Today every push throws the tour away. A review-then-fix cycle, which is Docent's own loop, pays for a whole new tour and makes the reviewer wait for it again. [#97](https://github.com/hartz89/docent/pull/97) already stopped two processes paying for the same tour; this note is about the push.

## Design

**What is kept from the last tour.** When a tour is ready, Docent saves a small *basis* beside the cache, one per PR, model and prompt version: each stop with the exact text of the lines it cites (plus two lines of context either side, as core's anchors already keep), which of those lines were changed lines, and a fingerprint of every changed line in the diff. It's server-side only: the browser never sees it.

**When a push arrives**, the tour cache misses (the head changed). If a basis exists for an earlier head of the same PR, with the same title and description, Docent plans an update instead of a whole tour:

1. **Heal each stop.** Every citation is re-anchored in the new head (or base) with core's `reanchor`, which follows moved code and never guesses. A stop is *kept* only if every citation is found, and the lines inside it that are changed lines are the same ones as before. Otherwise the stop is *stale*.
2. **Find what's new to the reviewer.** A changed line of the new diff is *new since the last tour* when no changed line of the old diff had the same file, side and text. This compares the two diffs, not the two heads, so a rebase or a merge from main doesn't flood it.
3. **One update call.** The guide gets the same first prompt as a whole tour (the full new diff, the same rules), plus an update section: the stops by number, which are stale, and the line ranges that are new. It sends back only the stops it rewrites or adds, in the repair format that already exists (`replaces: n`, or `0` for a new stop). A stale stop it doesn't rewrite is **dropped**, never left pointing at old lines.
4. **Same checks, plus one.** The merged tour goes through the full checker on the full new diff, and the skip ledger is computed from scratch, as for any tour. One extra rule: if any new-since-last-tour line isn't proven safe to skip, some core_change or edge stop must cite one of them. Problems go through the usual repair loop.

**Nothing changed but the head** (a rebase with no change to the diff): every stop is kept, and if the kept tour passes the checker it's ready with no model call.

**What the reviewer sees.** The kept stops show at once, while the guide updates, through the same per-stop checks streamed stops go through. Stops the update wrote or rewrote carry a "New since your last visit" badge, on the stop and in the route. The route says how many stops were kept and dropped.

**When it doesn't apply**, Docent writes a whole tour, as today: no basis, the same head, a changed title or description (kept stops' mismatch flags were checked against the old one), or no core_change or edge stop survives healing.

## Why this and not something else

- **A real interdiff (`git diff oldHead newHead`)** would need the old head's objects in a checkout that today fetches only base and head, and a merge from main makes it list every upstream change. Comparing the two diffs' changed lines needs no fetch and ignores upstream noise. Its weakness: a line whose text is unchanged but whose meaning moved (a caller changed elsewhere) doesn't count as new. The full diff is still in the prompt, and the guide may rewrite any kept stop.
- **Resuming the old guide session** would reuse its prompt cache, but sessions aren't kept, and the old session's diff is wrong for the new head.
- **Storing the basis inside the cached tour** would send cited code to the browser on every snapshot. A separate file keeps the payload as it was.

## Safety

- The ledger and checker run on the full new diff. A kept stop is re-checked exactly as a new one: its citations must land on real lines.
- A stop whose code moved is re-anchored; one whose code is gone or whose changed lines differ is rewritten or dropped. A stop never points at the wrong lines.
- A malicious line added in the second push is new since the last tour, so the guide is pointed at it, and the extra rule makes the update explain at least one such line. It is no less visible than in a whole tour: if the guide leaves it off the route, the ledger lists it as "not on the route", as before.

## Results

See the PR for the numbers: cost and time to first stop for an updated tour against a fresh tour at the same head, on three push sequences of this repo's own PRs, plus the adversarial fixtures.
