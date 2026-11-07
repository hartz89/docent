# Agent identities

**Any actor that isn't the maintainer is an agent.** Agents act on GitHub through their own GitHub Apps, one per role, never through the maintainer's login. That makes agent work attributable. It also lets GitHub's own rules enforce separation of duties: the maintainer can approve an agent's PR, which GitHub forbids for your own PR.

| Role       | App does                                          | Permissions on hartz89/docent                                                         |
| ---------- | ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `builder`  | Pushes branches, authors commits, opens and merges PRs | Contents: write. Pull requests: write. Workflows: write. Checks: read. Metadata: read. |
| `reviewer` | Posts reviews (the future AI reviewer)            | Pull requests: write. Contents: read. Metadata: read.                                 |

## How tiers become mechanical

Two files turn the tiers in [`pull-requests.md`](pull-requests.md) into GitHub rules:

- [`.github/CODEOWNERS`](../../.github/CODEOWNERS) lists the tier-2 paths, owned by the maintainer.
- [`.github/rulesets/main.json`](../../.github/rulesets/main.json) protects `main`: every change goes through a PR, CI's `check` job must pass, and code-owner review is required. No other approvals are required.

So a PR that touches no tier-2 path merges on green CI. A PR that touches one waits for the maintainer's approval. Bot approvals are never relied on, because they don't reliably count toward required approvals. The repository admin role can bypass the ruleset, so the maintainer is never locked out.

## Using it

Wrap the GitHub-facing command in `scripts/as-agent.ts`:

```bash
node scripts/as-agent.ts builder -- git push -u origin <branch>
node scripts/as-agent.ts builder -- gh pr create --body-file <path>
node scripts/as-agent.ts builder -- gh pr merge <number> --squash
node scripts/as-agent.ts reviewer -- gh pr review <number> --comment --body-file <path>
```

From the app's slug, it finds the app and its installation on this repo, then mints a one-hour installation token. It runs the command with `GH_TOKEN` and the bot's git author and committer set. Git gets the token through `GIT_CONFIG_*` env vars, so it never shows in argv, a remote URL or `.git/config`. The token and key are never printed.

**Only a short list of commands can run this way.** Each role has an allowlist in the runner: the builder can push a non-`main` branch without force, use most `gh pr` commands, squash-merge without `--admin`, and make read-only `gh api` calls; the reviewer can read PRs, review, comment, and make read-only `gh api` calls. Anything else is refused before a token exists. `scripts/` is code-owned, so widening the list needs the maintainer's approval. That's why a single `Bash(node scripts/as-agent.ts:*)` permission rule is safe.

**Until the apps exist,** the script stops with a message saying so. Run the command without it, which uses the maintainer's `gh` login, and say so in the PR's known gaps.

## One-time setup (maintainer)

For each role (`builder`, then `reviewer`):

1. **Create the app** at https://github.com/settings/apps/new. Name it, for example, `docent-builder`. Turn off the webhook. Give it exactly the permissions in the table above. Allow installation on "Only on this account".
2. **Install it** from the app's page, on `hartz89/docent` only.
3. **Generate a private key** on the app's page, and store it in the Keychain base64-encoded (the Keychain garbles multi-line values). Then delete the downloaded file:

   ```bash
   security add-generic-password -U -a docent -s docent-builder-app-key -w "$(base64 -i ~/Downloads/docent-builder.*.private-key.pem)"
   rm ~/Downloads/docent-builder.*.private-key.pem
   ```

   In CI, put the same base64 value (or the raw PEM) in `DOCENT_BUILDER_APP_KEY`.
4. **Fill in** [`.github/agent-apps.json`](../../.github/agent-apps.json): the app's slug (the name in its URL), and copy the App ID from the app's settings page, for example `{ "slug": "docent-builder", "appId": 123456 }`. Land that through a PR. The script finds the installation id itself. It can look up the app id from the slug too, but only for public apps; GitHub hides private ones, like these, from that lookup.
5. **Check it:** `node scripts/as-agent.ts builder -- gh api /installation/repositories --jq '.repositories[].full_name'` prints `hartz89/docent`.

Then apply the ruleset once, from the repo root:

```bash
gh api -X POST /repos/hartz89/docent/rulesets --input .github/rulesets/main.json
```

To change it later, edit the JSON through a PR and apply it with `gh api -X PUT /repos/hartz89/docent/rulesets/<id> --input .github/rulesets/main.json` (`gh api /repos/hartz89/docent/rulesets` lists the id).
