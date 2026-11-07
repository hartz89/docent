# Decisions

Calls that are the maintainer's, batched so they don't block work. The rules are in AGENTS.md, under "Decisions". Once a decision is answered, it moves out of this file and into the doc or code it affects.

## Open

- **npm scope for publishing.** Settle before the first npm release. "Docent" is the name (decided below), but the unscoped npm name is taken, so the package ships scoped (`@<scope>/docent`) with a `docent` command. Background: "Docent" is the working name. Two similar projects already use it ([vivecuervo7/docent](https://github.com/vivecuervo7/docent), [thomas783/pr-docent](https://github.com/thomas783/pr-docent)), and the unscoped `docent` package on npm is taken by an unrelated placeholder. This becomes hard to reverse at the first public release. Until then, packages use the `@docent/*` scope privately.

## Done, reversible

- **2026-11-06 · License: Apache-2.0.** It includes an explicit patent grant, and its contribution terms (section 5) suit a project that wants community-built vendor adapters. The maintainer's other repos use MIT, which would also have been fine. This is easy to change until the first outside contribution lands; after that it needs contributors' consent.
- **2026-11-06 · Eval fixtures from private repos stay out of this public repo.** They describe private code. The plan: a private fixtures repo of manifests (repo, SHAs, expected findings), fetched at run time, plus a committed public core set built from open-source PRs. See [`../docs/research/2026-11-06-eval-fixtures.md`](../docs/research/2026-11-06-eval-fixtures.md).

## Decided by the maintainer

- **2026-11-06 · Stack:** Hono server, Vite + React + TanStack Router/Query web app, TypeScript 7, pnpm. Chosen on agentic legibility, performance and product fit; familiarity didn't count.
- **2026-11-06 · Open source from day one.**
- **2026-11-06 · Name: keep "Docent."** Chosen in decision brief no. 1, option A. The metaphor carries the product's idea; the npm package will be scoped.
