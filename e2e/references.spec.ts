import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, launch, test } from './fixtures.ts';

// The recorded hono#4813 review. Its references were added to the recording by
// hand (the tour was recorded before references existed): "the resolver returns `origin ||
// null`" names lines 80–82, and "`origin` defaults to `'*'`" names line 65.
const fixture = fileURLToPath(new URL('fixtures/hono-4813', import.meta.url));

const FILE = 'src/middleware/cors/index.ts';
const TEST_FILE = 'src/middleware/cors/index.test.ts';
const line = (page: Page, n: number) => page.locator(`.line[data-line="${n}"]`);

async function thirdStop(page: Page, url: string) {
  await page.goto(url);
  await expect(page.locator('.narration-title')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.narration-title')).toHaveText(/Wildcard plus credentials/);
}

test('a phrase in the prose shows its lines on hover and keyboard focus', async ({ page }) => {
  const docent = await launch('cli.js', ['review', '--fixture', fixture]);
  try {
    await thirdStop(page, docent.url);
    const resolver = page.getByRole('button', { name: /the resolver returns origin \|\| null/ });
    const defaults = page.getByRole('button', { name: /origin defaults to/ });

    await test.step('hovering marks the named lines, and leaving lets go', async () => {
      await resolver.hover();
      await expect(line(page, 80)).toHaveClass(/named/);
      await expect(line(page, 82)).toHaveClass(/named/);
      await expect(line(page, 83)).not.toHaveClass(/named/);
      await expect(page.locator('.code-range')).toHaveText('lines 80–82 · named in the text');
      await page.locator('.narration-title').hover();
      await expect(page.locator('.line.named')).toHaveCount(0);
      // Back to the stop's own citation.
      await expect(page.locator('.code-range')).toHaveText(/cited by this stop/);
    });

    await test.step('keyboard focus scrolls lines out of view into it, until focus moves on', async () => {
      // A short window, so line 65 starts out of view of the code pane.
      await page.setViewportSize({ width: 1280, height: 420 });
      await expect(line(page, 65)).not.toBeInViewport();
      await defaults.focus();
      await expect(line(page, 65)).toHaveClass(/named/);
      await expect(line(page, 65)).toBeInViewport();
      await defaults.blur();
      await expect(page.locator('.line.named')).toHaveCount(0);
    });

    await test.step('Enter opens the lines, with the way back to the stop', async () => {
      await resolver.focus();
      await page.keyboard.press('Enter');
      await resolver.blur();
      await expect(line(page, 80)).toHaveClass(/cited/);
      await page.getByRole('button', { name: 'Back to stop 3' }).click();
      await expect(page.locator('.code-range')).toHaveText(/cited by this stop/);
    });
  } finally {
    await docent.stop();
  }
});

test('a phrase naming another file shows that file while hovered, then gives the stop back', async ({
  page,
}) => {
  const docent = await launch('cli.js', ['review', '--fixture', fixture]);
  try {
    await page.goto(docent.url);
    await expect(page.locator('.narration-title')).toBeVisible();
    // The map stop cites index.ts; its "`index.test.ts`" names lines 87–93 of the tests. It opens
    // on the code map, so its citation is opened first.
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.map-title')).toBeVisible();
    await page.getByRole('button', { name: /^index\.ts 104/ }).click();
    await expect(page.locator('.code-path')).toHaveAttribute('title', FILE);
    await page.getByRole('button', { name: /^index\.test\.ts/ }).hover();
    await expect(page.locator('.code-path')).toHaveAttribute('title', TEST_FILE);
    await expect(line(page, 87)).toHaveClass(/named/);
    await expect(line(page, 87)).toBeInViewport();
    await page.locator('.narration-title').hover();
    await expect(page.locator('.code-path')).toHaveAttribute('title', FILE);
    await expect(page.locator('.line.named')).toHaveCount(0);
  } finally {
    await docent.stop();
  }
});

test('on a phone, tapping a phrase scrolls down to its lines', async ({ browser }) => {
  const docent = await launch('cli.js', ['review', '--fixture', fixture]);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  try {
    await page.goto(docent.url);
    await expect(page.locator('.narration-title')).toBeVisible();
    // The phone's bottom bar moves between stops.
    const next = page.getByRole('button', { name: /next stop/i }).filter({ visible: true });
    await next.first().tap();
    await next.first().tap();
    await expect(page.locator('.narration-title')).toHaveText(/Wildcard plus credentials/);
    // The guide comes first; its code is below, out of view.
    await expect(line(page, 80)).not.toBeInViewport();

    await page.getByRole('button', { name: /the resolver returns origin \|\| null/ }).tap();
    await expect(line(page, 80)).toBeInViewport();
    await expect(line(page, 80)).toHaveClass(/cited/);
    await expect(page.locator('.code-range')).toHaveText('lines 80–82 · named in the text');
  } finally {
    await context.close();
    await docent.stop();
  }
});
