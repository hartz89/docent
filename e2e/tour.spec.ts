import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, launch, test } from './fixtures.ts';

// A real review, recorded with `docent review <url> --record`: the PR, its diff, the files the
// tour read, and the guide's replies. Replaying it makes no GitHub or model calls.
const fixture = fileURLToPath(new URL('fixtures/hono-4813', import.meta.url));
const replies = JSON.parse(readFileSync(`${fixture}/replies.json`, 'utf8')) as {
  tour: { structured: { stops: { title: string }[] } }[];
};
// Titles render `code` spans, so compare them without the backticks.
const titles = (replies.tour.at(-1)?.structured.stops ?? []).map((s) =>
  s.title.replaceAll('`', ''),
);

test('the CLI opens a recorded PR, and the reviewer walks the tour by keyboard', async ({
  page,
}) => {
  const docent = await launch('cli.js', ['review', '--fixture', fixture]);
  try {
    await test.step('the tour loads for the PR', async () => {
      await page.goto(docent.url);
      await expect(page.getByRole('heading', { level: 1 })).toContainText('cors');
      await expect(page.getByText(`Stop 1 of ${titles.length}`)).toBeVisible();
      await expect(page.locator('.narration-title')).toHaveText(titles[0] ?? '');
    });

    await test.step('→ moves to the second stop', async () => {
      await page.keyboard.press('ArrowRight');
      await expect(page.getByText(`Stop 2 of ${titles.length}`)).toBeVisible();
      await expect(page.locator('.narration-title')).toHaveText(titles[1] ?? '');
    });

    await test.step('→ again reaches the third stop, with its cited lines in view', async () => {
      await page.keyboard.press('ArrowRight');
      await expect(page.locator('.narration-title')).toHaveText(titles[2] ?? '');
      await expect(page.locator('.line.cited').first()).toBeInViewport();
    });

    await test.step('← goes back, and the route marks only the first stop done', async () => {
      await page.keyboard.press('ArrowLeft');
      await expect(page.locator('.narration-title')).toHaveText(titles[1] ?? '');
      await expect(page.locator('.stop-button.done')).toHaveCount(1);
      await expect(page.locator('.stop-button[aria-current="step"]')).toContainText(
        titles[1] ?? '',
      );
    });
  } finally {
    await docent.stop();
  }
});
