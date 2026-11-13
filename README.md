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

## The run log

Each time you run `docent review`, Docent keeps a short diary of that run on your machine. It's there so that you, or an agent helping you, can look back at what happened without retracing it from memory.

**What's in it:** the PR and its head commit, the model and the flags you used, how the tour went (cache hit or miss, each attempt and why it was sent back, cost and time), each question with its answer, who answered it and why, the review you posted, and any errors from the server or the page. From the page it notes only which stop you're on, a rough window width and your theme. Never your keystrokes or mouse.

**What's never in it:** the launch token, GitHub tokens, API keys, or your environment. Long text is cut short.

**Where it lives:** one file per run in Docent's data folder, under `runs/`. On macOS that's `~/Library/Application Support/docent/runs`; on Linux, `~/.local/share/docent/runs`; set `DOCENT_DATA_DIR` to move it. The files are readable only by you, and they never leave your machine. Runs older than 30 days are removed, and at most 200 are kept.

**Reading it:** `docent runs` lists recent runs (in this repo, `pnpm docent runs`). `docent runs show latest` (or a run's id) prints a summary, and `--json` gives the raw events.

**Turning it off:** pass `--no-run-log`, or set `DOCENT_RUN_LOG=off` to turn it off for good. You can also delete the folder any time.

**Your questions are kept too.** Each answered question, with who answered, why, what it cost and the guide's note, is saved per PR under `questions/` in the same data folder. Reload the page or reopen the PR and they're still there; ones asked at an older commit say so. The files are readable only by you, secrets are scrubbed first, each PR keeps its newest 200 questions, and files untouched for 90 days are removed. A replayed `--fixture` keeps them for that launch only.

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
pnpm pack:cli    # build the npm package into dist/ (releasing: docs/release/checklist.md)
```

Most of the code here is written by AI agents. They work within a deliberately designed harness: [`AGENTS.md`](AGENTS.md) and [`docs/process/`](docs/process/).

## License

[Apache-2.0](LICENSE)
