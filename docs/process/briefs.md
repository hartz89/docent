# Briefs

A brief is how the maintainer catches up: one page with what needs him, what changed, and the decisions waiting on him, which he answers on the page. It's where the decision briefs in [`decisions.md`](decisions.md) get batched.

## When

**A brief is due when enough has changed, not on a schedule.** `node scripts/brief-data.ts` scores the change since the last brief: one point per merged PR, plus one per 500 changed lines. At 10 points a brief is due. A quiet week gets no brief; a busy night gets one. An escalated PR waiting on the maintainer is also worth a brief, even when the score is low.

The threshold is a first guess. On 2026-11-10, a busy day, the repo scored 30. Tune it from what the maintainer says.

## How

1. The lead runs the [`brief` skill](../../.claude/skills/brief/SKILL.md). It gathers the data with `scripts/brief-data.ts`, collects decisions, and fills [the template](../../.claude/skills/brief/template.html).
2. The lead publishes it as a private artifact, with an owner-only answers database.
3. The lead records it: `node scripts/brief-data.ts --mark <until> --url <artifact>`. That writes `<git-common-dir>/docent/last-brief.json`, outside the repo and shared by every worktree, so the next brief starts where this one stopped. It's per machine, like the briefs themselves.
4. The maintainer answers on the page and presses "Send my answers". The agent reads them from the database. See "Make it answerable in place" in [`decisions.md`](decisions.md).

## What the gather script reads

All GitHub reads are GETs through `gh api`, run as the builder app, which the runner limits to reads (see [`agent-identities.md`](agent-identities.md)).

- **Merged PRs**, with the tier and outcome their description states.
- **The escalation queue:** open PRs labelled `needs-maintainer` (at most two) and `escalation-queued`, from [`pull-requests.md`](pull-requests.md).
- **Open PRs in progress**, with any description section addressed to the maintainer.
- **Escapes:** reverts, and fixes that name what they repair. A fix for an escaped defect says `Repairs #N` on its own line, or carries the `escape` label, so the trust ledger can count it.
- **The trust ledger's raw numbers:** merged PRs and escapes per tier, for the period.
- **New issues** labelled `backlog`, **failed CI runs on `main`**, and the "Open" section of [`backlog/decisions.md`](../../backlog/decisions.md).

## What the maintainer finds useful

Keep this list current. Add a dated line when he reacts to a brief.

- **2026-11-10:** Liked the third brief's shape: clicks first, results with numbers, batched decisions with one recommendation each, and "worth knowing" notes that teach a proven idea from real events.
- Every PR, issue or artifact mentioned is a clickable link.
- Plain, warm, short sentences.
- Escalations should be rare, and the brief shows the queue.
