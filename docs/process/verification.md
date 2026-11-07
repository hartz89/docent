# Verification

The testing trophy, from the bottom up. Each layer catches what the one below it can't. Sources and status: [`../north-stars.md`](../north-stars.md).

1. **Static:** strict TypeScript and Biome. Encode rules as types and lint rules wherever possible; a rule an agent has to remember is weaker than one the build enforces.
2. **Unit:** only for pure logic with real edge cases. Prefer property-based tests (fast-check) for invariants. Examples: "every changed line has exactly one home in the tour", "an anchor follows its code or is flagged out of date."
3. **Integration (the main layer):** test through public interfaces, as a user or caller would. Server tests use `app.request()`, with no port and no mocks of our own code. Mock only at the outermost boundary, such as GitHub or the model.
4. **E2E:** a few high-value user flows in Playwright. Use random ports, so parallel worktrees don't collide.
5. **Evals:** two kinds.
   - **Product evals:** every Docent agent behavior (tour, skip decision, danger flag, answer check, scrubber) scores quality and cost together on fixed PRs.
   - **Harness evals:** changes to how agents work _on_ this repo (AGENTS.md, skills, hooks, rules) run against a benchmark of repo tasks before they merge. See [`harness-evals.md`](harness-evals.md).

## Rules

- **Check before you code.** For any change in behavior, write the failing test first, or say what will prove the change works.
- **A bug fix ships with a test of that exact regression.**
- **Tests must be deterministic.** Seed randomness and fix the clock. Quarantine a flaky test as soon as you see it; never just re-run it.
- **Prefer a mechanical check to a rule in prose.** When a mistake could recur, add a lint rule, type, hook or test. Use agent judgment only where a script can't do the job well enough.
- **Keep failure output short and specific.** Agents read it.
- **Tests from the same agent can share the code's misunderstanding.** For behavior that matters, the acceptance checks come from a fresh context: a separate agent, or the spec.
