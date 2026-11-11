# Agent identities

**Any actor that isn't the maintainer is an agent.** Agents act on GitHub through their own GitHub Apps, one per role, never through the maintainer's login.

## What this does, and what it doesn't

**`as-agent` gives attribution and separation of duties, for agents that are well-behaved but fallible.** Agent work shows up as the app's bot, not as the maintainer. The builder and the reviewer are separate identities, so the reviewer can approve the builder's PR. The runner also stops honest mistakes, like a force push or an admin merge.

**It does not contain a misbehaving agent.** An agent runs as the same macOS user as the runner. So it can read the app key from the Keychain, or edit the runner itself.

**Real enforcement is on GitHub's side.** Three things hold even if an agent gets the raw token:
- **the app's permissions**, which limit what any token can do;
- **the ruleset**, which makes `main` move only through PRs with green CI and one approving review.

Our own agents are trusted, so there are no code owners: no path waits for the maintainer. The app permissions are the ceiling, and only the maintainer can change them.

**Containment is an open decision for the maintainer.** It needs OS-level separation: a separate macOS user or sandbox that holds the keys and runs the runner. It also needs the maintainer's own admin `gh` login out of agents' reach. The ruleset lets admins bypass it, so today that login is a master key for any agent that can run `gh`.

| Role       | App does                                          | Permissions on hartz89/docent                                                         |
| ---------- | ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `builder`  | Pushes branches, opens and merges PRs  | Contents: write. Pull requests: write. Checks: read. Metadata: read. |
| `reviewer` | Posts reviews (the future AI reviewer) | Pull requests: write. Contents: read. Metadata: read.                |

The builder has no Workflows permission on purpose, so GitHub rejects a builder push that touches `.github/workflows/`. A workflow change goes to the maintainer to push.

## How tiers become mechanical

One file turns the merge rule in [`pull-requests.md`](pull-requests.md) into a GitHub rule. [`.github/rulesets/main.json`](../../.github/rulesets/main.json) protects `main`: every change goes through a PR, CI's `check` job must pass, and one approving review is required. A new push dismisses an earlier approval. The `reviewer` app gives the approval once its review finds no blockers.

Tiers set how deep that review goes; they don't add approvers. The JSON is the repo's record of the live ruleset. Editing it changes nothing until the maintainer applies it (see the end of this page).

**Agents queue, GitHub merges.** After the review is posted, an agent queues every PR with `gh pr merge <number> --squash --auto`. GitHub lands it the moment those rules are met. This needs the repo's "Allow auto-merge" setting on (`gh repo edit hartz89/docent --enable-auto-merge`). The repository admin role can bypass the ruleset, so the maintainer is never locked out.

## Using it

Wrap the GitHub-facing command in `scripts/as-agent.ts`:

```bash
node scripts/as-agent.ts builder -- git push -u origin <branch>
node scripts/as-agent.ts builder -- gh pr create --body-file <path>
node scripts/as-agent.ts builder -- gh pr merge <number> --squash --auto
node scripts/as-agent.ts reviewer -- gh pr review <number> --comment --body-file <path>
```

It finds the app's installation on this repo and mints a token scoped to that role's permissions. It runs the command with the token and the bot's git identity. It revokes the token when the command ends, or on Ctrl-C, kill or hangup. A `kill -9` can't be caught, so then the token lives until it expires, within the hour.

These guards keep honest mistakes from leaking the token:
- **Fixed tools.** `gh` and `git` are found in fixed folders, never the caller's `PATH`. They must be root-owned all the way up and not group- or world-writable, so Homebrew's `gh` (under the user-owned `/opt/homebrew`) is refused. The child's `PATH` is `/usr/bin:/bin`.
- **A from-scratch env.** Only `HOME`, `LANG`, `TERM` and `TMPDIR` pass from the caller, so no key, `GIT_TRACE` or `EDITOR` gets through.
- **Locked-down git.**
  - Hooks, global and system config, submodule pushes and non-HTTPS transports are off.
  - Repo and worktree git config may only set known-harmless keys: `core.*` (minus keys that run programs), `gc.*`, `pull.*`, `remote.origin.url`/`fetch`, `branch.*`, `user.*` and `extensions.worktreeConfig`. Anything else, like a proxy, URL rewrite or include, is refused.
- **The token stays out of sight.** Git gets it only through `GIT_CONFIG_*` env vars, never argv, a remote URL or `.git/config`. Everything the command prints passes through a scrubber.
- **No reshaped output.** `gh --jq`/`--template` could print the token in a form the scrubber can't catch, so they're refused. So are `--web`/`--editor`.

**Only a short list of commands can run this way.** Each role has an allowlist in the runner.
- The builder can push a plain branch name (not `main`) without force, use most `gh pr` commands, squash-merge (`--squash`, optionally `--auto`, nothing else, so never `--admin`), and make read-only `gh api` calls.
- The reviewer can read PRs, review, comment, and make read-only `gh api` calls.

Anything else is refused before a token exists. Widening the list is tier 2b: it needs a security-focused review before the approval. Whatever the list allows, the app's permissions above still cap it. Agents are only *forced* through the runner once settings also deny plain `gh` and `git push`, which comes after the apps work.

**Known gaps:**
- **A race.** The repo config is checked just before the command runs, so an agent could change it in between.
- **Untrusted repos.** An agent could point the command at a freshly made bare repo. Both are left for the containment decision above.

**Until the apps exist,** the script stops with a message saying so. Run the command without it, which uses the maintainer's `gh` login, and say so in the PR's known gaps.

## One-time setup (maintainer)

First, **install `gh` somewhere root-owned.** The Homebrew copy is refused, because `/opt/homebrew` belongs to your user. The official macOS `.pkg` from https://cli.github.com installs to `/usr/local/bin`. Check with `stat -f '%Su %Sp' /usr/local /usr/local/bin /usr/local/bin/gh`: each should say `root`, with no `w` for group or others. `git` from the Xcode command line tools, in `/usr/bin`, already qualifies.

Then, for each role (`builder`, then `reviewer`):

1. **Create the app** at https://github.com/settings/apps/new. Name it, for example, `docent-builder`. Turn off the webhook. Give it exactly the permissions in the table above. Allow installation on "Only on this account".
2. **Install it** from the app's page, on `hartz89/docent` only.
3. **Generate a private key** on the app's page, and store it in the Keychain base64-encoded (the Keychain garbles multi-line values). Then delete the downloaded file:

   ```bash
   security add-generic-password -U -a docent -s docent-builder-app-key -w "$(base64 -i ~/Downloads/docent-builder.*.private-key.pem)"
   rm ~/Downloads/docent-builder.*.private-key.pem
   ```

   Don't store app keys as repository secrets. If CI ever needs an app, its key goes in a GitHub environment limited to `main`. That's a later decision. The runner already reads `DOCENT_<ROLE>_APP_KEY` for that case.
4. **Fill in** [`.github/agent-apps.json`](../../.github/agent-apps.json): the app's slug (the name in its URL), and copy the App ID from the app's settings page, for example `{ "slug": "docent-builder", "appId": 123456 }`. Land that through a PR. The script finds the installation id itself. It can look up the app id from the slug too, but only for public apps; GitHub hides private ones, like these, from that lookup.
5. **Check it:** `node scripts/as-agent.ts builder -- gh api /installation/repositories` lists only `hartz89/docent`.

Then apply the ruleset once, from the repo root:

```bash
gh api -X POST /repos/hartz89/docent/rulesets --input .github/rulesets/main.json
```

To change it later, edit the JSON through a PR and apply it with `gh api -X PUT /repos/hartz89/docent/rulesets/<id> --input .github/rulesets/main.json` (`gh api /repos/hartz89/docent/rulesets` lists the id).
