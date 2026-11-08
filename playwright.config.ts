import { defineConfig, devices } from '@playwright/test';

// The server is started per worker by the `docent` fixture (e2e/fixtures.ts) on a
// free port, so there is no `webServer` block and no fixed port. Run via
// `pnpm test:e2e`, which builds first.
export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.ts',
  testIgnore: 'fixtures/**',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'line',
  use: { trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
