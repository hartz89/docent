# Security

Docent runs on your own machine, with your own logins. This page says what it touches, what it never does, and how to tell the maintainer about a problem.

## The short version

- Docent reads a pull request and shows it to you. It never runs the PR's code.
- The agents it starts can only read files. They can't edit files, run commands or reach other tools.
- It posts to GitHub only when you press submit, and then as you.
- Its local server answers only your browser tab, through a secret token made fresh at each launch.

## What Docent reads

- **The pull request,** through your `gh` login: its title, description, author, diff and commit messages.
- **The PR's code.** Docent fetches the base and head commits into a cache folder (`~/Library/Caches/docent` on macOS, `~/.cache/docent` elsewhere, or `DOCENT_CACHE_DIR`). Finished tours are cached there too.
- **Your Claude Code transcripts** in `~/.claude/projects`, only to find the PR author's session so it can answer your questions. A public `Claude-Session:` link in a PR is never enough on its own: the transcript itself has to show work on that PR's branch, in that repo.

Everything it reads from the PR is treated as data, never as instructions. That includes code, comments and the PR description, which can all carry text written to steer an AI.

## What Docent never does

- **It never runs the PR's code.** No install, no build, no tests. The checkout is made with git hooks, submodules, LFS downloads and local-file transports turned off. Symlinks check out as plain text files, so nothing in the checkout points outside it. Your own git config isn't loaded for these commands either.
- **Its agents never write.** The guide and every answer to your questions run as Claude Code sessions with only the Read, Grep and Glob tools. Anything that would need permission is refused without asking. The checkout's own `.claude/` settings, hooks, MCP servers and CLAUDE.md are never loaded.
- **Questions never change the author's session.** A question forks the author's session read-only. The original transcript isn't touched, and the fork isn't saved.

## What Docent posts, and as whom

Only one thing: your review, when you submit it from the app. It goes to that PR, at the commit you reviewed, through your own `gh` login, so GitHub shows it as yours. Docent never approves or comments on its own.

Questions and tours cost model usage on your Claude plan. Docent shows the cost of each one.

## The local server

- It listens on `127.0.0.1` only, on a random free port.
- Every API request needs a random token, made fresh each time Docent starts. The token travels in the link's `#fragment`, which browsers never send to servers.
- It refuses requests whose `Host` or `Origin` isn't its own. That stops other websites, and tricks like DNS rebinding, from driving it.

Treat the printed link like a password while Docent is running. Anyone who has it can use your review session.

## Supply chain

The npm package pins its whole dependency tree with a shrinkwrap, and releases are published from GitHub Actions with npm provenance, so you can check where a version was built.

## Reporting a problem

Please report security issues privately, through GitHub's **Report a vulnerability** button on the [Security tab](https://github.com/hartz89/docent/security). Please don't open a public issue for them. The maintainer will reply as soon as they can. Docent is a spare-time project, so expect days rather than hours.
