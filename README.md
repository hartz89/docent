# Docent

**A guided tour for reviewing AI-written pull requests.**

Agents now write more code than anyone can read line by line. Docent helps a human reviewer spend limited attention well:

- **The tour.** An independent agent walks you through the change in the order it works, citing exact lines. It explains; it never approves. Skipped files stay visible, each with its reason.
- **Live answers.** When you ask "why does this retry three times?", the PR author's own agent session answers, in a read-only fork, while the code is still in front of you. The guide flags any answer that contradicts the code.
- **One batch back.** Suggestions and change requests collect into one revision, which goes back to the authoring agent in a single round.

It runs locally, on your own agent subscription. There's no hosted service, and no API bill.

> **Status: early development.** Nothing is usable yet. The design is in [`docs/brief.md`](docs/brief.md), and the plan is in [`backlog/index.md`](backlog/index.md).

## For authors using Claude Code

Docent's Claude Code plugin helps reviewers' questions reach the subagent that wrote your PR, and lets your agent leave a handoff note for the tour. In Claude Code:

```
/plugin install docent --marketplace hartz89/docent
```

What it records, and where: [`packages/claude-code`](packages/claude-code/README.md).

## Developing

You need Node 24 and pnpm 10.

```bash
pnpm install
pnpm verify      # typecheck, lint, and tests: under a second
pnpm test:e2e    # Playwright against the real server
pnpm dev         # run the app locally
```

Most of the code here is written by AI agents. They work within a deliberately designed harness: [`AGENTS.md`](AGENTS.md) and [`docs/process/`](docs/process/).

## License

[Apache-2.0](LICENSE)
