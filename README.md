# Docent

**A guided tour for reviewing AI-written pull requests.**

Agents now write more code than anyone can read line by line. Docent helps a human reviewer spend limited attention well:

- **The tour.** An independent agent walks you through the change in the order it works, citing exact lines. It explains; it never approves. Skipped files stay visible, each with its reason.
- **Live answers.** When you ask "why does this retry three times?", the PR author's own agent session answers, in a read-only fork, while the code is still in front of you. The guide flags any answer that contradicts the code.
- **One batch back.** Suggestions and change requests collect into one revision, which goes back to the authoring agent in a single round.

It runs locally, on your own agent subscription. There's no hosted service, and no API bill.

> **Status: early development, and not on npm yet.** Until the first release, run it from a checkout (see [Developing](#developing)) with `pnpm docent review <url>`. The design is in [`docs/brief.md`](docs/brief.md), and the plan is in [`backlog/index.md`](backlog/index.md).

## Using Docent

### What you need

- **Node 24** or newer.
- **Claude Code, signed in with your Claude subscription.** Docent's agents run through that login.
- **The GitHub CLI, signed in** (`gh auth login`), and git. Docent reads the PR and posts your review through it.

### Your first review

```bash
npx @<scope>/docent review https://github.com/owner/repo/pull/123
```

Docent fetches the PR, writes the tour, and opens it in your browser. Press Ctrl-C in the terminal when you're done. Run `npx @<scope>/docent --help` for the options. (`<scope>` is a placeholder until the first release picks the npm scope.)

The first run installs about 350 MB, mostly the Claude Code runtime that comes with Anthropic's Agent SDK. npm keeps it cached after that.

To ask questions of the PR author's own agent session, that session needs to be on your machine. Docent finds it from the `Claude-Session:` link in the PR, or you can name it with `--session <id>`. Without it, the guide answers instead.

### What it costs

There's no account and no hosted service. Tours and answers use your Claude plan, like any other Claude Code session. Docent shows what each one would cost at API list prices, so you can see what it used:

- **A tour** of a small PR has come to about $0.06 to $0.13 on Opus. Tours are cached per commit, so opening the same PR again is free.
- **A question to the author's session** costs more on a long session, because the fork re-reads its whole history. Docent hands any question estimated over $2 to the guide instead. Change that with `--fork-budget`.

If `ANTHROPIC_API_KEY` is set in your shell, Claude Code bills that key instead of your plan.

### Security

Docent never runs the PR's code, its agents can only read, and it posts only the review you submit, as you. The details, and how to report a problem, are in [SECURITY.md](SECURITY.md).

## Developing

You need Node 24 and pnpm 10.

```bash
pnpm install
pnpm verify      # typecheck, lint, and tests: under a second
pnpm test:e2e    # Playwright against the real server
pnpm dev         # run the app locally
pnpm pack:cli    # build the npm package into dist/ (releasing: docs/release/checklist.md)
```

Most of the code here is written by AI agents. They work within a deliberately designed harness: [`AGENTS.md`](AGENTS.md) and [`docs/process/`](docs/process/).

## License

[Apache-2.0](LICENSE)
