import { defineConfig } from 'vitest/config';

// Unit and integration tests. End-to-end tests live in e2e/ and run under Playwright.
export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      { test: { name: 'core', root: 'packages/core', include: ['src/**/*.test.ts'] } },
      { test: { name: 'evals', root: 'packages/evals', include: ['src/**/*.test.ts'] } },
      { test: { name: 'server', root: 'apps/server', include: ['src/**/*.test.ts'] } },
      { test: { name: 'scripts', root: 'scripts', include: ['*.test.ts'] } },
    ],
  },
});
