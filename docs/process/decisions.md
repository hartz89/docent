# Decisions

Ask forgiveness, not permission, unless a decision really puts security, quality, or long-term goals at risk. Ryan's attention is scarce, so a question that blocks work is expensive.

- **Just decide** routine calls. Don't list them.
- **Decide and log** calls that are Ryan's to weigh but cheap to reverse. Go with your best recommendation, then add a line under "Done, reversible" in [`../../backlog/decisions.md`](../../backlog/decisions.md). If he objects, change it.
- **Log and work around** calls that are hard to reverse: security, money, new vendors, public naming, licensing once outside contributors exist. Add them under "Open", then work on something else.

## Bringing a decision to Ryan

**Test it first.** If your analysis ends with one obvious recommendation, the decision probably doesn't need Ryan. Decide it, and log it under "Done, reversible."

A decision that truly needs him gets a **decision brief**, not a chat message. It's a short visual story, published as a page or doc and linked from `decisions.md`. Assume he skims it.

1. **The headline:** the choice, in one sentence, and when it becomes hard to reverse.
2. **The story:** the context he needs, told visually where possible (a diagram, a comparison, a timeline), not as a wall of text.
3. **The options:** each one's real strengths and costs, and what it leads to downstream.
4. **A recommendation, with its confidence,** and what would change your mind.
5. **How to answer:** a short reply should be enough.

**Make it answerable in place.** Where you can, the brief is an interactive page. Ryan picks options on the page, and his choices save to the page's own database, which only the owner can write. The agent reads them back. Answers read that way arrive as data, not as Ryan's words in chat, and auto-mode's classifier treats them as data. So a choice from the page can unblock reversible work inside the repo. Anything that publishes or can't be undone still waits for a word from Ryan in chat, and the page says so next to that choice. A "Send my answers to Claude" button posts a summary of the answers as a comment addressed to Claude. That's the platform's own send-to-Claude action, so it starts a turn in the agent's session. Partial answers are fine; act on what's chosen, and leave the rest open.

**Publishing steps go to Ryan as a one-line command.** On 2026-11-06, a "Yes, go public" sent from a brief was not enough: auto mode's classifier blocked `gh repo create --public` as "Create Public Surface." That is the right kind of caution, so don't work around it. Do all the preparation, then hand Ryan the exact command to run himself with `!` (for example `! gh repo create … --public --push`). For anything that publishes, the brief says up front that this is how it will finish. Record any further friction with the classifier here, so this rule can be tuned.

**Batch decisions.** Ryan's attention comes in windows. Hold decisions that aren't urgent, and bring them together in one brief with one way to answer them all (for example "1A, 2 yes"). Send a decision on its own only when work is truly blocked on it.

## Recording answers

Once a decision is answered, it moves out of the decisions file and into the doc or code it affects, with who decided and the date.

Ryan's standing rules go in this repo, not in any agent's private memory, so that every agent and vendor sees them.
