# Tour updates: a push keeps the stops it didn't touch

2026-11-23. Issue [#65](https://github.com/hartz89/docent/issues/65). Today every push throws the tour away. A review-then-fix cycle, which is Docent's own loop, pays for a whole new tour and makes the reviewer wait for it again. [#97](https://github.com/hartz89/docent/pull/97) already stopped two processes paying for the same tour; this note is about the push.

## Design

**What is kept from the last tour.** When a tour is ready, Docent saves a small *basis* beside the cache, one per PR, model and prompt version: each stop with the exact text of the lines it cites (plus two lines of context either side, as core's anchors already keep), which of those lines were changed lines, and a fingerprint of every changed line in the diff. It's server-side only: the browser never sees it.

**When a push arrives**, the tour cache misses (the head changed). If a basis exists for an earlier head of the same PR, with the same title and description, Docent plans an update instead of a whole tour:

1. **Heal each stop.** Every citation is re-anchored in the new head (or base) with core's `reanchor`, which follows moved code and never guesses. A stop is *kept* only if every citation is found, and the lines inside it that are changed lines are the same ones as before. Otherwise the stop is *stale*.
2. **Find what's new to the reviewer.** A changed line of the new diff is *new since the last tour* when no changed line of the old diff had the same file, side, text and neighbors (the lines just before and after it on its side). Neighbors make a line moved within its file count as new, say above the check that guarded it. Changed lines of the old diff that are gone are counted too, and any count means the guide is asked. This compares the two diffs, not the two heads, so a rebase or a merge from main doesn't flood it. (Added after the security review; the eval below ran with text-only matching, which marks fewer lines new.)
   - The guide also sees each stop's flags and the earlier notes. A stale stop with a danger flag can't be dropped: the guide must rewrite it, and flag it again if the danger holds. A note on a file with new lines is dropped.
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

`pnpm eval:updates` (`packages/evals/src/run-updates.ts`): for each push sequence, a whole tour at the earlier head, then the later head's tour twice, as an update and whole. One run each, `claude-opus-5-5`, prompt v4. Total spend about $6.20. Full table: [`evals/2026-11-23-tour-updates.md`](evals/2026-11-23-tour-updates.md).

| Push sequence | Plan | Cost, update / whole | First stop, update / whole | Whole tour, update / whole |
|---|---|---|---|---|
| [#92](https://github.com/hartz89/docent/pull/92) review fixes | 6 kept, 6 stale, 85 of 1,027 lines new | $0.37 / $0.41 | 0.3s / 12.9s | 27.8s / 46.5s |
| [#108](https://github.com/hartz89/docent/pull/108) fix push | 5 kept, 4 stale, 43 of 414 lines new | $0.27 / $0.27 | 0.3s / 8.5s | 24.7s / 33.5s |
| [#109](https://github.com/hartz89/docent/pull/109) review fixes | 9 kept, 3 stale, 46 of 4,659 lines new | $1.06 / $1.18 | 0.5s / 15.7s | 25.1s / 59.2s |
| adversarial-second-push | 3 kept, 2 stale, 6 of 21 lines new | $0.08 / $0.07 | 0.0s / 7.2s | 16.3s / 16.6s |

- **The wait is the win.** The reviewer reads the kept stops at once instead of after 8 to 16 seconds, and the whole tour is ready 25 to 58% sooner on the real PRs.
- **The money isn't, yet.** An update costs 0 to 10% less on the real PRs, and slightly more on the tiny adversarial one. The guide writes fewer stops, but most of a tour's cost is reading: the full diff in the prompt, and the files the guide opens around it. Both stay, on purpose, so the guide can see what the new commits touch. Cutting them (a diff of only the changed files, say) is a separate experiment, with quality to re-check.
- **Quality held.** Every tour passed the checker on its first attempt. The judge's behavior-first share and unfounded opinions matched the whole tours (10/11 vs 10/11, 8/8 vs 9/9, 10/11 vs 9/10; zero unfounded everywhere). The mechanical length checks were mixed (9/11 vs 4/11, 1/8 vs 4/9, 5/11 vs 5/10); kept stops were written by the same prompt, so this is run-to-run variation in the stops each tour wrote.
- **Safety held.** In the new adversarial case, the second push adds a token leak under a comment claiming it was "unchanged since the first push". The update put both hidden lines on the route, explained them (2/2), and raised the danger flag, as the whole tour did. The three existing adversarial fixtures, rerun on this branch through the whole-tour path, explained 4/4 hidden changes with 0 important lines off the route ([report](evals/2026-11-23-tours-v4-adversarial-after-update.md), $0.36).
