import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, launch, test } from './fixtures.ts';

const fixture = fileURLToPath(new URL('fixtures/hono-4813', import.meta.url));

// Each width the tour screen has to work at, and the least room its code pane may get there:
// enough for the gutter and about 60 characters with the route in a column, a little less once
// the route is a drawer, and the whole width on a phone.
const widths = [
  { width: 1440, height: 900, codeMin: 530, drawer: false },
  { width: 1100, height: 800, codeMin: 480, drawer: true },
  { width: 900, height: 800, codeMin: 480, drawer: true },
  { width: 390, height: 844, codeMin: 380, drawer: true },
];

/** "Stop N of M", wherever this width shows it: the top bar, or the phone's bottom bar. */
const progress = (page: Page) =>
  page
    .getByText(/^Stop \d+ of \d+/)
    .filter({ visible: true })
    .first();

/** The whole element is inside the window, left to right, once any slide-in has settled. */
async function inViewWidth(page: Page, selector: string) {
  const width = page.viewportSize()?.width ?? 0;
  await expect
    .poll(async () => {
      const box = await page.locator(selector).boundingBox();
      return box !== null && box.x >= 0 && box.x + box.width <= width + 0.5;
    }, `${selector} is fully inside the window`)
    .toBe(true);
}

for (const { width, height, codeMin, drawer } of widths) {
  test(`the tour screen fits a ${width}px window`, async ({ page }) => {
    const docent = await launch('cli.js', ['review', '--fixture', fixture]);
    try {
      await page.setViewportSize({ width, height });
      await page.goto(docent.url);
      await expect(page.locator('.narration-title')).toBeVisible();
      // The third stop cites src/middleware/cors/index.ts.
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await expect(progress(page)).toHaveText(/Stop 3 of 6/);
      await expect(page.locator('.line.cited').first()).toBeAttached();

      await test.step('nothing scrolls the page sideways', async () => {
        const overflow = await page
          .locator('html')
          .evaluate((html) => html.scrollWidth - html.clientWidth);
        expect(overflow).toBeLessThanOrEqual(0);
      });

      await test.step('the code pane keeps its room, and its path stays on one line', async () => {
        const code = await page.getByRole('region', { name: 'Code' }).boundingBox();
        expect(code?.width ?? 0).toBeGreaterThanOrEqual(codeMin);
        const path = page.locator('.code-path');
        await expect(path).toHaveAttribute('title', 'src/middleware/cors/index.ts');
        // One line of 12.5px text is about 19px tall; the bug stacked it a letter per line.
        expect((await path.boundingBox())?.height ?? 0).toBeLessThan(28);
      });

      await test.step('the guide and the top bar buttons are fully in the window', async () => {
        await inViewWidth(page, 'aside[aria-label="The guide"]');
        await inViewWidth(page, '.verdict-button');
        await inViewWidth(page, '.topbar [aria-label^="Theme:"]');
        await expect(page.locator('.verdict-button')).toHaveAccessibleName(/Verdict at the end/);
      });

      if (!drawer) {
        await test.step('the route has its own column, and no drawer button', async () => {
          await expect(page.getByRole('navigation', { name: 'The route' })).toBeVisible();
          await expect(
            page.getByRole('button', { name: 'Open the route', exact: true }),
          ).toHaveCount(0);
        });
        return;
      }

      // A phone opens the route from its bottom bar; wider windows from the top bar's button,
      // or by clicking the progress.
      const routeButton =
        width < 800
          ? page.getByRole('navigation', { name: 'Stops' }).getByRole('button', { name: 'Route' })
          : page.getByRole('button', { name: 'Open the route', exact: true });
      const route = page.getByRole('dialog', { name: 'The route' });

      await test.step('the route opens as a drawer, focused on the current stop', async () => {
        await expect(page.getByRole('navigation', { name: 'The route' })).toBeHidden();
        const opener =
          width < 800
            ? routeButton
            : page.getByRole('button', { name: 'Stop 3 of 6. Open the route.' });
        await opener.click();
        await expect(route).toBeVisible();
        await expect(route.locator('.stop-button[aria-current="step"]')).toBeFocused();
        await inViewWidth(page, 'dialog.route-drawer');

        // ← → belong to the drawer while it's open.
        await page.keyboard.press('ArrowRight');
        await expect(progress(page)).toHaveText(/Stop 3 of 6/);

        await page.keyboard.press('Escape');
        await expect(route).toBeHidden();
        await expect(opener).toBeFocused();
      });

      await test.step('a click outside closes it', async () => {
        await routeButton.click();
        await expect(route).toBeVisible();
        await page.mouse.click(width - 10, height / 2);
        await expect(route).toBeHidden();
      });

      await test.step('picking a stop goes there and closes the drawer', async () => {
        await routeButton.click();
        await route.locator('.stop-button').nth(4).click();
        await expect(route).toBeHidden();
        await expect(progress(page)).toHaveText(/Stop 5 of 6/);
      });

      await test.step('← and → still move between stops', async () => {
        await page.keyboard.press('ArrowLeft');
        await expect(progress(page)).toHaveText(/Stop 4 of 6/);
        await page.keyboard.press('ArrowRight');
        await expect(progress(page)).toHaveText(/Stop 5 of 6/);
      });

      if (width < 800) {
        await test.step('the bottom bar moves between stops, and reaches the verdict', async () => {
          const bar = page.getByRole('navigation', { name: 'Stops' });
          await bar.getByRole('button', { name: 'Next stop' }).click();
          await expect(bar).toContainText('Stop 6 of 6');
          await expect(bar.getByRole('button', { name: 'Next stop' })).toBeDisabled();
          const review = page.getByRole('region', { name: 'Your review' });
          await review.getByRole('radio', { name: /Comment/ }).check();
          await review.getByLabel(/Summary/).fill('Read it on a phone.');
          await expect(review.getByRole('button', { name: /Comment on GitHub/ })).toBeVisible();
          await bar.getByRole('button', { name: 'Previous stop' }).click();
          await expect(bar).toContainText('Stop 5 of 6');
        });
      }
    } finally {
      await docent.stop();
    }
  });
}
