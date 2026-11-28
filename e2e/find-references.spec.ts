import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, launch, test } from './fixtures.ts';

// The recorded hono review: its head files are the symbol index. `MiddlewareHandler` is used in
// the changed cors middleware and in the unchanged powered-by one, and named in a comment in
// each, which isn't a use.
const fixture = fileURLToPath(new URL('fixtures/hono-4813', import.meta.url));
const CORS = 'src/middleware/cors/index.ts';
const POWERED_BY = 'src/middleware/powered-by/index.ts';

/** The token on a line of the open file whose text is exactly `text`. */
const token = (page: Page, line: number, text: string) =>
  page.locator(`[data-line="${line}"] .line-text span`, { hasText: text }).filter({
    hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
  });

/** Stop 1's code, past the PR's description a page shows while the tour is still written. */
async function showFirstStop(page: Page) {
  await expect(page.getByText(/^Stop 1 of/).filter({ visible: true })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByText(/^Stop 2 of/).filter({ visible: true })).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByText(/^Stop 1 of/).filter({ visible: true })).toBeVisible();
  await expect(page.locator('.code-range')).toBeVisible();
}

test('find references lists uses by file, changed files first, and opens each one', async ({
  page,
}) => {
  const docent = await launch('cli.js', ['review', '--fixture', fixture]);
  try {
    await page.goto(docent.url);
    await showFirstStop(page);
    const citation = await page.locator('.code-range').textContent();
    const panel = page.getByRole('dialog', { name: 'References to MiddlewareHandler' });
    const results = panel.locator('.refs-line');

    await test.step('⌘⇧-click a name: its uses, grouped by file, changed files first', async () => {
      await page.locator('[data-line="63"]').scrollIntoViewIfNeeded();
      await token(page, 63, 'MiddlewareHandler').click({ modifiers: ['ControlOrMeta', 'Shift'] });
      await expect(panel).toBeVisible();
      await expect(panel.locator('.refs-count')).toHaveText('4 in 2 files');
      const files = panel.locator('.refs-file');
      await expect(files.nth(0).locator('.refs-path')).toHaveText(CORS);
      await expect(files.nth(0).locator('.refs-tag')).toHaveText('changed');
      await expect(files.nth(1).locator('.refs-path')).toHaveText(POWERED_BY);
      await expect(files.nth(1).locator('.refs-tag')).toHaveCount(0);
      // Each with its line of context; the JSDoc mention on line 36 isn't a use.
      await expect(results).toHaveText([
        /^7\s*import type \{ MiddlewareHandler \} from/,
        /^63\s*export const cors =/,
        /^5\s*import type \{ MiddlewareHandler \} from/,
        /^30\s*export const poweredBy =/,
      ]);
      // Nothing opened yet, and the keyboard is in the list.
      await expect(page.locator('.code-range')).toHaveText(citation ?? '');
      await expect(results.first()).toBeFocused();
    });

    await test.step('↓ and Enter open a result; the list stays for the next one', async () => {
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await expect(page.locator('.code-path')).toHaveText(POWERED_BY);
      await expect(page.locator('.code-range')).toHaveText('line 5 · use of MiddlewareHandler');
      await expect(page.locator('.line.cited')).toHaveAttribute('data-line', '5');
      await expect(results.nth(2)).toHaveAttribute('aria-current', 'location');
      // ← and → stay in the list: they don't change the stop.
      await page.keyboard.press('ArrowRight');
      await expect(page.getByText(/^Stop 1 of/).filter({ visible: true })).toBeVisible();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await expect(page.locator('.code-range')).toHaveText('line 30 · use of MiddlewareHandler');
    });

    await test.step('back returns along the trail, then to the stop', async () => {
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await expect(page.locator('.code-range')).toHaveText('line 5 · use of MiddlewareHandler');
      await page.getByRole('button', { name: 'Back to stop 1' }).click();
      await expect(page.locator('.code-path')).toHaveText(CORS);
      await expect(page.locator('.code-range')).toHaveText(citation ?? '');
      await expect(panel).toBeVisible();
    });

    await test.step('Esc in the list closes it, and the code has the keyboard again', async () => {
      await results.first().focus();
      await page.keyboard.press('Escape');
      await expect(panel).toHaveCount(0);
      await expect(page.locator('.code-scroll')).toBeFocused();
      await expect(page.getByText(/^Stop 1 of/).filter({ visible: true })).toBeVisible();
    });

    await test.step('from the keyboard: select a name, then Shift+Enter', async () => {
      await token(page, 63, 'CORSOptions').dblclick();
      await page.keyboard.press('Shift+Enter');
      const options = page.getByRole('dialog', { name: 'References to CORSOptions' });
      await expect(options.locator('.refs-count')).toHaveText('3 in 1 file');
    });
  } finally {
    await docent.stop();
  }
});

test('while the index builds, and when it fails, the panel says so', async ({ page }) => {
  const docent = await launch('cli.js', ['review', '--fixture', fixture]);
  try {
    await page.goto(docent.url);
    await showFirstStop(page);
    await page.locator('[data-line="63"]').scrollIntoViewIfNeeded();
    const panel = page.getByRole('dialog', { name: 'References to CORSOptions' });

    await test.step('a slow first lookup says the index is being built', async () => {
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route('**/api/references?*', async (route) => {
        await held;
        await route.fulfill({
          status: 500,
          json: { error: "Docent couldn't index the repository." },
        });
      });
      await token(page, 63, 'CORSOptions').click({ modifiers: ['ControlOrMeta', 'Shift'] });
      await expect(panel.getByRole('status')).toHaveText(/builds an index of the repository/);
      release();
    });

    await test.step('a failed index is said plainly, with a way to try again', async () => {
      await expect(panel.getByRole('alert')).toContainText("Docent couldn't index the repository.");
      await page.unroute('**/api/references?*');
      await panel.getByRole('button', { name: 'Try again' }).click();
      await expect(panel.locator('.refs-count')).toHaveText('3 in 1 file');
    });
  } finally {
    await docent.stop();
  }
});
