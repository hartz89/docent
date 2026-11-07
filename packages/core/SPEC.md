# Core data model

The domain model of a Docent review. This spec lives next to the code in `src/` and changes in the same PR. Each rule has a number; the tests cite it, for example `// D3`. Where the types already make a rule impossible to break, the rule says "(type)", and `src/types.test.ts` proves it with `@ts-expect-error` lines. `src/spec.test.ts` fails if a rule has no test citing it, or a test cites a rule that isn't here.

Conventions: line numbers are 1-based. A file's text is split into lines on `\n` or `\r\n`. A **commit** is a git SHA. "Non-empty" means at least one element, enforced by the type.

## Review

A review is one pull request, read at a base commit and a head commit.

- **R1.** A review has an id, the PR (`owner/repo` and number), a base commit and a head commit. (type)
- **R2.** Review ids, stop ids, thread ids, session ids and commits are distinct branded types. Passing one where another is expected is a type error. (type)

## Diff

The diff between the review's base and head: files, their hunks, and each hunk's lines.

- **D1.** A file has a `path` and an `oldPath`. `path` is where it lives at head, or lived at base if it was deleted. `oldPath` is its path at base; it equals `path` unless the file was renamed.
- **D2.** A hunk line is `added` (has a head line number), `removed` (has a base line number) or `context` (has both). Line numbers are computed from the hunk's start lines, never supplied per line, so they can't disagree. (type)
- **D3.** The **changed lines** are the added and removed lines. An added line is identified as (`path`, head side, line). A removed line is identified as (`oldPath`, base side, line).
- **D4.** Every hunk has an id of the form `<path>#<hash>`. The hash covers the file path and the hunk's lines (kind and text), not its line numbers.
- **D5.** Hunk ids are unique within a diff. When two hunks in the same file would get the same id, later ones get a suffix: `#<hash>-2`, `-3` and so on, in file order.
- **D6.** Hunk ids are stable. The same diff always gives the same ids. Adding, removing or shifting other hunks doesn't change a hunk's id, unless that changes how many identical hunks come before it in the same file (D5).

## Anchor

An anchor is the code a claim cites: the exact text of one or more whole lines, and where that text sits at a commit.

- **A1.** An anchor stores its text as a non-empty list of lines, and a location: commit, path and start line. The end line is derived from the text, so it can't disagree with it. (type)
- **A2.** An anchor is either **current** (its location is valid at its commit) or **out of date** (the code is gone; it keeps the last place it was seen). An out-of-date anchor has no current location to read. (type)
- **A3.** A current anchor made from a file's text matches that text: the lines at its location are exactly its lines.
- **A4.** Re-anchoring checks an anchor against a new version of a file (commit, path, text). If the text is still at the same start line, the anchor stays there. Otherwise, if the text appears exactly once in the new file, the anchor moves to it. Otherwise (gone, or found more than once) it becomes out of date.
- **A5.** Re-anchoring never points at the wrong lines: when the result is current, the lines at its new location are exactly its lines.
- **A6.** Matching is exact, line by line. Reformatting the cited lines makes the anchor out of date. An out-of-date anchor can become current again if its text comes back.

## Tour

A tour is the docent's walk through the diff: ordered stops, plus the parts it skipped.

- **T1.** A tour belongs to a review and was written for one head commit. It has a list of stops and a list of skips.
- **T2.** Every stop has an id, a kind, a title, a body, and anchors. The kinds are `intent`, `map`, `core_change`, `edge` and `verdict_prompt`.
- **T3.** `core_change` and `edge` stops cite at least one anchor. (type) The other kinds may cite none.
- **T4.** Stops appear in kind order: intent, map, core change, edge, verdict prompt. A kind may repeat or be absent, except that the tour ends with exactly one `verdict_prompt`.

## Skip

- **S1.** A skip targets either one file (by `path`) or one hunk (by hunk id), and carries a reason. (type)
- **S2.** The reason is a single line of text: not blank, no line breaks. (type: only `oneLine()` makes one)

## Coverage

Every changed line has to be explained or visibly skipped. Nothing slips through.

- **C1.** A changed line's **homes** are:
  - each skip whose target is its file or its hunk;
  - each `core_change` or `edge` stop with a current anchor that covers it. An anchor at the diff's head commit covers added lines in its range, in its file. An anchor at the base commit covers removed lines the same way.
- **C2.** `intent`, `map` and `verdict_prompt` stops give no line a home. They may cite changed lines freely, because a map or an intent naturally overlaps the code that core-change stops explain.
- **C3.** Anchors that are out of date, or at any other commit, give no line a home. So a stale tour shows up as unexplained lines, not as false coverage.
- **C4.** A stop counts as one home for a line, however many of its anchors cover it.
- **C5.** The invariant: every changed line has **exactly one** home. A coverage check reports the lines with no home as **unexplained**, and the lines with two or more as **doubled**, with their homes. A tour is complete when both lists are empty.
- **C6.** A skip whose target isn't in the diff is reported as **unknown**. It gives no line a home.

## Question thread

A reviewer's question, asked at an anchor, and its answers.

- **Q1.** A thread has an id, the anchor it was asked at, the answered exchanges so far, and the latest exchange. Only the latest exchange can be waiting for an answer. (type)
- **Q2.** An answer's source is either the author's session (with its session id) or the guide. A guide answer is shown as "answered by the guide, not the author." (type)
- **Q3.** Only an author answer carries an answer check: `pending`, `passed` (silent) or `flagged`. A flag has a one-line note and cites at least one anchor. The guide never checks its own answers. (type)

## Batch

Change requests and suggestions travel to the author's session as one batch.

- **B1.** A batch item is a change request (an anchor and a comment) or a suggestion (an anchor, replacement lines and a comment). (type)
- **B2.** A batch is `draft`, then `sent` (at the head commit the reviewer saw), then `revised` (with the commit the author produced). It never moves backwards. (type: each state has its own shape, and only `send` and `revise` move between them)
- **B3.** Each review has exactly one draft, at most one sent batch, and a list of revised batches, oldest first. The lock is the sent slot: while a batch is sent, no other batch can be. (type)
- **B4.** Sending moves the draft into the sent slot and opens a fresh, empty draft. It is refused, and nothing changes, when a batch is already sent (`locked`) or the draft is empty (`empty`).
- **B5.** Revising moves the sent batch to the end of the revised list and frees the lock. It is refused, and nothing changes, when no batch is sent (`nothing_sent`).
- **B6.** Batch numbers start at 1 and go up by one per batch in a review. Every item added to a draft ends up in exactly one batch, in the order it was added.

## Cost record

One model call, logged by job.

- **K1.** A record has a job, a model, token counts (input, output, cache read, cache write), cost and latency. The jobs are a closed list, so a typo is a type error. (type)
- **K2.** Cost is a whole number of micro-dollars (millionths of a US dollar), so sums are exact.
- **K3.** Summing records per job gives, for each job with at least one record, the number of calls and the totals of every token count, cost and latency. Jobs with no records are left out.
- **K4.** Summing is order-independent, and summing two sets of records separately then adding the totals gives the same result as summing them together.
