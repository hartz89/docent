# Docent

**A guided tour for reviewing AI-written pull requests.**

Agents now write more code than anyone can read line by line. Docent helps a human reviewer spend limited attention well:

- **The tour.** An independent agent walks you through the change in the order it works, citing exact lines. It explains; it never approves. Skipped files stay visible, each with its reason.
- **Live answers.** When you ask "why does this retry three times?", the PR author's own agent session answers, in a read-only fork, while the code is still in front of you. The guide flags any answer that contradicts the code.
- **One batch back.** Suggestions and change requests collect into one revision, which goes back to the authoring agent in a single round.

It runs locally, on your own agent subscription. There's no hosted service, and no API bill.

> **Status: early development.** Nothing is usable yet. The design is in [`docs/brief.md`](docs/brief.md), and the plan is in [`backlog/index.md`](backlog/index.md).

## The run log

Each time you run `docent review`, Docent keeps a short diary of that run on your machine. It's there so that you, or an agent helping you, can look back at what happened without retracing it from memory.

**What's in it:** the PR and its head commit, the model and the flags you used, how the tour went (cache hit or miss, each attempt and why it was sent back, cost and time), each question with its answer, who answered it and why, the review you posted, and any errors from the server or the page. From the page it notes only which stop you're on, a rough window width and your theme. Never your keystrokes or mouse.

**What's never in it:** the launch token, GitHub tokens, API keys, or your environment. Long text is cut short.

**Where it lives:** one file per run in Docent's data folder, under `runs/`. On macOS that's `~/Library/Application Support/docent/runs`; on Linux, `~/.local/share/docent/runs`; set `DOCENT_DATA_DIR` to move it. The files are readable only by you, and they never leave your machine. Runs older than 30 days are removed, and at most 200 are kept.

**Reading it:** `docent runs` lists recent runs (in this repo, `pnpm docent runs`). `docent runs show latest` (or a run's id) prints a summary, and `--json` gives the raw events.

**Turning it off:** pass `--no-run-log`, or set `DOCENT_RUN_LOG=off` to turn it off for good. You can also delete the folder any time.

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
