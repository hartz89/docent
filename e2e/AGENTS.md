# e2e

Playwright tests against the real built server. Keep them few and high-value: whole user flows, not edge cases. Integration tests cover the edge cases.

- **A worker fixture (`fixtures.ts`) starts `node apps/server/dist/main.js` on a free port** and reads the URL it prints. Don't switch to Playwright's `webServer`, which needs a fixed port and so breaks when several worktrees run tests at once.
- Fixtures need `async ({}, use)`, which Biome flags. Keep the `biome-ignore` comment.
- When a test fails, it should say which step broke. Use `test.step` for multi-step flows.
