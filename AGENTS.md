# Docent

Docent helps people review AI-written pull requests. An independent agent gives a guided tour of the change. The reviewer asks questions, and the author's own agent session answers them. Change requests go back to the author agent as one batch. It runs locally on the reviewer's own agent subscription. Full picture: [`docs/brief.md`](docs/brief.md).

This file loads in every session, so it holds only what every task needs. Everything else is one link away. Read a linked doc when your task touches its topic.

## Commands

```bash
pnpm verify      # typecheck + lint + unit/integration tests. The one "am I done?" check.
pnpm test:e2e    # Playwright against the real server. Run when behavior a user sees changes.
pnpm dev         # server + web app on free ports; prints the URL with its token
pnpm fix         # apply lint and format fixes
pnpm check:context  # proves agent instructions load (real session, costs ~cents)
```

Use `pnpm exec <bin>`, not `npx`.

## Map

```
packages/core   The engine. Plain TypeScript, no framework imports (lint enforces this).
apps/server     Hono on Node: a thin, locked-down shell around core.
apps/web        Vite + React + TanStack Router/Query, using Hono's typed client.
e2e/            A few Playwright flows against the real built server.
docs/process/   How we work: verification, pull requests, decisions, harness evals.
docs/research/  Spikes and prior art, dated.
backlog/        What's next (index.md) and decisions waiting on Ryan (decisions.md).
```

## How Ryan works

Ryan sets outcomes, high-level architecture, and the environment agents work in. Then he watches how the system behaves, and steps in with judgment where it could be better. He can't follow low-level details at the speed this project moves, but he cares a lot about architectural health. So the environment has to protect it.

**Nothing here is under glass, this file included.** Governance exists to make agents' work more autonomous, more trustworthy and better. When evidence shows a rule isn't earning its place, or a missing rule would help, propose the change, with the evidence: metrics, eval results, a repeated mistake. Changes to governance are tier 2 like any other harness change.

- **Judge on agentic legibility, performance, and product outcomes.** Familiarity with a tool counts for little.
- **Weigh alternatives honestly.** Give rejected options their real strengths, and correct your own overstatements.
- **Lean on proven practitioners, without treating any of them as gospel.** Record what we adopt in [`docs/north-stars.md`](docs/north-stars.md).
- **Settle open questions by experiment, not debate.**
- **The UX bar is high.** People won't use tools that feel cheap, glitchy or hasty.
- **Human attention is the scarcest resource.** Spend it only where agents and scripts fall short.
- **In chat, every PR, issue, CI run or artifact you mention is a clickable link.** For example, write `[PR #1](https://github.com/hartz89/docent/pull/1)`, never a bare "PR #1".

## Rules that always apply

- **Decide, don't block.** Ask forgiveness unless security, quality or long-term goals are at stake. A decision that truly needs Ryan gets a visual decision brief, never just a chat message. → [`docs/process/decisions.md`](docs/process/decisions.md)
- **Verify before you report done.** Check before code; mechanical checks over prose rules; deterministic tests. → [`docs/process/verification.md`](docs/process/verification.md)
- **PRs carry a risk tier, and a description worth reading.** → [`docs/process/pull-requests.md`](docs/process/pull-requests.md)
- **Harness changes are tier 2 and must pass the harness evals.** "Harness" means this file, `CLAUDE.md`, `.claude/`, skills, hooks and `docs/process/`. → [`docs/process/harness-evals.md`](docs/process/harness-evals.md)
- **Keep resident context small.** Put detail in linked docs, skills, or a package's own `AGENTS.md`, not here. Every folder with an `AGENTS.md` also has a `CLAUDE.md` that contains only `@AGENTS.md`. This guarantees Claude Code loads it, without relying on its newer native support, and `pnpm verify` checks it. Elsewhere, use plain links, not `@` imports, because imports load eagerly. → [`docs/research/2026-11-06-context-loading.md`](docs/research/2026-11-06-context-loading.md)
- **Work in a git worktree, and land through GitHub.** Never touch the main checkout. Branch from `origin/main`, push your branch, and open a PR. `main` moves only by merging PRs. Use random ports, and stop the processes you started by PID; never kill by port or name. → [`docs/process/worktrees.md`](docs/process/worktrees.md)
- **Stop and report when spiraling:** the same fix has failed twice, or three approaches have made no progress.
