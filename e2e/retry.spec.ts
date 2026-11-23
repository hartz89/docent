import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, launch, test } from './fixtures.ts';

// The ledger demo, with a guide that never returns a tour on the first try (three answers in the
// wrong shape fail it), then returns the recorded one.
function flakyFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'docent-flaky-'));
  cpSync(fileURLToPath(new URL('fixtures/ledger-demo', import.meta.url)), dir, { recursive: true });
  const replies = JSON.parse(readFileSync(join(dir, 'replies.json'), 'utf8'));
  const [good] = replies.tour;
  const bad = { ...good, structured: null, text: 'not a tour' };
  replies.tour = [bad, bad, bad, good];
  writeFileSync(join(dir, 'replies.json'), JSON.stringify(replies));
  return dir;
}

test('a tour that failed is tried again from the page, with no trip to the terminal', async ({
  page,
}) => {
  const docent = await launch('cli.js', ['review', '--fixture', flakyFixture()]);
  try {
    const failed = page.getByRole('alert');
    await test.step('the failure says what went wrong and offers Try again', async () => {
      await page.goto(docent.url);
      await expect(failed).toContainText("The tour couldn't be written");
      await expect(failed).toContainText('never returned a tour');
    });

    await test.step('Try again writes the tour, and the page follows it', async () => {
      await failed.getByRole('button', { name: 'Try again' }).click();
      await expect(page.locator('.narration-title')).toHaveText('Greetings can be excited');
      await expect(page.getByLabel('Your question')).toBeVisible();
      await expect(failed).toHaveCount(0);
    });

    await test.step('a reload shows the written tour, not the failure', async () => {
      await page.reload();
      await expect(page.locator('.narration-title')).toHaveText('Greetings can be excited');
    });
  } finally {
    await docent.stop();
  }
});
