# Cheaper questions on long author sessions

**2026-11-11 · Claude Code 2.1.318 (bundled with Agent SDK 0.3.318) · claude-opus-5-5 and claude-haiku-5-5 · about $5.70 total**

**Result.** Every question forked the author's session from scratch, so it wrote the whole session to the prompt cache again. Priming fixes this: Docent forks the session once with a fixed turn, keeps that copy, and forks every question from it. Later questions then read the cache. On a 263k-token session, a follow-up question drops from about $0.28 to $0.03 on Haiku. On Opus, it drops from about $1.90 to about $0.15–0.20. The first question costs about the same as before. A cheaper question model is now a flag. Forking at the PR's last message helps only some sessions, so it isn't built yet.

## Why the cache wasn't reused

The setup: this project's coordinator session, 263k tokens of context. Copies were made in the scratchpad and the originals were never changed. Each fork used Docent's exact read-only options.

| What we tried | Second fork of the same session |
| --- | --- |
| Forked directly, as Docent does | **Missed.** It wrote 233k tokens again ($0.28 on Haiku). The same thing happened on a 47k-token session, and in the live test's tiny one. |
| Forked through a logging pass-through to the API | **Hit.** It read 259k from the cache. This held on Opus too. |
| PR #17's exact transcript states, replayed through the pass-through | **Hit.** That includes the state where the author's session gained a task notification between the two questions. |

On the pass-through path, the system prompt, the date, the working directory and the tool list were byte-identical between forks, and every write was a 1-hour write, seconds apart. A changing author session didn't break reuse there either. The direct path can't be logged the same way, so these causes are ruled out only on the path that runs with fewer betas. What's certain is that the same forks miss directly and hit through the pass-through.

What differs is the connection. Through the pass-through, Claude Code treats the endpoint as third-party. It places a cache breakpoint on the last message of the transcript, before the new question, so the next fork can read it. On a direct connection it sends extra first-party betas: message threads, prompt-caching scope, cache diagnosis and others. A direct fork's breakpoints can't be inspected, but it behaves as though only the newest message (the question) is cached. That means every fork with a new question misses. The [session-snapshot spike](https://github.com/hartz89/docent/pull/50) saw the same single breakpoint. Its "priming" idea is what fixes it.

## The fix: prime once, fork the primed copy

| 263k-token session, direct connection | Haiku 5.5, measured | Opus 5.5 (estimated from token counts unless marked measured) |
| --- | --- | --- |
| Before: first question | $0.25 | $1.94 measured (PR #17: $1.63 at 196k) |
| Before: each follow-up | $0.28 (rewrites 233k) | about $1.90, the same rewrite |
| After: primer, once per review | $0.23 | about $1.87 (233k at the 1-hour write price) |
| After: first question | $0.23 + $0.03 | about $1.87 + $0.15 |
| After: each follow-up | **$0.03** (reads 260k, writes 3–4k) | **$0.15–0.22**, measured where the cache was read |

On a 47k-token session, Opus measured $0.16 to prime and then $0.012 a question.

- Priming is one fork with the fixed turn "Reply with just: Ready.", limited to one turn. It is saved, then moved out of `~/.claude/projects` into a private temp folder. That way neither Claude Code's resume list nor Docent's own session search sees it. Docent picks the primer's session id before it starts, so if the primer fails at any point its saved copy is deleted, and the cleanup can never point at the author's own transcript. Questions fork that file by path, and those forks aren't saved. Closing the review stops a primer still running, then deletes the folder.
- The first question pays for the primer and shares its deadline. The fork budget caps each call on its own: the pre-fork estimate prices the primer, and a first question left with only the remainder would run out on a big Opus session.
- It depends on the 1-hour cache that Claude Code uses on a subscription. A question more than an hour after the last one rewrites the cache once, which is what every question cost before.
- Opus follow-ups still cost dimes, not cents. Each tool call in a fork re-reads the whole session (about $0.05 per call on Opus).

## A cheaper model for questions

There were five questions about [PR #44](https://github.com/hartz89/docent/pull/44), whose reasoning lives only in the session. Each answer was checked against the session and the PR.

| | Opus 5.5 | Haiku 5.5 |
| --- | --- | --- |
| Right, with the author's actual reasons | 5/5 | 3/5 |
| Right, but hedged ("I don't have a record…", then the right reason) | 0 | 1 |
| Said it didn't know, when the session held the answer | 0 | 1 (why the floor covers all of `apps/server/src/`) |
| Made something up | 0 | 0 |

Haiku also answered two questions about [PR #42](https://github.com/hartz89/docent/pull/42) correctly. In this small sample (one miss in seven questions), it said it didn't know rather than make something up. Opus gives more of the reasoning and more context. The question model is now `--question-model` (default: the guide's model). Haiku is priced at its long-prompt rate ($0.50 input per million above 100k tokens), which Docent didn't model before. That changes Haiku's reported costs and the fork estimate.

## Forking at the PR's last message

Claude Code writes a `pr-link` record whenever a session touches a PR. For [PR #42](https://github.com/hartz89/docent/pull/42), forking the coordinator at the end of the turn with #42's last `pr-link` cut the context from 263k to 149k tokens (−43%). Two answers were as good as with the full session. The first question on Haiku cost $0.13 instead of $0.25.

It isn't built. It only helps sessions that kept working after the PR. A builder session usually ends with its PR, so it saves nothing there. `pr-link` is also a coarse marker: work on the PR that touched no `gh` command could fall after it and be cut. Worth revisiting with a better marker, such as the last push of the PR's head commit.

## Also seen

- **A fork keeps the author's full tool list in the request,** Bash, Edit and Write included, so the cache prefix stays the same. Claude Code then refuses those tools in the fork: "Bash is disabled for this session", and the same for Write, Edit and Agent. No file changed. Read-only holds, and this PR doesn't change it.
- **A live test guards the cache reuse.** `agent.live.test.ts` primes a kept copy of a tiny Haiku session and asserts that two questions forked from it read its cache. Without priming, the same assertion failed twice. The 263k-token numbers above come from the scratchpad runs, not from that test.

## Spend

About $5.72 of the $8 cap: $3.34 on Opus (five questions and small-session checks), $2.37 on Haiku over 43 runs, and a cent of live tests. Scripts and logs are in the scratchpad (`cheap-questions/`). They aren't committed.
