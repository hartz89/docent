import { fileURLToPath } from 'node:url';
import { expect, launch, test } from './fixtures.ts';

// The recorded hono review, with its tree at head and one file the PR didn't touch.
const fixture = fileURLToPath(new URL('fixtures/hono-4813', import.meta.url));
const unchanged = 'src/middleware/powered-by/index.ts';

test('the reviewer browses to a file the PR did not touch, then returns to the same stop', async ({
  page,
}) => {
  const docent = await launch('cli.js', ['review', '--fixture', fixture]);
  try {
    await page.goto(docent.url);
    await expect(page.getByText(/^Stop 1 of/)).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByText(/^Stop 2 of/)).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByText(/^Stop 3 of/)).toBeVisible();
    const title = await page.locator('.narration-title').textContent();
    const citation = await page.locator('.code-range').textContent();
    expect(citation).toMatch(/cited by this stop/);

    await test.step('Files shows the repo at head, with changed files marked', async () => {
      await page.getByRole('tab', { name: /Files/ }).click();
      const changed = page.locator('.tree-node.changed', { hasText: 'index.test.ts' });
      await expect(changed).toBeVisible();
      await expect(changed.locator('.tree-stat')).toHaveText(/^\+\d+/);
    });

    await test.step('an unchanged file opens read-only, with no diff colouring', async () => {
      await page.getByPlaceholder('Go to file').fill('powered-by/index');
      await page.getByRole('button', { name: unchanged, exact: true }).click();
      await expect(page.locator('.code-path')).toHaveText(unchanged);
      await expect(page.locator('.code-range')).toHaveText(/not changed by this PR/);
      await expect(page.locator('.line').first()).toBeVisible();
      await expect(page.locator('.line.added, .line.removed, .line.cited')).toHaveCount(0);
    });

    await test.step('⌘P jumps to Go to file, and Enter opens the best match', async () => {
      await page.getByRole('button', { name: /Back to stop 3/ }).focus();
      await page.keyboard.press('ControlOrMeta+p');
      await expect(page.getByPlaceholder('Go to file')).toBeFocused();
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.type('cors index.ts');
      await page.keyboard.press('Enter');
      // Changed files rank first: the PR's own cors/index.ts, not its test.
      await expect(page.locator('.code-path')).toHaveText('src/middleware/cors/index.ts');
      await expect(page.locator('.code-range')).toHaveText('changed in this PR');
    });

    await test.step('"Back to stop 3" returns to the stop and its citation', async () => {
      await page.getByRole('button', { name: /Back to stop 3/ }).click();
      await expect(page.locator('.narration-title')).toHaveText(title ?? '');
      await expect(page.locator('.code-range')).toHaveText(citation ?? '');
      await expect(page.locator('.line.cited').first()).toBeVisible();
    });

    await test.step('← and → still move between stops while a file is open', async () => {
      await page.getByPlaceholder('Go to file').fill('powered-by/index');
      await page.getByRole('button', { name: unchanged, exact: true }).click();
      await page.keyboard.press('ArrowLeft');
      await expect(page.getByText(/^Stop 2 of/)).toBeVisible();
      await expect(page.getByRole('button', { name: /Back to stop/ })).toHaveCount(0);
    });
  } finally {
    await docent.stop();
  }
});
