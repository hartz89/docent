import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, launch, test } from './fixtures.ts';

// A real review, recorded with `docent review <url> --record`: the PR, its diff, the files the
// tour read, and the guide's replies. Replaying it makes no GitHub or model calls.
const fixture = fileURLToPath(new URL('fixtures/hono-4813', import.meta.url));
const pr = JSON.parse(readFileSync(`${fixture}/pr.json`, 'utf8')) as { url: string; head: string };
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

    await test.step('at the last stop, the reviewer approves, and the review is posted once', async () => {
      await page.locator('.stop-button').last().click();
      await expect(page.getByText(`Stop ${titles.length} of ${titles.length}`)).toBeVisible();
      const review = page.getByRole('region', { name: 'Your review' });

      await review.getByRole('radio', { name: /Approve/ }).check();
      await review.getByLabel(/Summary/).fill('Checked the credentials path.');
      // Enter in the summary adds a line; it never posts.
      await review.getByLabel(/Summary/).press('Enter');
      await expect(review).toContainText(
        `Approve honojs/hono#4813 at ${pr.head.slice(0, 7)} as you, with this summary:`,
      );
      await review.getByRole('button', { name: 'Approve on GitHub' }).click();

      await expect(review.getByRole('heading', { name: 'Approved on GitHub' })).toBeVisible();
      await expect(
        review.getByRole('link', { name: /View your review on GitHub/ }),
      ).toHaveAttribute('href', `${pr.url}#pullrequestreview-0`);
      // Locked: nothing left to send.
      await expect(review.getByRole('button')).toHaveCount(0);
      // Fixture mode recorded the review instead of sending it to GitHub.
      const recorded = docent.output.filter((line) => line.startsWith('Recorded a review'));
      expect(recorded).toEqual([
        `Recorded a review, not sent to GitHub: ${JSON.stringify({
          commitId: pr.head,
          event: 'APPROVE',
          body: 'Checked the credentials path.',
        })}`,
      ]);
    });
  } finally {
    await docent.stop();
  }
});

test('while the guide writes, the reviewer reads the PR, then the first stop before the tour is done', async ({
  page,
}) => {
  // The recorded tour streams out over about nine seconds, like a live guide writing it.
  const docent = await launch('cli.js', ['review', '--fixture', fixture, '--replay-pace', '80']);
  try {
    await test.step('the PR and honest progress show right away', async () => {
      await page.goto(docent.url);
      await expect(page.getByRole('heading', { level: 1 })).toContainText('cors');
      await expect(page.locator('.overview .description')).toContainText(
        'Access-Control-Allow-Origin',
      );
      await expect(page.getByRole('heading', { name: 'Preparing your tour' })).toBeVisible();
      await expect(page.locator('.upcoming-stop')).toContainText(
        /Planning the route|Writing stop 1/,
      );
    });

    await test.step('the first stop opens while later stops are still being written', async () => {
      await expect(page.locator('.narration-title')).toHaveText(titles[0] ?? '');
      await expect(page.getByText(/Stop 1 of \d+ so far/)).toBeVisible();
      await expect(page.locator('.upcoming-stop')).toBeVisible();
      await expect(
        page.getByText('Questions open once the whole tour is written and checked.'),
      ).toBeVisible();
    });

    await test.step('the finished tour replaces the progress, and questions open', async () => {
      await expect(page.getByText(`Stop 1 of ${titles.length}`, { exact: true })).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.locator('.upcoming-stop')).toHaveCount(0);
      await expect(page.locator('.narration-title')).toHaveText(titles[0] ?? '');
      await expect(page.getByRole('button', { name: 'Ask the guide' })).toBeVisible();
    });
  } finally {
    await docent.stop();
  }
});
