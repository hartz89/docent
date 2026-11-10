# Core data model

The domain model of a Docent review. This spec lives next to the code in `src/` and changes in the same PR. Each rule has a number, and a test cites it in its name, for example `test('D3: …')`. Where the types already make a rule impossible to break, the rule says "(type)", and `src/types.test.ts` proves it with `@ts-expect-error` lines. `src/spec.test.ts` fails if a rule has no test naming it, or a test names a rule that isn't here.

Conventions: line numbers are 1-based. A file's text is split into lines on `\n` or `\r\n`; a final line break ends the last line and doesn't start a new, empty one. A **commit** is a git SHA. "Non-empty" means at least one element, enforced by the type.

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

- **A1.** An anchor stores its text as a non-empty list of lines, a location (commit, path and start line), and its **context**: up to two lines just before and just after it. The end line is derived from the text, so it can't disagree with it. (type)
- **A2.** An anchor is either **current** (its location is valid at its commit) or **out of date** (the code is gone; it keeps the last place it was seen). An out-of-date anchor has no current location to read. (type)
- **A3.** A current anchor made from a file's text matches that text: the lines at its location are exactly its lines, and its context is exactly the lines around them.
- **A4.** Re-anchoring checks an anchor against a new version of its file (commit, path, text), or against nothing if the file was deleted. Where the text appears exactly once, the anchor moves there. Where it appears more than once, the anchor moves to the one match whose context also matches. Otherwise (gone, deleted, or still ambiguous) it becomes out of date. Its old line number never decides between matches. When it moves, its context becomes the new surroundings.
- **A5.** Re-anchoring never points at the wrong lines: when the result is current, the lines at its new location are exactly its lines.
- **A6.** Matching is exact, line by line. Reformatting the cited lines makes the anchor out of date. An out-of-date anchor can become current again if its text comes back.

## Tour

A tour is the docent's walk through the diff: ordered stops, plus the parts it skipped.

- **T1.** A tour belongs to a review and was written for one head commit. It has a list of stops and a list of skips.
- **T2.** Every stop has an id, a kind, a title, a body, anchors and flags. The kinds are `intent`, `map`, `core_change`, `edge` and `verdict_prompt`.
- **T3.** `core_change` and `edge` stops cite at least one anchor. (type) The other kinds may cite none.
- **T4.** Stops appear in kind order: intent, map, core change, edge, verdict prompt. A kind may repeat or be absent, except that the tour ends with exactly one `verdict_prompt`.
- **T5.** A stop's flags mark what it surfaces beyond the change itself: `mismatch` (the handoff or description disagrees with the code) and `danger` (an obvious, dangerous problem). Any kind may carry flags, and flags play no part in coverage. (type)

## Skip

- **S1.** A skip targets either one file (by `path`) or one hunk (by hunk id), carries a reason, and records the head commit it was judged at. (type)
- **S2.** The reason is a single line of text: not blank, no line breaks. (type: only `oneLine()` makes one)

## Coverage

Every changed line has to be explained or visibly skipped, and never both. Nothing slips through.

- **C1.** A changed line is **skipped** by each skip whose target is its file or its hunk. It is **explained** by each `core_change` or `edge` stop with a current anchor that covers it. An anchor at the diff's head commit covers the added lines in its range, in its file. An anchor at the base commit covers removed lines the same way.
- **C2.** `intent`, `map` and `verdict_prompt` stops explain nothing. A map or intent stop may cite any lines, but citing them doesn't count, so a broad map can't hide gaps.
- **C3.** Stale judgments count for nothing. Anchors that are out of date or at any other commit explain nothing, and skips judged at another head skip nothing. So a stale tour shows up as unexplained lines, not as false coverage.
- **C4.** Several stops may explain the same line, and several skips may skip it. Both are fine: overlap isn't a contradiction.
- **C5.** The invariant: every changed line is skipped or explained, and **not both**. A coverage check reports lines that are neither as **unexplained**, and lines that are both as **conflicts**, naming the skips and stops involved. A tour is complete when both lists are empty.
- **C6.** A skip whose target isn't in the diff is reported as **unknown**. It skips nothing.
- **C7.** A tour written for a different head than the diff's is not checked line by line. The check reports it as **stale**, with both commits.

The ledger (below) is built to replace C5. Once the server and the tour schema are wired to it, an uncited line no longer fails a tour: it lands in the ledger as a proven skip or "not on the route", and the model stops writing skips. Until then both exist side by side, and the server still runs this check.

## Proven skip

A script's proof that some changed lines can't change behavior, with a label to show in their place. A proof only *allows* a skip: a stop that cites the lines wins (L2). Every detector is conservative. When it can't tell, it proves nothing, and the line stays visible as "not on the route". A false proof could hide a malicious change, which is the risk this exists for.

- **P1.** A proof targets a file, a hunk or one changed line, carries a label with its evidence, and records the head it was judged at. Only core's detectors make one. (type)
- **P2.** Detectors read only what they're given: the parsed diff, file text at base and head, and base's `.gitattributes`. A file whose text wasn't given is unknown, and proves nothing. Neither does text that disagrees with the diff: every hunk line must be exactly the line at its number.
- **P3.** Whitespace only: a hunk is proven when each block's removed and added lines pair up one to one and differ only in spacing. Indentation and trailing spaces may change in languages where they carry no meaning (C-family, Java, C#, Go, Swift, Kotlin, JS, TS, JSON, CSS). Spacing between tokens may change only in JS, TS, Java, C#, Go and JSON, only on lines without quotes, slashes, `#`, backslashes or non-ASCII text, and never where it would join or split tokens (`a + +b` vs `a ++b`). Blank lines may come and go, except in Go. Never proven: Python, YAML, Makefiles or any unlisted language; a file where a string could span lines (triple quotes, raw or verbatim strings, a trailing backslash, or a line with a backtick that is left open or also holds a quote, slash, backslash, brace or `$`); Go directives.
- **P4.** Blank lines: a changed blank line is proven in the same languages as P3, plus Python, except Go, in a file where no string can span lines.
- **P5.** Imports in a new file: in a newly added JS or TS file, named and type-only imports at the top of the file are proven, including multi-line ones. The top of the file is read statement by statement (blank lines, comments, directives, imports), and stops at the first other thing. Never proven: side-effect, default or namespace imports, or any import in an existing file.
- **P6.** Re-exports: a JS or TS barrel file is proven when both versions consist only of single-line `export … from` statements, `//` comments and blank lines. A new or deleted barrel is proven. A changed one must load the same modules in the same order, keep its `export *` lines, keep every existing name bound to the same source, and add no names next to an `export *` (they could shadow it).
- **P7.** Lockfiles: a known lockfile (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `Cargo.lock`, `go.sum`, `poetry.lock` and so on) is proven when a matching manifest beside it, or below it for workspaces, changed too. The evidence names those manifests, and the ledger counts the proof only when one of them is on the route (L3). Never proven: a lockfile created, deleted or moved, or one whose changed lines point at a source other than the known registries (git URLs, tarballs, local files).
- **P8.** Generated and vendored: a file is proven when base's `.gitattributes` marks it `linguist-generated` or `linguist-vendored`, or when it already existed at base, matches a known pattern (`dist/`, `vendor/`, `node_modules/`, `__generated__/`, `*.min.js`, `*.pb.go` and a few more) and base's `.gitattributes` doesn't unset it. A new file can't vouch for itself by its folder. The PR's own `.gitattributes` never counts. A `.gitattributes` line this parser can't read (quoted or bracketed patterns, escapes, macros) makes that attribute prove nothing. A moved file must qualify at both paths.
- **P9.** Renames: a hunk is proven when its removed and added lines pair up one to one and become identical under one mapping of old identifiers to new ones that holds across the whole PR, plus import paths explained by the diff's own file moves. Everything else must match exactly: literals, operators, spacing, strings, `//` comments; a line with any other `/` (a possible regex) is never read. It works by allowlist, in JS and TS files without JSX or `with`, where no string can span lines. Each renamed word must sit in a safe position, on both sides: the name of a top-level definition (`function`, `class`, `const`, `let`, `var`, `type`, `interface` or `enum`, optionally exported, never `declare`; at column 0 and at bracket depth 0, counted over a file whose every line reads cleanly), a plain item (no `as`) of an `import { … }` or `export { … }` statement read whole, or a reference right after an operator, `(`, `[`, a `,` whose `(` or `[` opened on the same line, or a keyword such as `return`, `new` or `extends`, and never before `:` or `=`. Anything else, including a word at the start of a line, is unsafe. For each renamed name: the mapping is one to one; the name is never also kept as itself; every file that uses it renames its top-level definition outside a block comment, or imports it by a relative path from a diff file that exports it by name and has no `export *`; keywords never map; the first letter keeps its case; and the new name appears nowhere at base and the old name nowhere at head, in the diff's files and, from a caller's lookup, the whole repository.

## Ledger

Where every changed line stands, computed by a script from the stops' citations and the proofs. The model doesn't write it.

- **L1.** Every changed line has exactly one place: **on the route**, **proven skip** or **not on the route**. The ledger lists every changed line once, in diff order, so nothing is lost or counted twice. (type)
- **L2.** A line is on the route when a stop explains it, by the same rules as coverage (C1–C3). The route wins over any proof.
- **L3.** Otherwise, a line is a proven skip when at least one proof covers it, keeping every such proof. A proof counts only if it was judged at the diff's head. A lockfile proof also needs a changed line of one of its manifests on the route.
- **L4.** Every other line is not on the route. The tour's skips play no part.
- **L5.** A tour written for a different head than the diff's isn't placed line by line. The ledger reports it as **stale**, with both commits.

Known limits, accepted with the 2026-11-09 decision: a rename proof is lexical, so names read by reflection, string building or code outside the repository can still change meaning; the label shows the mapping so the reviewer can judge it at a glance. A generated or vendored proof says where a file lives, not that it matches its sources. A lockfile proof doesn't check that the lockfile matches its manifest, beyond its sources. Pure file moves, mode changes and binary files have no changed lines, so they're not in the ledger.

## Question thread

A reviewer's question, asked at an anchor, and its answers.

- **Q1.** A thread has an id, the anchor it was asked at, the answered exchanges so far, and the latest exchange. Only the latest exchange can be waiting for an answer. (type)
- **Q4.** Each exchange records the head commit it was asked at, so an answer is always read against the code it was about. (type)
- **Q2.** An answer's source is either the author's session (with its session id) or the guide. A guide answer is shown as "answered by the guide, not the author." (type)
- **Q3.** Only an author answer carries an answer check: `pending`, `passed` (silent) or `flagged`. A flag has a one-line note and cites at least one anchor. The guide never checks its own answers. (type)

## Batch

Change requests and suggestions travel to the author's session as one batch.

- **B1.** A batch item is a change request (an anchor and a comment) or a suggestion (an anchor, replacement lines and a comment). (type)
- **B2.** A batch is `draft`, then `sent` (at the head commit the reviewer saw), then either `revised` (with the commit the author produced) or `abandoned` (with a one-line reason, when the author's session fails or the reviewer gives up on it). It never moves backwards. (type: each state has its own shape, and only `send`, `revise` and `abandon` move between them)
- **B3.** Each review has exactly one draft, at most one sent batch, and a history of finished (revised or abandoned) batches, oldest first. The lock is the sent slot: while a batch is sent, no other batch can be. (type)
- **B4.** Sending moves the draft into the sent slot and opens a fresh, empty draft. It is refused, and nothing changes, when a batch is already sent (`locked`) or the draft is empty (`empty`).
- **B5.** Revising or abandoning moves the sent batch to the end of the history and frees the lock, so the lock can't get stuck. Both are refused, and nothing changes, when no batch is sent (`nothing_sent`).
- **B6.** Batch numbers start at 1 and go up by one per batch in a review. Every item added to a draft ends up in exactly one batch, in the order it was added.

## Cost record

One model call, logged by job.

- **K1.** A record has a job, a model, token counts (input, output, cache read, cache write), cost and latency. The jobs are a closed list, so a typo is a type error. (type)
- **K2.** Cost is a whole, non-negative number of micro-dollars (millionths of a US dollar), so sums are exact. Only `microUsd()` makes one, and it refuses anything else. (type)
- **K3.** Summing records per job gives, for each job with at least one record, the number of calls and the totals of every token count, cost and latency. Jobs with no records are left out.
- **K4.** Summing is order-independent, and summing two sets of records separately then adding the totals gives the same result as summing them together.
