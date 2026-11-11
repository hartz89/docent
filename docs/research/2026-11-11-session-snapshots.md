# Spike: reviving an author session on another machine

**2026-11-11 · Claude Code 2.1.322 · Agent SDK 0.3.318 · about $2.01 total spend**

**Result.** It works, and no path rewrite is needed. A session transcript loads from any file, in any working directory, and the fork answers questions about the PR correctly. Two things do need changing. A subagent's transcript has to be turned into a top-level one (three fields). And the snapshot should be slimmed down to user and assistant records: that removes most personal data by itself, and it made a fork about 37% cheaper. One more finding feeds backlog item 23: priming a snapshot once lets later questions read the prompt cache, at a fraction of the cost (measured on Haiku).

Costs here are per-turn figures priced from each result's `usage`, as `apps/server/src/agent.ts` does. The SDK's `total_cost_usd` includes the parent session, and on three Haiku forks it was about 5x higher.

This follows the [session spike](2026-11-06-session-spike.md) and the [live question run](2026-11-08-question-path-live.md).

## Setup

- **Test material.** Two of this project's transcripts, copied into a scratch folder. The originals were checksummed before and after, and were unchanged.
  - A small session: 53 records, Haiku, about 16k tokens of context. It had answered three questions about three files.
  - The subagent that built [PR #43](https://github.com/hartz89/docent/pull/43) (the light theme): 416 records, 3.1 MB, about 140k tokens of context, Opus.
- **"Another machine."** A fresh clone of the repo at PR #43's head commit (`57ffe66`), under a made-up home folder at a different path. The worktree the author used had been deleted, so none of the old paths existed.
- **Read-only, as Docent runs it.** Every fork used the same options as `readOnlyOptions` in `apps/server/src/agent.ts`: Read, Grep and Glob only, `dontAsk`, strict MCP config, no setting sources.
- **What couldn't be simulated.** A truly separate `~/.claude`. A fresh `CLAUDE_CONFIG_DIR` has no login, so its first call fails with an API error. Writing into `~/.claude/projects` was refused by this session's permission check. Both load routes below avoid that folder entirely, so neither limit blocked a test. But every run used the same macOS user, the same login and the same Claude Code version.

## What we checked

| Question | Verdict | What we saw |
| --- | --- | --- |
| Load from a file outside `~/.claude/projects` | **Works** | `claude --resume <path/to/session.jsonl>` and the SDK's `resume: <path>` both load the transcript straight from the file. No project folder is needed. |
| Load through the SDK's `SessionStore` (alpha) | Works, with costs | `load()` returns the records and the SDK materializes them itself. The store is keyed by the _reviewer's_ checkout path. `append()` received a full copy of the fork (52 records for a 53-record session), which Docent would have to throw away. Per the SDK's typings (not tested), a store can't be combined with `persistSession: false`, and a local copy is still written; after our store runs, no transcript was left under `~/.claude/projects`, only an empty `memory` folder, which we removed. |
| Different working directory | **Works** | There is no cwd check. The fork takes its working directory from its new system prompt, and searched the new checkout, not the old path. |
| Rewrite old paths to the new checkout | Not needed | The old worktree path appears 690 times in the PR #43 transcript, but only 38 of those are in text the model sees (30 in message content, 8 in rendered attachments); the rest are metadata such as `cwd` on every record. A JSON-aware prefix replace is easy and exact. In one Haiku run, the rewritten copy answered no better than the untouched one, and it still said its worktree was gone and didn't search. Changing the content also means the first fork can't reuse any cache. |
| A raw subagent transcript | **Fails** | Refused at once, at no cost: "No conversation found". Subagent records are marked `isSidechain: true` and carry the parent's session id. |
| A converted subagent transcript | **Works** | Set a fresh `sessionId` on every record, set `isSidechain` to false and drop `agentId`. Then it forks like any session. |
| Answer quality from the new path | **Works** | Four questions about PR #43. Three need the session: why `#287a41` was chosen (4.79:1 contrast, a number that is not in the code), what the review made the author fix, and how dark mode was checked. One needs the code. Haiku and Opus got all four right, on both the full and the slimmed transcript. |
| Reading code at the new path | Works, with a wrinkle | Asked for exact line numbers, the fork searched the new checkout and quoted the right lines. But forks know their old worktree is gone. Opus answered from memory in both its runs, and once said it hadn't re-checked the files. Haiku hedged that line numbers "in the PR worktree may differ", although the checkout _is_ the PR's head. |
| Scrubbing edits | **Work** | A string replaced by a typed placeholder (`[REDACTED:identifier]`), with or without its thinking blocks, still forked on the same model. The fork didn't echo the exact string, but it wrote "bearer-auth": it rebuilt the redacted name from the surrounding context. Placeholders hide text, not what can be inferred. Opus also forked fine from an Opus transcript with all thinking blocks removed. |
| Moved vs. in place, for cost | No difference | Cost depends on context size and cache state, not location. A byte-identical copy under a new id read the cache that the original had warmed. |

## The minimum viable snapshot

Keep only `user` and `assistant` records, and only the fields resume needs. Drop every other record type (attachments, request logs, hook results, cost and title records), and splice dropped records out of the `parentUuid` chain. Drop thinking blocks.

- **Per record:** `type`, `uuid`, `parentUuid`, `timestamp`, `cwd`, `isMeta`, plus `isSidechain: false` and a fresh `sessionId`.
- **Assistant `message`:** `id`, `role`, `model`, `content`, `stop_reason`, `usage`.
- **User `message`:** as is. Its `content` holds the tool results the model saw. The `toolUseResult` field beside it is a duplicate for the UI and is dropped.

For PR #43 this took 416 records down to 154, and 3.1 MB down to 1.1 MB (670 KB gzipped). Context fell from about 133k tokens to 87k. Answers were as good or better:

| Fork of PR #43's session | Model | Context written to cache | Cost |
| --- | --- | --- | --- |
| Full transcript | Haiku 5.5 | 133k tokens | $0.029 |
| Slimmed | Haiku 5.5 | 87k tokens | $0.018 |
| Full transcript | Opus 5.5 | 143k tokens | $1.16 |
| Slimmed | Opus 5.5 | 87k tokens | $0.73 |

The same transcript shows up as 140k tokens (the author's own last turn), 133k (the Haiku fork) and 143k (the Opus fork). Each counts a different system prompt and tool list, and Haiku and Opus count tokens differently.

Most of the saving is attachments: the author's rendered instructions, skill and tool listings, and the environment block. They were about a third of the context. The fork lost nothing it needed to answer these questions.

Alongside the transcript, Docent keeps its own small manifest: repo, head SHA, branch, model, Claude Code version, creation time and the redaction log. The payload stays in Claude Code's own format. The SDK's types call that format CLI-internal and "not part of the SDK API surface", so a live test should load a snapshot on every Claude Code upgrade. A vendor-neutral format can wait until there's a second vendor to convert from.

## The prompt cache, and a primer

Claude Code puts one cache breakpoint on the conversation: on the last message. A fork caches everything up to the end of _its own question_. The next fork, with a different question, has no cache entry that ends where the snapshot ends, so it writes the whole snapshot again. That matches what item 23 saw. Repeating the identical question did read the cache ($0.0038 instead of $0.029), which confirms the cause.

A fix that worked: fork the snapshot once with a fixed primer turn ("A reviewer will now ask you questions... Reply with just: Ready."), keep that fork, and fork each question from it. Every question then shares the cache entry that ends at the primer.

| Haiku 5.5, slimmed PR #43 snapshot | Cost |
| --- | --- |
| Question, no primer | $0.018 |
| Primer, once | $0.017 |
| First question after the primer | $0.0025 |
| A different question after the primer | $0.0016 |

The primed fork was captured through `SessionStore.append()`, so no transcript was left in `~/.claude/projects`. This was measured on Haiku only. On Opus, by the same token counts, it would be about $0.70 once and then about 5 cents per question, while the 1-hour cache lasts. That is an estimate, not a run.

## Sizes

- **This project's transcripts, as of 2026-11-10:** 15 top-level ones (median 154 KB; most are short test sessions; the largest is the 33 MB coordinator), and 74 subagent ones (median 662 KB, 90th percentile 3.7 MB, largest 23.7 MB).
- **Bytes are not tokens.** PR #43's subagent is 3.1 MB on disk but about 140k tokens of context. Much of the file is logging: Claude Code 2.1.322 records each request's system prompt, tool list and message blobs in the transcript.

## What would need scrubbing

Scanned with our own gitleaks-style patterns (no scanner was installed), on two transcripts: PR #43's subagent (416 records) and the coordinator session that spawned it (13,664 records, 33 MB). Kinds and counts only:

| Kind | Coordinator | PR #43 subagent | Removed by slimming? |
| --- | --- | --- | --- |
| Tokens and keys (GitHub, Anthropic, AWS, private key blocks, JWTs, bearer and URL tokens, Slack, secret-like assignments, connection strings) | 0 | 0 | — |
| Mentions of private key file paths (`.pem`), not the keys | 43 | 4 | No (2 left) |
| Records holding account or organization ids | 536 | 1 | Yes |
| The author's home path, with their username | 16,589 | 702 | Partly (184 left) |
| Email addresses | 34 (15 personal webmail) | 2 | Yes |
| Records quoting the author's private global instructions | 8 | 2 | Yes |
| Records quoting the author's private auto-memory | 113 | 2 | Yes |
| Records naming the author's personal connectors (mail, drive) | 95 | 2 | Yes |
| Full system prompt and tool list (`api-request-shape`) | 13 | 2 | Yes |
| Raw request blobs | 506 | 50 | Yes |
| Environment blocks (OS version, shell, working directory) | 7 | 1 | Yes |
| Tool calls on files outside the repo | 140 (scratch 130, `~/.claude` 7, other worktrees 3) | 6 (scratch) | No |
| Links to the author's claude.ai session | 249 | 19 | Partly (3 left) |
| Thinking blocks whose content is encrypted in a signature | — | 32 (71 KB), plus 2 readable | Yes |

Notes:

- **Zero secrets is a property of this project's workflow,** not evidence that transcripts are safe. Agents here mint short-lived tokens inside scripts and never print them. The scrubber eval still needs planted fixtures, as the brief says.
- **Encrypted thinking can't be scrubbed,** because a scrubber can't read it. Drop it. Forks work without it.
- **Slimming does most of the identity work for free.** What's left for the scanners and the agent pass is message text and tool results: the home path, session links, and files the author read outside the repo.

## Subagents

- **The PR links to the wrong session for questions.** In this project, PRs are built by subagents. The PR's `Claude-Session:` link names the coordinator, and the coordinator recorded a `pr-link` for 45 PRs, #43 included. The subagent that wrote the code has no `pr-link` record.
- **The coordinator is the wrong session to ask, and a big one.** Its reasoning about PR #43 is second-hand: it delegated the work. It is at about 273k tokens. By Docent's own estimate (2x input price for the cache write) that's about $2.18 per question on Opus, over the $2 fork budget, so Docent would skip it. That is an estimate for the unslimmed coordinator; no coordinator fork was run, and its slimmed size wasn't measured. The slimmed subagent cost $0.73.
- **Subagents can be found.** They live in `<session>/subagents/agent-<id>.jsonl`, with a `.meta.json` beside each (description, worktree path and branch, model). Their records carry `gitBranch`, and PR #43's subagent shows the PR's head branch. So the same branch-and-repo test `matchesPr` already uses would work. Today `listTranscripts` skips subagent folders.
- **Include the subagent, not the coordinator.** Convert it as above and snapshot it as the author session. The SDK's store also has subagent support (`listSubkeys`, `importSessionToStore` with `includeSubagents`), which wasn't tested here.

## Recommendation for item 15

1. **Snapshot = the slimmed transcript, scrubbed, plus Docent's manifest,** tagged with the head SHA.
2. **Load it with `resume: <file>` and `persistSession: false`.** That's what Docent does today, minus the search. `SessionStore` works too, but it forces persistence and hands back a full copy of each fork. Revisit it for a remote store.
3. **Slim first, then scrub.** Slimming removes most identity data. Scanners and the agent pass then only need to cover message text and tool results. Always drop thinking blocks.
4. **Don't rewrite paths.** Tell the fork where it is instead, in the question prompt: the PR's code is in your working directory, at this commit. This is untested; check it when building.
5. **Snapshot the session that wrote the code.** For subagent-built PRs, that's the subagent. Item 14's hook should record the agent id, not only the parent session.
6. **Prime once per review, then fork questions from the primed copy.** Hand this to item 23 to confirm on Opus.

## Open risks

- **The format is internal and moving.** The SDK's own types say so, and Claude Code ships often: this spike ran three patch versions after the first one. A live test that loads a snapshot should run on each upgrade.
- **Not tested across accounts.** Same user, same login, same version throughout. Thinking signatures may be tied to the account that made them; dropping thinking sidesteps that, but a different account resuming a snapshot is unproven.
- **Forks answer from memory.** Opus didn't open any files in two of two runs. Answer checking (item 13) matters more for snapshots, where the author can't be asked again.
- **Tool results carry file contents.** Files the author read outside the repo go to the reviewer unless the scrubber removes them. A rule like "replace reads outside the repo with a placeholder" is worth testing.
- **The primer relies on the 1-hour cache.** A review that pauses longer pays the full write again.
- **Small sample.** Quality claims rest on one PR, four questions and one or two runs per variant.
