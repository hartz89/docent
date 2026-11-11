import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, launch, test } from './fixtures.ts';

// The recorded hono PR. Its third stop cites src/middleware/cors/index.ts at head: lines 77–83,
// inside the diff, and lines 63–73, outside it.
const fixture = fileURLToPath(new URL('fixtures/hono-4813', import.meta.url));
const pr = JSON.parse(readFileSync(`${fixture}/pr.json`, 'utf8')) as { url: string; head: string };
const file = 'src/middleware/cors/index.ts';

test('the reviewer comments on lines, and the comments post with the verdict', async ({ page }) => {
  const docent = await launch('cli.js', ['review', '--fixture', fixture]);
  try {
    await page.goto(docent.url);
    const code = page.getByRole('region', { name: 'Code' });
    const stopThree = (await page.locator('.stop-title').nth(2).textContent()) ?? '';
    await page.locator('.stop-button').nth(2).click();

    /** Opens the composer under a line of the code view. */
    const commentOn = async (line: number) => {
      const row = code.locator(`.line[data-line="${line}"]`);
      await row.hover();
      await row.getByRole('button', { name: `Comment on line ${line}` }).click();
      return code.getByLabel(`Your comment on line ${line}`);
    };

    await test.step('a comment on a changed line goes into the batch with ⌘↵, and stays editable', async () => {
      let box = await commentOn(80);
      await box.fill('Should this log?');
      await box.press('ControlOrMeta+Enter');
      await expect(code.locator('.thread.draft')).toContainText('Draft · not posted');
      await expect(page.getByRole('button', { name: /1 not posted/ })).toBeVisible();

      await code.getByRole('button', { name: 'Edit your comment on line 80' }).click();
      box = code.getByLabel('Your comment on line 80');
      await box.fill('Should this log that the wildcard was reflected?');
      await box.press('ControlOrMeta+Enter');
      await expect(code.locator('.thread.draft')).toHaveText(
        /Should this log that the wildcard was reflected\?/,
      );

      // A comment can be removed before it's ever sent.
      box = await commentOn(81);
      await box.fill('Never mind.');
      await box.press('ControlOrMeta+Enter');
      await code.getByRole('button', { name: 'Remove your comment on line 81' }).click();
      await expect(code.locator('.thread.draft')).toHaveCount(1);
      await expect(page.getByRole('button', { name: /1 not posted/ })).toBeVisible();
    });

    await test.step('typing in a comment never moves the tour', async () => {
      const box = await commentOn(66);
      await box.fill('Are these defaults documented?');
      await box.press('ArrowRight');
      await box.press('ArrowLeft');
      await box.press('ArrowDown');
      // Esc closes only an empty box: written words go only with Cancel.
      await box.press('Escape');
      await expect(box).toBeVisible();
      await expect(page.locator('.stop-button[aria-current="step"]')).toContainText(stopThree);
      await code.getByRole('button', { name: 'Add to batch' }).click();
      await expect(page.getByRole('button', { name: /2 not posted/ })).toBeVisible();
    });

    await test.step('drafts survive a reload, and the batch takes you back to a line', async () => {
      // A draft left from an earlier head of this PR: it stays, marked out of date.
      await page.evaluate((key) => {
        const drafts = JSON.parse(localStorage.getItem(key) ?? '[]');
        drafts.push({
          id: 'old',
          path: 'src/middleware/cors/index.ts',
          side: 'new',
          line: 70,
          body: 'Written before the last push.',
          head: 'a'.repeat(40),
          stopId: 'stop-3',
        });
        localStorage.setItem(key, JSON.stringify(drafts));
      }, 'docent:drafts:honojs/hono#4813');
      await page.reload();
      await expect(page.getByText('Stop 1 of')).toBeVisible();
      const tray = page.getByRole('region', { name: 'Your batch' });
      await tray.getByRole('button', { name: 'Show' }).click();
      await expect(tray.locator('.tray-item')).toHaveCount(3);
      await expect(tray).toContainText('1 on diff lines · 1 in the summary · 1 out of date');
      await tray.getByRole('button', { name: /index\.ts:66/ }).click();
      await expect(page.locator('.stop-button[aria-current="step"]')).toContainText(stopThree);
      await expect(code.locator('.line[data-line="66"]')).toBeInViewport();
    });

    await test.step('the verdict stop lists the batch, and the preview shows where each lands', async () => {
      await page.getByRole('button', { name: /2 not posted/ }).click();
      await expect(code.getByRole('heading', { name: 'Your review' })).toBeVisible();
      const items = code.locator('.review-item');
      await expect(items).toHaveCount(3);
      await expect(items.nth(2)).toContainText(
        `written at aaaaaaa · the PR has moved to ${pr.head.slice(0, 7)}`,
      );
      // In reading order, whatever order they were written in.
      await expect(items.nth(0)).toContainText(`${file}:66`);
      await expect(items.nth(0)).toContainText('outside the diff · goes in the summary');
      await expect(items.nth(1)).toContainText(`${file}:80`);
      await expect(items.nth(1)).toContainText('on the diff line');

      const review = page.getByRole('region', { name: 'Your review' });
      await expect(review).toContainText('Posts to GitHub as one review, with your 2 comments.');
      await expect(review).toContainText('1 comment was written before the PR moved');
      await review.getByRole('radio', { name: /Approve/ }).check();
      await review.getByLabel(/Summary/).fill('Checked the credentials path.');
      await expect(review).toContainText(
        `Approve honojs/hono#4813 at ${pr.head.slice(0, 7)} as you, with 1 line comment and this summary:`,
      );
      const note = review.locator('.verdict-note');
      await expect(note.getByRole('link', { name: `${file}:66` })).toHaveAttribute(
        'href',
        `https://github.com/honojs/hono/blob/${pr.head}/${file}#L66`,
      );
      await expect(note).toContainText('Are these defaults documented?');

      // An edit that isn't saved yet blocks sending, so what posts is what's on screen.
      await code.getByRole('button', { name: `Edit your comment at ${file}:80` }).click();
      await code.getByLabel('Your comment on line 80').fill('Changed my mind about this.');
      await expect(review.getByRole('alert')).toContainText("isn't in the batch yet");
      await expect(review.getByRole('button', { name: 'Approve on GitHub' })).toBeDisabled();
      await code.getByRole('button', { name: 'Cancel' }).click();
      await expect(review.getByRole('button', { name: 'Approve on GitHub' })).toBeEnabled();
    });

    await test.step('approving posts the comments once, on their lines or in the body', async () => {
      const review = page.getByRole('region', { name: 'Your review' });
      await review.getByRole('button', { name: 'Approve on GitHub' }).click();
      await expect(review.getByRole('heading', { name: 'Approved on GitHub' })).toBeVisible();
      await expect(review).toContainText('with 2 comments');
      await expect(page.getByRole('button', { name: /not posted/ })).toHaveCount(0);

      const recorded = docent.output.filter((line) => line.startsWith('Recorded a review'));
      expect(recorded).toEqual([
        `Recorded a review, not sent to GitHub: ${JSON.stringify({
          commitId: pr.head,
          event: 'APPROVE',
          body: `Checked the credentials path.\n\n[\`${file}:66\`](https://github.com/honojs/hono/blob/${pr.head}/${file}#L66)\n> Are these defaults documented?`,
          comments: [
            {
              path: file,
              line: 80,
              side: 'RIGHT',
              body: 'Should this log that the wildcard was reflected?',
            },
          ],
        })}`,
      ]);

      // Posted comments leave the browser's drafts; the out-of-date one, never sent, stays.
      const left = await page.evaluate(() =>
        localStorage.getItem('docent:drafts:honojs/hono#4813'),
      );
      expect((JSON.parse(left ?? '[]') as { id: string }[]).map((d) => d.id)).toEqual(['old']);
    });
  } finally {
    await docent.stop();
  }
});
