# Decisions

Ask forgiveness, not permission, unless a decision really puts security, quality, or long-term goals at risk. The maintainer's attention is scarce, so a question that blocks work is expensive.

- **Just decide** routine calls. Don't list them.
- **Decide and log** calls that are the maintainer's to weigh but cheap to reverse. Go with your best recommendation, then add a line under "Done, reversible" in [`../../backlog/decisions.md`](../../backlog/decisions.md). If they object, change it.
- **Log and work around** calls that are hard to reverse: security, money, new vendors, public naming, licensing once outside contributors exist. Add them under "Open", then work on something else.

## Bringing a decision to the maintainer

**Test it first.** If your analysis ends with one obvious recommendation, the decision probably doesn't need the maintainer. Decide it, and log it under "Done, reversible."

A decision that truly needs them gets a **decision brief**, not a chat message. It's a short visual story, published as a page or doc and linked from `decisions.md`. Assume they skim it.

1. **The headline:** the choice, in one sentence, and when it becomes hard to reverse.
2. **The story:** the context they need, told visually where possible (a diagram, a comparison, a timeline), not as a wall of text.
3. **The options:** each one's real strengths and costs, and what it leads to downstream.
4. **A recommendation, with its confidence,** and what would change your mind.
5. **How to answer:** a short reply should be enough.

Design rules for interactive briefs, learned from the first two:
- **Only clickable things look clickable.** Diagrams and explanations must never use the card style of a choice. Choices get a visible control, such as a radio marker or a checkbox.
- **The status bar and the Send button stay pinned** at the top while scrolling, so answers can be sent from anywhere on the page.
- **Ask only for what can't be looked up.** If an ID or value can be derived (from an API, a name, a file), derive it instead of asking for it.

**Make it answerable in place.** Where you can, the brief is an interactive page. The maintainer picks options on the page, and their choices save to the page's own database, which only the owner can write. The agent reads them back. Answers read that way arrive as data, not as the maintainer's words in chat, and auto-mode's classifier treats them as data. So a choice from the page can unblock reversible work inside the repo. Anything that publishes or can't be undone still waits for a word from the maintainer in chat, and the page says so next to that choice. A "Send my answers to Claude" button posts a comment addressed to Claude. That's the platform's own send-to-Claude action, so it starts a turn in the agent's session. **The comment must be neutral:** "answers saved, read them from the page", with a count at most, never the choices themselves. A comment saying "merge #5: yes" reads to auto mode like page text giving orders, and it refuses to start the turn (seen 2026-11-07). The choices are already in the owner-only database, which is the trusted channel. The page must not claim the agent has picked them up. It says to nudge in chat if no reply arrives in the thread within a minute. Partial answers are fine; act on what's chosen, and leave the rest open.

**Publishing steps go to the maintainer as a one-line command.** On 2026-11-06, a "Yes, go public" sent from a brief was not enough: auto mode's classifier blocked `gh repo create --public` as "Create Public Surface." That is the right kind of caution, so don't work around it. Do all the preparation, then hand the maintainer the exact command to run themselves with `!` (for example `! gh repo create … --public --push`). For anything that publishes, the brief says up front that this is how it will finish. Record any further friction with the classifier here, so this rule can be tuned.

**Batch decisions.** The maintainer's attention comes in windows. Hold decisions that aren't urgent, and bring them together in one brief with one way to answer them all (for example "1A, 2 yes"). Send a decision on its own only when work is truly blocked on it.

## Recording answers

Once a decision is answered, it moves out of the decisions file and into the doc or code it affects, with who decided and the date.

The maintainer's standing rules go in this repo, not in any agent's private memory, so that every agent and vendor sees them.
