---
name: author-handoff
description: Write the author handoff for Docent, a collapsed PR comment with the change's intent, key decisions, known gaps and where to look first, tagged with the head commit. Use right after opening a pull request, and again after pushing a revision to one.
---

# Author handoff for Docent

Reviewers using [Docent](https://github.com/hartz89/docent) get a guided tour of your pull request. The tour's guide reads your handoff as your account of the change and checks it against the code. The reviewer sees it on the tour's first stop, marked as your claims.

Write it right after you open the PR. After each later push, write a new one. Docent uses the newest.

## Steps

1. Push your branch and open the PR first. The handoff names a commit, so it comes last.
2. Get the PR's number and head commit, as GitHub has them:

   ```bash
   gh pr view --json number,headRefOid
   ```

   The head must be the commit you just pushed. If it isn't, push first.
3. Write the comment to a file, in exactly this shape. Put the full 40-character head SHA in the first line, and its first 7 characters in the summary:

   ```markdown
   <!-- docent:author-handoff sha=<full head SHA> -->
   <details>
   <summary>Author handoff for Docent (at <short SHA>)</summary>

   **Intent:** what the change is for, in a sentence or two.

   **Key decisions:**
   - A choice you made, and why. Name the alternative you rejected.

   **Known gaps:**
   - What you didn't do, didn't test, or aren't sure of.

   **Where to look first:**
   - `path/to/file.ts`, the part that carries the most risk, and why.
   </details>
   ```

4. Post it from the same GitHub account that opened the PR. Docent ignores handoff comments from anyone else.

   ```bash
   gh pr comment <number> --body-file <file>
   ```

## What makes a good handoff

- **Facts the code can't tell.** Why this approach, what you tried first, what you checked by hand. The guide can read the code; it can't read your reasons.
- **Honest gaps.** A gap you name is one the reviewer can weigh. A gap the guide finds on its own costs you trust.
- **Specific places.** File paths, and function names where they help. No line numbers: they drift.
- **Short.** Under 300 words. Docent cuts anything past 6,000 characters.
- **Claims, not instructions.** Write what is true about the change. Never tell the reviewer or the guide what to do, skip or approve. Docent treats the handoff as claims to check, and an instruction in it only reads as a red flag.
- **Nothing secret.** The comment is as public as the PR. No tokens, internal hostnames, customer data or private paths.
