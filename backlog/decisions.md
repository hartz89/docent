# Decisions

Calls that are the maintainer's, batched so they don't block work. The rules are in AGENTS.md, under "Decisions". Once a decision is answered, it moves out of this file and into the doc or code it affects.

## Open

- **npm scope for publishing.** Settle before the first npm release. "Docent" is the name (decided below), but the unscoped npm name is taken, so the package ships scoped (`@<scope>/docent`) with a `docent` command. Background: "Docent" is the working name. Two similar projects already use it ([vivecuervo7/docent](https://github.com/vivecuervo7/docent), [thomas783/pr-docent](https://github.com/thomas783/pr-docent)), and the unscoped `docent` package on npm is taken by an unrelated placeholder. This becomes hard to reverse at the first public release. Until then, packages use the `@docent/*` scope privately.

## Done, reversible

- **2026-11-07 · Agent containment: attribution for now (option A).** Agents act through the builder and reviewer GitHub Apps, and the `main` ruleset has no bypass for anyone. Agents still run as the maintainer's macOS user, so the apps record who acted but can't stop a misbehaving agent; GitHub's ruleset is the real boundary. Revisit when sessions move to the cloud, where agents only ever hold an app token. Rejected for now: a separate macOS user (B), cloud or container sessions (C).
- **2026-11-07 · Tier 2 split into 2a (contracts and dependencies that don't touch security: agents merge after a clean fresh-context review) and 2b (security, permissions, CI, the harness and the rules themselves: the maintainer).** Following the maintainer's direction to merge autonomously within the gates. Undo by merging 2a back into 2b in pull-requests.md.
- **2026-11-06 · License: Apache-2.0.** It includes an explicit patent grant, and its contribution terms (section 5) suit a project that wants community-built vendor adapters. The maintainer's other repos use MIT, which would also have been fine. This is easy to change until the first outside contribution lands; after that it needs contributors' consent.
- **2026-11-06 · Eval fixtures from private repos stay out of this public repo.** They describe private code. The plan: a private fixtures repo of manifests (repo, SHAs, expected findings), fetched at run time, plus a committed public core set built from open-source PRs. See [`../docs/research/2026-11-06-eval-fixtures.md`](../docs/research/2026-11-06-eval-fixtures.md).

- **2026-11-07 · The `docent` CLI lives in `apps/server` (`src/cli.ts`), not a new `apps/cli`.** It only parses arguments, wires the GitHub and model boundaries, and starts the server, which already owns startup. A separate package would add a workspace, a tsconfig and a dependency edge for about 100 lines. Split it out when it grows commands that don't start the server.
- **2026-11-07 · The tour's default model is `claude-opus-5-5`.** One real run on a 78-line PR cost $0.06 to $0.13. Override with `--model` or `DOCENT_MODEL`.
- **2026-11-07 · Tour cost comes from the result message's `usage`, priced with a list-price table in `apps/server/src/agent.ts`.** Assistant frames carry a start-of-stream usage snapshot (output tokens near zero), and `total_cost_usd` includes the parent session on resumes. The table needs updating when prices change.

## Decided by the maintainer

- **2026-11-06 · Stack:** Hono server, Vite + React + TanStack Router/Query web app, TypeScript 7, pnpm. Chosen on agentic legibility, performance and product fit; familiarity didn't count.
- **2026-11-06 · Open source from day one.**
- **2026-11-06 · Name: keep "Docent."** Chosen in decision brief no. 1, option A. The metaphor carries the product's idea; the npm package will be scoped.
- **2026-11-09 · The product has no risk tiers.** Docent never rates, labels or routes a PR by risk. How much review a PR needs is up to the org that owns it. Risk tiers stay in how *this repo* merges its own PRs (`scripts/tier.ts`, `docs/process/pull-requests.md`); that's dev environment, not product.
