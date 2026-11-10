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
      // The header names the focused citation ("lines 77–83 · cited by this stop"); its first
      // line is scrolled into view and marked as cited.
      const range = await page.locator('.code-range').textContent();
      const start = range?.match(/lines (\d+)/)?.[1] ?? '';
      const first = page.locator(`.line[data-line="${start}"]`);
      await expect(first).toHaveClass(/cited/);
      await expect(first).toBeInViewport();
    });

    await test.step('← goes back, and the route marks only the first stop done', async () => {
      await page.keyboard.press('ArrowLeft');
      await expect(page.locator('.narration-title')).toHaveText(titles[1] ?? '');
      await expect(page.locator('.stop-button.done')).toHaveCount(1);
      await expect(page.locator('.stop-button[aria-current="step"]')).toContainText(
        titles[1] ?? '',
      );
    });

    await test.step('Next stop opens at the top of the guide; going back returns to where it was left', async () => {
      // A short window, so the guide has room to scroll.
      await page.setViewportSize({ width: 1280, height: 420 });
      const guide = page.getByRole('complementary', { name: 'The guide' });
      const scrollTop = () => guide.evaluate((el) => el.scrollTop);
      await guide.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      const left = await scrollTop();
      expect(left).toBeGreaterThan(0);

      await page.getByRole('button', { name: /Next stop/ }).click();
      await expect(page.locator('.narration-title')).toHaveText(titles[2] ?? '');
      await expect.poll(scrollTop).toBe(0);

      await page.keyboard.press('ArrowLeft');
      await expect(page.locator('.narration-title')).toHaveText(titles[1] ?? '');
      await expect.poll(scrollTop).toBe(left);
    });

    await test.step('questions read like a chat: the box follows the latest answer, and the thread survives leaving the stop', async () => {
      await page.setViewportSize({ width: 1280, height: 900 });
      const guide = page.getByRole('complementary', { name: 'The guide' });
      const answers = guide.locator('.exchange-answer');

      await guide.getByLabel('Your question').fill('What happens with no Origin header?');
      await guide.getByRole('button', { name: 'Ask the guide' }).click();
      await expect(answers).toHaveCount(1);

      // The box now sits below the answer, ready for a follow-up.
      const followUp = guide.getByLabel('Ask a follow-up');
      const answerBottom = (await answers.first().boundingBox())?.y ?? 0;
      const boxTop = (await followUp.boundingBox())?.y ?? 0;
      expect(boxTop).toBeGreaterThan(answerBottom);

      await followUp.fill('And with credentials off?');
      await followUp.press('ControlOrMeta+Enter');
      await expect(answers).toHaveCount(2);

      await page.getByRole('button', { name: /Next stop/ }).click();
      await expect(guide.locator('.exchange')).toHaveCount(0);
      await page.keyboard.press('ArrowLeft');
      await expect(guide.locator('.exchange-question')).toHaveText([
        'What happens with no Origin header?',
        'And with credentials off?',
      ]);
    });
  } finally {
    await docent.stop();
  }
});
