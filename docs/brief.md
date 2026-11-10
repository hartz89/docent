> Snapshot of the living doc at https://claude.ai/artifact/2cSekJHpTWZHqauuiHWCXH, taken 2026-11-06, with the skip rule updated 2026-11-09. The doc is the source of truth; refresh this copy when it changes.

# Docent — Design Brief

Oct 30, 2026 · @Ryan Hartzfeld · Working name; status: draft

## Problem and thesis

Docent answers one question: how do you do high-quality human review of AI-written code when you only look at a fraction of the changes, and don't have time to read every line of the ones you do? Its answer is a guided tour, led by an agent that explains the change but never reviews it for you.

Agents produce more change than any team can read. Reviewers see a fraction of what ships, and even then there's no time to read every line of every change set. The GitHub PR screen (files in alphabetical order, flat diffs) does nothing to help spend that limited attention well, so reviewers skim or grind, and neither produces a confident call on quality.

A guided tour fixes the attention problem. It walks the reviewer through what matters, skips what doesn't (visibly, with reasons), and gets questions answered while the code is still in front of them.

The thesis:

- **Review is quality control.** The reviewer's job is to make a sound call on whether the change meets the bar, and to send it back when it doesn't.
- **Good calls need answers.** To judge what you're looking at, you sometimes need to ask why it's built that way and get a trustworthy answer while you're still looking.
- **The verdict is the reviewer's.** A guide can lead the way, but the judgment is the person's own, not an AI summary they signed off on.
- **Human attention goes where it counts.** PRs arrive already through automated review, so the obvious flaws are gone and the reviewer can focus on intent, design and behavior.
- **Review should be engaging.** A tool built for reading, with the code in context and a guide alongside, makes careful review worth doing. Building a mental model of the codebase comes along with it.

**The review session.** A review is a rare, serious activity: maybe once a day, 30 to 60 minutes for a big PR. That time keeps the reviewer immersed in the codebase, makes the quality-control call a real one, and produces solid input back to the agent loop. Docent supports that thinking and never does it for the reviewer.

## Design principles

Six rules decide every trade-off below.

1. **Docent, not salesperson.** The guide helps you see the change. It describes, never approves, and only raises its own concerns for obvious danger.
2. **Local-first, bring your own harness.** No hosted service and no API bill passed to users. The server runs on your machine and uses the agents and logins you already have.
3. **Vendor-agnostic by adapter.** Claude Code first, because that's what's available today. Codex, Antigravity and others plug in through a documented adapter interface the community can extend.
4. **Autonomous by default.** No approval prompts in the normal flow. Authoring increasingly runs in cloud sessions with nobody at the keyboard.
5. **Measure cost, don't pre-optimize it.** Every model call is logged by job, so savings show up in the data.
6. **Tested like any serious codebase.** Unit, integration and end-to-end tests cover the app, server and adapters. On top of that, every agent behavior has a regression-tested eval that scores quality and cost together.

## The docent

The docent walks you through the change like a sharp, articulate engineer who knows it well. But it isn't the author: it's an independent agent that reads the change in its own fresh context and presents it as it sees it.

The tension: a smooth explanation makes code feel correct. These rules keep the guide honest.

- **Explain from the code, not the author's story.** The docent never has the authoring transcript in its context. It does read the author's handoff: a collapsed PR comment titled "Author handoff for Docent," with intent, key decisions, known gaps and where to look first, tagged with a commit SHA and reposted after each revision batch. The docent treats the handoff and the PR description as claims to check, staying healthily skeptical without being unreasonable. It works out what the code actually does.
- **Surface mismatches between intent and behavior.** "The description says it adds caching; it also changes retry behavior." Any place the handoff and the code disagree becomes a tour stop. This is how it stays independent without giving opinions.
- **Describe, don't judge.** "This now runs before the auth middleware," not "this looks fine." The only exception is obvious, dangerous problems.
- **Every claim cites lines.** Each tour stop points to the exact code so the reviewer checks it rather than trusting the narration. Anchors heal themselves: each stop stores the code it refers to, re-checks it against the current revision, and follows it when it moves. If that code is gone, the stop is flagged as out of date instead of pointing at the wrong lines (v1).
- **Show what it skipped.** Every changed line is visible: on the tour's route, collapsed as a proven skip (a script confirms lockfiles, generated files, renames and whitespace, and labels them), or listed as "not on the route". The checker builds that list, not the docent, so a skip can't be talked into hiding a change. The docent may add a one-line note, shown as its word, not proof. Reviewers can open any of them, and occasional random checks of what's off the route test the docent's judgment.
- **Order the tour by how the change works.** Intent first, then a map of what it touches, then the core change, then the edges, ending with the reviewer's verdict.

## Questions vs. feedback

Questions get answered right away; change requests wait for a batch. This split is the tool's core interaction.

In human review, a question can take an hour to answer. By then the reviewer has moved on, maybe approved, and never reads the reply. Docent keeps comprehension live and keeps the code stable.

|                | Questions and theory checks                                        | Change requests                               |
| -------------- | ------------------------------------------------------------------ | --------------------------------------------- |
| Example        | "Why does this retry three times?"                                 | "Rename this." "Rethink this approach."       |
| Timing         | Live, answered in seconds                                          | Collected into a draft revision               |
| Who answers    | The implementing agent; the docent flags only clear contradictions | The implementing agent, in one revision round |
| Effect on code | None: read-only                                                    | One new revision per batch                    |
| Session mode   | Fork of the session (read-only)                                    | Resume of the real session (writes)           |

- **The guide stays quiet on answers.** It never grades or interprets the author's answers. It steps in only when an answer looks clearly wrong or fishy against the code, and then flags it with cited lines, for example: "The author says only idempotent calls retry, but `submitOrder` retries too."
- **Questions can become feedback.** If an answer reveals a real problem, one click turns that thread into a change request in the pending batch.
- **A rename spreads properly.** When a batch includes a one-line rename, the implementing agent treats it as a codebase-wide refactor using real symbol renames, then reports back.

**Learning across reviews.** Review inputs also feed long-term improvement of the agent loop. Docent looks across past reviews for recurring patterns: repeated renames, conventions the agent keeps missing, questions that keep coming up. It proposes updates to the harness's standing context (CLAUDE.md, AGENTS.md, skills, rules), using each vendor's format through its adapter. Proposals arrive as their own small PR, so changes to the harness are reviewed like any other code.

How it works:

1. **Structured records.** Every suggestion, comment and question thread is saved with its file, symbol, feedback type (naming, error handling, testing, architecture) and resolution. Reviewers do nothing extra.
2. **Pattern finding.** A learning pass on the user's harness groups the records. Only feedback that recurs across several PRs counts, so one-off preferences don't become rules.
3. **Targeted proposals.** Each pattern becomes a concrete change where it belongs: a line in AGENTS.md or CLAUDE.md, a new skill, or a lint rule when that's more reliable than prose. Each proposal links to the reviews behind it.
4. **Reviewed and measured.** Proposals arrive as a PR reviewed in Docent. Afterward, Docent tracks whether that feedback stops recurring.

Invocation:

- **On demand (v1):** `docent learn` or a button in the app.
- **On a threshold (later):** after enough new reviews, the pass runs in the background the next time Docent is open.
- **Scheduled in CI (later, for teams):** a scheduled GitHub Action reads review records from shared storage and opens the proposal PR, using the same storage interface as snapshots.

## Review experience

Docent is an IDE for reading, not writing: it drops most of what an editor offers and keeps what helps you understand code in context.

**The bar is beauty, with maximum professionalism.** Docent should be among the best-looking developer tools anyone has used: calm typography, careful spacing, smooth and purposeful motion, and a polished light and dark theme. Engaging moments (a tour that feels like progress, a satisfying verdict) are welcome when they're understated. Later, a thorough review can earn a small, satisfying reward when it's finished, the kind of finish a well-made app gives you, never a cheap one.

**Themes and syntax highlighting.** Ship with polished dark and light themes and full, accurate syntax highlighting. Later, add popular editor themes such as One Dark, Dracula, Tokyo Night, Catppuccin, Nord, Solarized and GitHub, checking each theme's license. Support VS Code theme files, so people can bring their favorite and the community can add more.

- **The map comes first.** Opening a change shows where it sits in the system: what it touches, who calls it, what depends on it. Files come second. The goal is to hold the whole change in your head.
- **Code in context.** A read-only editor (Monaco) with jump-to-definition, find references, and free browsing of nearby files and folders. No tabs to juggle, no build tooling.
- **Suggest mode.** Edit a line in place, like suggestion mode in Google Docs, and attach a comment explaining why. Suggestions go into the pending batch.
- **The guided tour.** The docent's stops, in order, each tied to code ranges, with skipped sections collapsed and labeled.
- **Engagement ideas to try:** predict which files a PR touches before opening it; planted bugs for reviewers to find; a verdict for each PR (pass, minor issue, defect).
- **GitHub stays the record.** Comments, approvals and verdicts sync back to the PR. GitHub only accepts inline comments on lines in the diff, and one off-diff comment rejects the whole review. So sync falls back: an off-diff comment attaches to the nearest relevant changed line, or moves into the review summary with a link to its file and line. Inside Docent it stays where it was made.

## Architecture

A local server and browser app on the reviewer's machine, with the docent running on the reviewer's own harness and agents connected through adapters; there's no hosted service.

_(Diagram: architecture · local server, docent, adapters, agent sessions. See the living doc.)_

- **Review app.** A local web app with a read-only Monaco editor, started by `npx`. Not a VS Code fork.
- **Local server.** Routes questions to the best available session, holds the batch lock, logs cost per job, and syncs comments and verdicts to GitHub.
- **Docent.** Runs as a separate headless session on the reviewer's own harness and login, never through an API key the project pays for.
- **Adapters.** One small interface: deliver a review package, get status, receive "done." Each adapter declares its capabilities: live push, resume, fork, snapshot, canonical session.
- **Claude Code plugin.** Bundles a channel (live push into the running session), a hook that records session IDs, a skill for acting on review batches (including codebase-wide renames), an LSP server for real symbol renames, and a `/review` command.
- **Model providers.** Each docent job (tour, skip decision, danger flag, answer check, scrubbing) can run on a different model or vendor.

**Build what makes Docent different; use proven libraries for solved problems.** A library earns its place when it's actively maintained, permissively licensed, and worth its install size and security surface. Current picks:

- **Shiki** for syntax highlighting, using VS Code's grammars and theme files, which also makes theme support nearly free
- **Monaco** for the read-only editor view, highlighted through Shiki's Monaco integration
- **Tree-sitter** for code structure: the code map, symbol lookups and grouping related changes
- **Language servers** for jump-to-definition, find references and real symbol renames

**Proposed stack.** TypeScript end to end. TanStack Start (1.0 stable since October 13, 2026) hosts the UI and a thin server layer: type-safe routes, server functions, and streaming to the browser. It runs as a local Node server launched by `npx`; a local app doesn't need server rendering, so routes can render on the client.

The core engine stays plain TypeScript with no framework imports. That keeps it testable on its own, shared with the CLI, plugin and MCP server, and safe if the UI framework ever changes.

_(Diagram: proposed stack · six layers, built vs. borrowed. See the living doc.)_

The highlighted parts are what Docent builds; everything else is an existing library or the user's own tools.

## Security

Docent's server can wake agents that edit code, so the two biggest risks are outside access to the server and instructions hidden in the code under review.

- **Lock down the local server.** Bind to localhost only, require a random per-launch token on every request, and check the request origin, so a malicious website can't drive it.
- **Treat everything read as data.** Code, comments, PR text and the author handoff can carry injected instructions. Question forks run read-only, with no edits or command execution. Prompt-injection cases are part of the eval suite.
- **Questions never become actions.** Only a batch the reviewer sends can change code.
- **Protect transcripts.** Layered scrubbing, typed redaction placeholders, a redaction log, and private storage that follows repo permissions.
- **Minimal credentials.** Use the user's existing GitHub and agent logins with the narrowest permissions. Never write tokens to snapshots or logs.
- **Supply chain.** Signed releases, pinned dependencies, and narrow plugin permissions.

## Sessions: waking, snapshots, scrubbing

The implementing agent's session can be woken to answer questions, and snapshots pinned to commits make that work for cloud-authored PRs and multiple reviewers.

**Waking.** Claude Code can resume a session by ID headlessly (`claude -p --resume <id>`, or the Agent SDK's `resume`). With `--fork-session`, a question runs on a copy and leaves the original clean. A plugin hook records the session ID when work starts and stores it with the branch or PR.

**Routing a question**, best option first:

1. Canonical cloud session reachable → send it there in read-only mode (future mode).
2. Session live locally → push through a Claude Code channel.
3. Session closed but available → fork it headlessly.
4. Snapshot available → rebuild it into the reviewer's harness and fork.
5. Nothing available → the docent answers from the code, labeled "answered by the guide, not the author."

Never resume a session that's still running elsewhere: two processes writing to the same session will conflict.

**Snapshots.** Sessions increasingly run in temporary cloud containers, so the snapshot is the main building block. The authoring agent's last step is: scrub, snapshot, tag with the commit SHA, upload.

- **Questions only read.** Each question forks from the snapshot matching the commit being viewed, so reviewers can't end up talking to a stale version.
- **Change batches write.** Only a revision batch resumes the real session, so batches are the one place that needs a lock ("a revision is pending"). One writer, any number of readers.
- **Vendor-neutral format.** A documented snapshot format, not a raw Claude Code transcript, so a Codex-authored PR could in principle be loaded into Claude, with some loss of detail.

**Scrubbing**, autonomous by default:

1. Deterministic scanners (gitleaks/trufflehog-style patterns) for keys, tokens and connection strings.
2. An agent pass for what patterns can't catch: internal hostnames, customer data, names, proprietary details.
3. Typed placeholders such as `[REDACTED:api_key]`, so the revived session can still reason about what was there.
4. A redaction log recorded with each upload for later audit. An optional `requireUploadApproval` setting, off by default, for stricter teams.

**Canonical cloud session (future mode).** One live cloud session that every reviewer talks to removes forks and version drift. The costs: questions pile up in one context, requests have to queue, the session owner pays and has to keep it reachable, and vendor APIs vary. It plugs in as one more adapter capability.

## Cost and evals

Every agent job gets a cost meter and a regression-tested eval, so changing a prompt, model or vendor is a measured trade-off, not a guess.

**Cost tracking.** Every model call logs tokens, cost and latency by job. Users run on their own plans, so this protects them too. Expected wins show up in the data, for example "the skip decision is 40% of spend and could run on a smaller model."

**Commit-keyed cache.** Explanations are cached by commit and code range. Unchanged ranges reuse them with zero model calls, so reopening a PR or re-reviewing after a small batch costs almost nothing (v1).

**A model per job.** Each job runs on the model that fits it: a stronger model plans the tour, cheaper ones write labels and make skip decisions. The eval suite decides whether a cheaper model is good enough for a given job.

**Eval suite.** A set of fixed PRs with known answers, run in CI. Each run reports quality and cost together.

| Job           | What the eval checks                                               | Key metric                                              |
| ------------- | ------------------------------------------------------------------ | ------------------------------------------------------- |
| Tour          | Planted behavior changes and intent/code mismatches get surfaced   | Planted problems found                                  |
| Skip decision | Important code is never left off the route                         | Important code not on the route (target: zero)          |
| Danger flag   | Obvious dangerous patterns are flagged; ordinary code isn't        | Hits and false alarms                                   |
| Answer check  | Clearly wrong author answers get flagged; sound ones pass silently | Wrong answers caught, and false alarms (both low noise) |
| Scrubber      | Planted fake secrets and sensitive details are removed             | Leaks (any miss is a serious failure)                   |
| Cost          | Spend per review, per job                                          | Cost and latency                                        |

- **Planted problems work for people too.** The same mechanism that checks the agent can let reviewers practice spotting problems.
- **Evals compare vendors fairly.** Same suite, different providers or models per job. Users can pick the best model for each job on evidence.

## V1 scope and roadmap

Version one is one polished loop, for one reviewer using Claude Code: open a PR, take the tour, ask a question, suggest a change, send the batch.

**In v1:**

- `npx docent review <PR-url>` opens the local web app, with no account and no setup
- The code map, the code in context, the guided tour with visible skips
- Live questions answered by the implementing session, cross-checked by the docent
- Suggest mode and comments, sent as one revision batch
- Claude Code adapter (plugin, channel, session-ID hook, rename skill) plus a fallback that works with any agent: a structured file and a plain MCP tool
- Snapshot plus scrubbing, autonomous
- Cost logging per job and a starter eval suite in CI
- A simple lock on batches

**Languages under review.** Every language gets the core experience in v1: highlighting, the tour, live questions, suggest mode and batches, since the agents can read any code. The deep features (code map, jump-to-definition, real renames) need a Tree-sitter grammar and a language server per language, so v1 ships them for TypeScript first. Other languages come later as add-on packs, in the same spirit as the vendor adapters.

**Snapshot storage.** Storage sits behind a configurable interface from the start, so a team can scale up without changing the core. V1 ships a local store for development and testing on one machine. Shared backends, such as a private repo branch or a user-owned cloud bucket, plug in through the same interface.

**Not in v1:** multiple reviewers at once, canonical cloud sessions, other vendors' adapters, the engagement and gamification features.

**Then, roughly in order:**

1. A Codex adapter, a CONTRIBUTING guide for adapters, and vendor comparisons in the evals
2. A planted-bug practice mode for reviewers
3. Multiple reviewers on the same snapshot
4. Canonical cloud session mode where vendors support it

## Risks and open questions

The biggest risks are a fluent guide hiding problems and transcripts leaking secrets; both are covered by evals rather than by approval prompts.

- **Persuasive narration.** A good tour can talk a reviewer past a bug. Mitigated by the docent's rules and the "important code not on the route" eval.
- **Transcript leaks.** Scrubbing will miss things sometimes. Mitigated by layered scrubbing, the redaction log, private storage that follows repo permissions, and clear docs on securing transcripts.
- **Channels is a research preview.** It needs the `--channels` flag, only works while the session is open, and on Team and Enterprise plans an admin must enable it. The protocol may change.
- **Session portability (spike first).** Claude Code ties sessions to a project path. Resuming on another machine may need the repo at the matching commit plus path remapping.
- **Session lifetime.** Old session files are cleaned up after a retention period (about 30 days by default). Long-lived PRs could outlast them; snapshots cover this.
- **Compacted sessions.** Long sessions may have fuzzy memory of early decisions. One more reason the docent checks every answer.
- **Docent vendor is configurable:** by default it runs on whatever harness the user has. Users with access to a second vendor can choose it for a more independent review.

Existing tools and how they compare: [Prior art](prior-art-2026-10-31.md)
