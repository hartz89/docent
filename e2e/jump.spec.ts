import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, launch, test } from './fixtures.ts';

// The recorded hono review: its head files are the symbol index.
const fixture = fileURLToPath(new URL('fixtures/hono-4813', import.meta.url));

/** The token on a line of the open file whose text is exactly `text`. */
const token = (page: Page, line: number, text: string) =>
  page.locator(`[data-line="${line}"] .line-text span`, { hasText: text }).filter({
    hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
  });

test('⌘-click follows a name to its definition, and the reviewer returns to the stop', async ({
  page,
}) => {
  const docent = await launch('cli.js', ['review', '--fixture', fixture]);
  try {
    await page.goto(docent.url);
    await expect(page.getByText(/^Stop 1 of/)).toBeVisible();
    const citation = await page.locator('.code-range').textContent();

    await test.step('a plain click leaves the stop alone', async () => {
      await page.locator('[data-line="63"]').scrollIntoViewIfNeeded();
      await token(page, 63, 'CORSOptions').click();
      await expect(page.locator('.code-range')).toHaveText(citation ?? '');
    });

    await test.step('⌘-click on a name with one definition opens it', async () => {
      await token(page, 63, 'CORSOptions').click({ modifiers: ['ControlOrMeta'] });
      await expect(page.locator('.code-range')).toHaveText('line 9 · definition of CORSOptions');
      await expect(page.locator('.line.cited')).toHaveAttribute('data-line', '9');
      await expect(page.locator('[data-line="9"]')).toBeInViewport();
    });

    await test.step('"Back to stop 1" returns to the stop and its citation', async () => {
      await page.getByRole('button', { name: 'Back to stop 1' }).click();
      await expect(page.locator('.code-range')).toHaveText(citation ?? '');
      await expect(page.getByRole('button', { name: /Back to stop/ })).toHaveCount(0);
    });

    await test.step('Alt+← with nothing behind it stays in the review', async () => {
      const at = page.url();
      await page.keyboard.press('Alt+ArrowLeft');
      await expect(page.getByText(/^Stop 1 of/)).toBeVisible();
      expect(page.url()).toBe(at);
    });

    await test.step('Esc during a slow lookup drops it: nothing opens later', async () => {
      await page.route('**/api/definition?*', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        await route.continue();
      });
      const answered = page.waitForResponse('**/api/definition?*');
      await token(page, 63, 'CORSOptions').click({ modifiers: ['ControlOrMeta'] });
      await page.keyboard.press('Escape');
      await answered;
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
      await expect(page.locator('.code-range')).toHaveText(citation ?? '');
      await page.unroute('**/api/definition?*');
    });

    await test.step('from the keyboard: select a name, then Enter', async () => {
      await page.locator('[data-line="63"]').scrollIntoViewIfNeeded();
      await token(page, 63, 'CORSOptions').dblclick();
      await page.keyboard.press('Enter');
      await expect(page.locator('.code-range')).toHaveText('line 9 · definition of CORSOptions');
    });
  } finally {
    await docent.stop();
  }
});

test('an ambiguous name lists its candidates; imports, history and Esc', async ({ page }) => {
  const docent = await launch('cli.js', ['review', '--fixture', fixture]);
  try {
    await page.goto(docent.url);
    await expect(page.getByText(/^Stop 1 of/)).toBeVisible();
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
    await expect(page.getByText(/^Stop 5 of/)).toBeVisible();
    await expect(page.locator('.code-path')).toHaveText('src/middleware/cors/index.test.ts');
    await page.locator('[data-line="2"]').scrollIntoViewIfNeeded();

    const popover = page.getByRole('dialog', { name: 'Definitions of cors' });
    await test.step('the popover lists every candidate, in the order the server ranks them', async () => {
      await token(page, 2, 'cors')
        .first()
        .click({ modifiers: ['ControlOrMeta'] });
      await expect(popover).toBeVisible();
      const candidates = popover.getByRole('button');
      await expect(candidates).toHaveCount(2);
      await expect(candidates.nth(0)).toContainText('src/middleware/cors/index.ts:63');
      await expect(candidates.nth(0)).toContainText('export const cors =');
      await expect(candidates.nth(1)).toContainText('src/middleware/cors/index.ts:104');
      // Nothing opened yet: the reviewer picks.
      await expect(page.locator('.code-path')).toHaveText('src/middleware/cors/index.test.ts');
    });

    await test.step('Esc closes the popover and stays on the stop', async () => {
      await page.keyboard.press('Escape');
      await expect(popover).toHaveCount(0);
      await expect(page.getByText(/^Stop 5 of/)).toBeVisible();
    });

    await test.step('picking a candidate with the keyboard opens it', async () => {
      await token(page, 2, 'cors')
        .first()
        .click({ modifiers: ['ControlOrMeta'] });
      await expect(popover.getByRole('button').first()).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await expect(page.locator('.code-range')).toHaveText('line 104 · definition of cors');
    });

    await test.step('back and forward move through the explored files', async () => {
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await expect(page.locator('.code-path')).toHaveText('src/middleware/cors/index.test.ts');
      await expect(page.locator('.code-range')).toHaveText(/cited by this stop/);
      await page.keyboard.press('Alt+ArrowRight');
      await expect(page.locator('.code-range')).toHaveText('line 104 · definition of cors');
    });

    await test.step('an import specifier opens the file it names', async () => {
      await page.keyboard.press('Alt+ArrowLeft');
      await page.locator('[data-line="2"]').scrollIntoViewIfNeeded();
      await token(page, 2, '../../middleware/cors')
        .first()
        .click({ modifiers: ['ControlOrMeta'] });
      await expect(page.locator('.code-path')).toHaveText('src/middleware/cors/index.ts');
      await expect(page.locator('.code-range')).toHaveText("imported as '../../middleware/cors'");
    });

    await test.step('Esc always returns to the tour', async () => {
      await page.keyboard.press('Escape');
      await expect(page.locator('.code-path')).toHaveText('src/middleware/cors/index.test.ts');
      await expect(page.getByRole('button', { name: /Back to stop/ })).toHaveCount(0);
      await expect(page.getByText(/^Stop 5 of/)).toBeVisible();
    });
  } finally {
    await docent.stop();
  }
});

test('at phone width, the code header still fits after a jump', async ({ page }) => {
  const docent = await launch('cli.js', ['review', '--fixture', fixture]);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(docent.url);
    await page.locator('[data-line="63"]').scrollIntoViewIfNeeded();
    await token(page, 63, 'CORSOptions').click({ modifiers: ['ControlOrMeta'] });
    await expect(page.locator('.code-range')).toHaveText('line 9 · definition of CORSOptions');
    const header = page.locator('.code-header');
    const spill = await header.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(spill).toBeLessThanOrEqual(0);
    await expect(page.getByRole('button', { name: 'Back to stop 1' })).toBeInViewport({
      ratio: 1,
    });
  } finally {
    await docent.stop();
  }
});
