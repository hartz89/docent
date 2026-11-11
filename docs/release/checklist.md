# Releasing Docent

The maintainer's steps for putting Docent on npm. Agents prepare everything up to publishing, and never publish, log in to npm, or create npm orgs.

**What's already in place:**
- `pnpm pack:cli` builds the one package users install. It bundles the server and the built web app, pins the whole dependency tree with a shrinkwrap, and leaves the tarball in `dist/`.
- `node scripts/pack-smoke.ts dist/<file>.tgz` installs that tarball into an empty folder, outside the repo, and replays a recorded review through it.
- `pnpm verify` checks that every dependency is pinned to an exact version and permissively licensed, or listed as an exception with its reason (`scripts/check-deps.ts`).
- [`release.yml`](release.yml) is the publishing workflow, ready to copy.

## Once, before the first release

1. **Decide the npm scope.** It's the open question in [`backlog/decisions.md`](../../backlog/decisions.md), "npm scope for publishing". Create that org or user scope on npmjs.com yourself.
2. **Set the scope in code.** It lives in one place: `NPM_SCOPE` at the top of [`scripts/pack.ts`](../../scripts/pack.ts). Then replace the placeholder `@docent/docent` in `README.md` and in this file (`grep -rn "@docent/docent" README.md docs/release`). The workspace's own `@docent/core`, `@docent/server` and `@docent/web` names are internal and can stay.
3. **Turn on private vulnerability reporting,** so the link in `SECURITY.md` works: the repo's Settings → Code security → "Private vulnerability reporting". Or run `gh api -X PUT repos/hartz89/docent/private-vulnerability-reporting`.
4. **Add the workflow.** Copy [`release.yml`](release.yml) to `.github/workflows/release.yml` and land it through a PR. The builder can't push workflows, so this one is yours.
5. **Create the `npm-release` environment** on GitHub (Settings → Environments). Add yourself as a required reviewer, and limit it to tags matching `v*`. Every publish then waits for your click.
6. **Set up trusted publishing on npmjs.com.** In the package's settings, under "Trusted publisher", choose GitHub Actions and enter: owner `hartz89`, repository `docent`, workflow `release.yml`, environment `npm-release`. No npm token is stored anywhere.

   npm may not let you add a trusted publisher until the package exists. If so, do the first publish from the same workflow with a granular access token that can publish only this package: add it as the `NODE_AUTH_TOKEN` secret on the `npm-release` environment, and add `env: { NODE_AUTH_TOKEN: ${{ secrets.NODE_AUTH_TOKEN }} }` to the publish step. Provenance still works, since it comes from the workflow's OIDC token. Then set up the trusted publisher, delete the token on npmjs.com and the secret on GitHub, and remove the `env` line.
7. **Lock publishing down** once trusted publishing works: in the package's settings on npmjs.com, choose "Require two-factor authentication and disallow tokens".

## Each release

1. **Bump the version** in `apps/server/package.json` (for example `0.1.0`) and land it through a PR. The workflow refuses a tag that doesn't match it.
2. **Try the package locally,** from an up-to-date checkout of `main`:

   ```bash
   pnpm install && pnpm pack:cli
   node scripts/pack-smoke.ts dist/*.tgz
   ```

   It prints the tarball's size, and the dependency count and disk size of a fresh install.
3. **Tag and push:**

   ```bash
   git tag v0.1.0 origin/main
   git push origin v0.1.0
   ```

4. **Approve the run** in the repo's Actions tab, when the `npm-release` environment asks.
5. **Check the provenance:**
   - The package page on npmjs.com shows a "Provenance" section linking to the exact commit and workflow run.
   - `npm view @docent/docent@0.1.0 dist.attestations` prints the attestation.
   - In a scratch folder: `npm init -y && npm install @docent/docent@0.1.0 && npm audit signatures`. It should report verified registry signatures and attestations.
6. **Try it the way a user would:** `npx @docent/docent@0.1.0 review <a PR url>`.

## If something goes wrong

- **The workflow failed before publishing:** fix it through a PR, delete the tag (`git push origin :v0.1.0`), and tag again.
- **A bad version is published:** run `npm deprecate @docent/docent@0.1.0 "<why>"` and publish a fixed version. npm only allows unpublishing within 72 hours, and never reuses a version number.
