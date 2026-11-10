# Live run: a question answered by a fork of the real author session

**2026-11-08 · Claude Code 2.1.319 · Agent SDK 0.3.318 · claude-opus-5-5 · about $3.30 total**

**Result.** The question path works on a real PR. Docent found the author's session from the PR's `Claude-Session:` link, forked it read-only, and the fork answered with reasoning that exists only in the session. It's expensive on a long session, though: $1.63 per question.

## What we ran

`Review` with the real GitHub source, the local session finder and the SDK runner, on [PR #17](https://github.com/hartz89/docent/pull/17) ("Web: load Shiki lazily; budget the entry chunk"). The script is not committed; it is the same wiring as `docent review`, plus one `review.ask()`.

| Step | What we saw |
| ---- | ----------- |
| Finding the session | The PR body's link matched the `bridge_status` record in the coordinator's local transcript, about 250k tokens of context. Docent's own tour transcripts quote the same link, and were correctly ignored. Under 1.6 s, scanning ~530 MB of transcripts. |
| Q1: "Why is the entry budget 450 kB and not 400 kB?" | The fork said it was a judgment call with ~100 kB of headroom, that it never compared 400 kB, and that it had tested the failure by dropping the budget to 300 kB. That test is in the session, not the code. 7.5 s. |
| Q2: "Why does only a failed load clear the Shiki cache?" | The fork said the first version cleared it in the outer `catch`, and the independent review found that, plus a race. It also named what it doesn't know (whether a retried `import()` succeeds). 5.9 s. |
| Cost | $1.63 each: about 256k cache-read and 196k cache-write tokens per question. The second question, two minutes later, wrote the cache again instead of reading the first fork's. |
| The original | The live fork test proves the author's transcript is byte-identical afterwards, and that `persistSession: false` leaves no fork transcript behind. |

## What this means

- **The core bet holds.** Both answers were honest about what was decided and what wasn't, which the guide can't do from the code.
- **Cost is the open problem.** Short sessions cost under a cent (the live test's fork: $0.0003 on Haiku). Long ones cost dollars, and the $2 per-call cap means a session much bigger than this one fails, after paying, and falls back to the guide. Backlog item 12 follows up.
