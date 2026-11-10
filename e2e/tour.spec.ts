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
      // The tab names the PR, then Docent.
      await expect(page).toHaveTitle(/cors.* · Docent$/);
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
      const answerBox = await answers.first().boundingBox();
      const answerBottom = (answerBox?.y ?? 0) + (answerBox?.height ?? 0);
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

    await test.step('↓ reads through each citation, then moves to the next; ↑ comes back', async () => {
      // Instant scrolling, so each key press lands before the next check.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setViewportSize({ width: 1280, height: 520 });
      // The edge stop cites three ranges in the tests: two short ones, then a 57-line one.
      await page.locator('.stop-button').nth(4).click();
      const pressed = page.locator('.chip[aria-pressed="true"]');
      const code = page.locator('.code-scroll');
      const scrollTop = () => code.evaluate((el) => el.scrollTop);
      await expect(pressed).toContainText('87');

      // A press reads on until a citation's end is in view with some room, then moves to the
      // next citation. Short citations take a press or two.
      const pressUntil = async (key: string, label: string) => {
        for (let i = 0; i < 4 && !(await pressed.textContent())?.includes(label); i++) {
          await page.keyboard.press(key);
        }
        await expect(pressed).toContainText(label);
      };
      // Wait for the file to load and the citation to be brought into view.
      await expect(page.locator('.line[data-line="87"]')).toBeInViewport();
      await pressUntil('ArrowDown', '135');
      await pressUntil('ArrowDown', '364');

      // The long one doesn't fit: ↓ reads on through it, staying on the same citation.
      const start = await scrollTop();
      await page.keyboard.press('ArrowDown');
      await expect.poll(scrollTop).toBeGreaterThan(start);
      await expect(pressed).toContainText('364');

      // ↑ scrolls back to its start, then returns to the previous citation.
      // ↑ reads back to the long citation's first line before leaving it.
      const firstLineShown = () =>
        code.evaluate((box) => {
          const line = box.querySelector('[data-line="364"]');
          if (!line) return false;
          const view = box.getBoundingClientRect();
          const rect = line.getBoundingClientRect();
          return rect.top >= view.top && rect.bottom <= view.bottom;
        });
      for (let i = 0; i < 6 && !(await firstLineShown()); i++) {
        await page.keyboard.press('ArrowUp');
      }
      await expect(pressed).toContainText('364');
      expect(await firstLineShown()).toBe(true);
      await pressUntil('ArrowUp', '135');
    });
  } finally {
    await docent.stop();
  }
});
