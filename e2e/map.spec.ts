import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, launch, test } from './fixtures.ts';

// A small shop: `applyDiscount`, `totalOf`, `Discount` and the welcome promo change, and the
// checkout, cart, receipt and order code use them. Stop 2 is the map.
const fixture = fileURLToPath(new URL('fixtures/map-demo', import.meta.url));

/** Opens the map stop once the tour is checked, so the finished tour doesn't move the page. */
async function openMapStop(page: Page) {
  await expect(page.getByText(/^Stop 1 of/).filter({ visible: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Go to verdict' })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByText(/^Stop 2 of/).filter({ visible: true })).toBeVisible();
}

const side = (page: Page, name: 'Changed' | 'Used by') =>
  page.getByRole('list', { name, exact: true });

test('the map stop shows what changed and what uses it, and a node opens its code', async ({
  page,
}) => {
  const docent = await launch('cli.js', ['review', '--fixture', fixture]);
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(docent.url);
    await openMapStop(page);

    await test.step('the map takes the code column, grouped by file', async () => {
      await expect(page.locator('.map-title')).toHaveText('Code map');
      const changed = side(page, 'Changed');
      await expect(changed.locator('.map-group-head')).toHaveText([
        'src/pricing.test.ts',
        'src/pricing.ts',
        'src/promo.ts',
        'src/types.ts',
      ]);
      await expect(changed.locator('.map-name')).toHaveText([
        'tenOff',
        'applyDiscount',
        'totalOf',
        'WELCOME',
        'Discount',
      ]);
      // Resolved through imports: the legacy applyDiscount and its caller aren't on the map.
      const callers = side(page, 'Used by');
      await expect(callers.locator('.map-name')).toContainText([
        'Cart',
        'formatReceipt',
        'createOrder',
        'checkout',
        'previewTotal',
      ]);
      await expect(callers).not.toContainText('v1Price');
      await expect(page.locator('.map-footer')).toContainText('Also changed: docs/pricing.md');
      await expect(page.getByRole('button', { name: 'Code map' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });

    await test.step('pointing at a node lights its links and fades the rest', async () => {
      await callersNode(page, 'createOrder').hover();
      await expect(page.locator('.map-link.lit')).toHaveCount(2);
      await expect(changedNode(page, 'applyDiscount')).not.toHaveClass(/dim/);
      await expect(changedNode(page, 'WELCOME')).not.toHaveClass(/dim/);
      await expect(changedNode(page, 'totalOf')).toHaveClass(/dim/);
    });

    await test.step('clicking a node opens its definition, and back returns to the map', async () => {
      await callersNode(page, 'createOrder').click();
      await expect(page.locator('.code-path')).toHaveText('src/api/orders.ts');
      await expect(page.locator('.code-range')).toHaveText('line 4 · definition of createOrder');
      await expect(page.locator('.line.cited')).toHaveAttribute('data-line', '4');
      await page.getByRole('button', { name: 'Back to stop 2' }).click();
      await expect(page.locator('.map-title')).toBeVisible();
    });

    await test.step("the stop's citation shows code, and the Code map chip brings the map back", async () => {
      await page.getByRole('button', { name: 'pricing.ts 7–14' }).click();
      await expect(page.locator('.code-range')).toHaveText('lines 7–14 · cited by this stop');
      await page.getByRole('button', { name: 'Code map' }).click();
      await expect(page.locator('.map-title')).toBeVisible();
    });
  } finally {
    await docent.stop();
  }
});

test('on a phone, the map is one column with who uses each row under it', async ({ page }) => {
  const docent = await launch('cli.js', ['review', '--fixture', fixture]);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(docent.url);
    await openMapStop(page);
    await expect(page.locator('.map-title')).toBeVisible();
    await expect(side(page, 'Used by')).toBeHidden();
    const row = changedNode(page, 'WELCOME').locator('..');
    await expect(row.locator('.map-used-by')).toHaveText('used by createOrder');
    // Nothing on the map runs past the screen's edge.
    const overflow = await page
      .locator('.map-scroll')
      .evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  } finally {
    await docent.stop();
  }
});

const changedNode = (page: Page, name: string) =>
  side(page, 'Changed').locator('.map-node', { has: page.locator('.map-name', { hasText: name }) });

const callersNode = (page: Page, name: string) =>
  side(page, 'Used by').locator('.map-node', {
    has: page.getByText(name, { exact: true }),
  });
