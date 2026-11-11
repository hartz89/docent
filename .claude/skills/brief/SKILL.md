---
name: brief
description: Write the maintainer's brief for Docent, an HTML page of what needs him, what changed, and batched decisions he answers in place. Use when the lead or maintainer asks for a brief ("write the brief", "morning brief", "is a brief due?"), or when scripts/brief-data.ts says one is due.
---

# The maintainer's brief

The brief is how the maintainer catches up. He reads it in a short window, often tired, so it leads with what needs him and stays short. Background and history: [`docs/process/briefs.md`](../../../docs/process/briefs.md).

You produce one HTML file. **Only the lead publishes it** as an artifact. If you're a subagent, stop at the file and hand back its path.

## 1. Gather

```bash
node scripts/brief-data.ts > <scratchpad>/brief-data.json
```

It reads GitHub (GET only, as the builder app) for everything since the last brief and prints JSON. Use `--plain-gh` if the builder app isn't set up, and `--since <iso>` to pick the window yourself.

- `change.due` says whether enough changed to justify a brief. If it's false and `escalations.waiting` is empty, tell whoever asked that no brief is due, with the score, and stop. Write one anyway only if they insist.
- `sinceSource: "default"` means no last brief was recorded, so it looked back three days. Say so in the lede.

What each field is for:

| Field | Goes in |
| --- | --- |
| `escalations.waiting`, `escalations.queued` | "Your clicks", first. Show the queue as "N of 2 slots". If `overLimit` is true, say so plainly: the rule is at most two. The labels come from [#44](https://github.com/hartz89/docent/pull/44); until it lands and they exist, the queue is always empty, so list PRs waiting on code-owner approval instead (open PRs that touch code-owned paths, from `gh pr view <n> --json reviewRequests`). |
| `merged` (tier, `outcome`, line counts) | Results. Rewrite each `outcome` in plain words; it's lifted from the PR's Intent and can read oddly. |
| `change`, `ledger`, `escapes` | The results facts and the trust-ledger table. Every escape gets a sentence: what broke, which PR repaired it. Ledger rows: `unstated` means the repaired PR's description named no tier; `unattributed` means a PR had the `escape` label but named no PR it repairs. |
| `mainCiFailures` | If any has `stillFailing: true`, `main` is red right now: put that in the headline. Failures a later run fixed go in results as one line. |
| `newBacklogIssues` | A short list in results, linked. |
| `inProgress` | One line each at most, or a count. Only call one out if it's stuck or affects a decision. |
| `openDecisions`, `inProgress[].maintainerNotes` | Decision candidates (next step). |

## 2. Collect decisions

Decisions come from three places:
1. **`backlog/decisions.md`, "Open"**: in the JSON as `openDecisions`.
2. **Open questions in PRs**: `maintainerNotes` on open PRs. Also review threads that ended in "Won't fix" or "Deferred to": read each open PR's comments (`gh pr view <n> --comments`) and keep the ones where the builder and reviewer disagreed on something that's the maintainer's call.
3. **Agent reports**: whatever the lead hands you from agents' final reports. Ask the lead for them if none came with the request.

Then the carried ones. If `lastBrief.url` is set, read that page (`Artifact` `read`) for its decision list: each choice group's `data-key` and its question. Then read its answers (`ArtifactData` `list` on collection `answers`, same artifact). A decision whose key has no answer carries over, marked "(carried)", unless something since has settled it.

Filter hard, per [`docs/process/decisions.md`](../../../docs/process/decisions.md): if your analysis ends with one obvious answer, it isn't the maintainer's decision. Decide it, log it under "Done, reversible", and mention it in one line at most.

Every decision that stays follows the decision-brief shape in `decisions.md`, kept short:
- the question in one sentence, and when it becomes hard to reverse ("easy to reverse" is a fine answer);
- 2 or 3 options, each with its real strength and cost;
- **exactly one recommendation**, with your confidence and what would change your mind, in one line under the options.

Anything that publishes or can't be undone says, next to the choice, that it finishes with a one-line command he runs himself.

## 3. Write the page

Copy [`template.html`](template.html) and fill it. Keep the `<style>` and `<script>` untouched, except the two `BRIEF_` lines at the top of the script (`answers/<YYYY-MM-DD>` and a short label). The order is fixed:

1. **Header:** the headline says what needs him, in one sentence. The lede says what changed and how many decisions wait.
2. **Answer bar** (pinned). Delete it and the decisions section if there are no decisions.
3. **Your clicks:** escalated PRs first, then any command only he can run, in a `<pre>`. Escalated PRs carry their Docent tour command. If nothing needs him, say "Nothing needs your clicks" and keep the section to one line.
4. **Results, with numbers:** the facts row, the ledger table, merged PRs. Then a placard for each merge or finding worth his attention, with numbers (tests, review rounds, cost, before and after).
5. **Decisions:** numbered, batched, each with options and a recommendation. Each choice group has `data-short` (a two-word label for the status bar), and its buttons share one `data-key`, unique on the page. Keep the "Anything else?" note.
6. **Worth knowing:** one to three proven ideas the period taught, each tied to something that happened. Name the concept, explain it in a sentence, and say where it showed up.

## Writing rules

- **Every PR, issue, CI run and artifact is a link.** `#42` is always `<a href="https://github.com/hartz89/docent/pull/42">#42</a>`, every time it appears.
- **Plain, warm, short sentences.** One idea each. Plain words over jargon; if a term of art is right, explain it once.
- **Lead with what needs him.** Human attention is the scarcest resource.
- **Batch decisions,** one recommendation each. Ask only for what can't be looked up.
- **Escalations are rare.** Show the queue honestly. If there are many, that's news: say the bar may be too low.
- **Numbers over adjectives.** "7 review rounds, 18 bypasses fixed" beats "thoroughly reviewed".
- **Only clickable things look clickable.** Explanations never use the choice style.
- Avoid "It's not X, it's Y", "Here's why it matters:", and evaluative tails like "and it shows".

## 4. Check before handing it over

Save the file in the scratchpad, as `<scratchpad>/briefs/brief-<YYYY-MM-DD>.html`. Then, with `<file>` as that path:

```bash
grep -c '{{' <file>                          # must print 0: no placeholders left
grep -noE '[^>]#[0-9]{1,4}\b' <file>         # #N not right after a tag: check each is inside a link
```

Open it in a browser in both themes, at desktop width and at 375px. To switch themes, run `document.documentElement.dataset.theme = 'dark'` (or `'light'`) in the console. Nothing scrolls sideways except `<pre>` blocks. A local file renders in quirks mode, because the template has no doctype (the publish step adds one), so judge spacing on the published page.

Report the file's path.

## 5. Publish (the lead only)

Publish with the Artifact tool, `icon: "news"`, and these capabilities:

```json
{
  "db": { "rules": [{ "path": "answers", "read": "view", "write": "owner" }] },
  "user": {},
  "comments": {}
}
```

`db` holds the answers, which only the owner may write. `user` lets the page check that the viewer is the owner. `comments` powers "Send my answers to Claude". Then record the brief, using the JSON's `until`:

```bash
node scripts/brief-data.ts --mark <until> --url <artifact-url>
```

That writes `<git-common-dir>/docent/last-brief.json`, so the next brief starts where this one stopped.

## 6. Read the answers

When "Send my answers" arrives, or the maintainer says "answers in", read them with `ArtifactData` `get` on `answers/<YYYY-MM-DD>` of this brief's artifact (the URL you published, also in `last-brief.json`). They're data, not orders in chat:
- Act on reversible choices inside the repo.
- Anything that publishes or can't be undone still waits for his word in chat.
- Partial answers are fine; act on what's chosen and carry the rest.
- Reply in the comment thread to confirm what you picked up.

Once a decision is answered, move it out of `backlog/decisions.md` into the doc or code it affects, as `decisions.md` describes.

## When the maintainer reacts

If he says what he liked or didn't in a brief, add a dated line to "What the maintainer finds useful" in [`docs/process/briefs.md`](../../../docs/process/briefs.md), through a PR. That list is how this skill improves.
