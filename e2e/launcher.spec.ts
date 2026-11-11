import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, launch, test } from './fixtures.ts';

// The launcher replaying a recorded review: no GitHub or model calls. A free port stands in for
// the fixed one, so parallel runs don't collide.
const fixture = fileURLToPath(new URL('fixtures/hono-4813', import.meta.url));
const prUrl = 'https://github.com/honojs/hono/pull/4813';

test('a link opens a confirm page, and one click lands on the tour', async ({ page }) => {
  const home = await mkdtemp(join(tmpdir(), 'docent-launcher-'));
  const config = join(home, 'config.json');
  await writeFile(config, JSON.stringify({ allowedRepos: ['honojs/hono'] }));
  const launcher = await launch('cli.js', ['serve', '--fixture', fixture, '--port', '0'], {
    DOCENT_CONFIG: config,
    DOCENT_CACHE_DIR: join(home, 'cache'),
  });
  try {
    await test.step('the link shows a confirm page naming the PR and its cost', async () => {
      await page.goto(`${launcher.url}/open?pr=${encodeURIComponent(prUrl)}`);
      await expect(page.getByRole('heading', { name: 'Open this review?' })).toBeVisible();
      await expect(page.getByText('fix(cors): reflect request origin')).toBeVisible();
      await expect(page.getByText('About $1 to write.')).toBeVisible();
      await expect(page.locator('.author')).toHaveText('app/');
    });

    await test.step('confirming opens the tour on its own review server', async () => {
      // The button arms only once the reviewer's pointer has been on this page for a moment.
      const start = page.getByRole('button', { name: 'Start the review' });
      await expect(start).toBeDisabled();
      await start.hover();
      await expect(start).toBeEnabled();
      await start.click();
      await expect(page.getByRole('heading', { level: 1 })).toContainText('cors');
      await expect(page.getByText(/Stop 1 of \d+/)).toBeVisible();
      // The token came in the fragment, and the app has taken it out of the address bar.
      expect(new URL(page.url()).origin).not.toBe(launcher.url);
      expect(page.url()).not.toContain('token');
    });
  } finally {
    await launcher.stop();
    await rm(home, { recursive: true, force: true });
  }
});
