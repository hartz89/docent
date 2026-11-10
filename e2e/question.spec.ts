import { fileURLToPath } from 'node:url';
import { expect, launch, test } from './fixtures.ts';

// The recorded review from tour.spec.ts. Its recorded question reply stands in for whichever
// session answers, so these flows check who the screen says answered, not what was said.
const fixture = fileURLToPath(new URL('fixtures/hono-4813', import.meta.url));

test('with no author session, the guide answers and says why', async ({ page }) => {
  const docent = await launch('cli.js', ['review', '--fixture', fixture]);
  try {
    await page.goto(docent.url);
    await page.getByLabel('Your question').fill('What does it return with no Origin header?');
    await page.getByRole('button', { name: 'Ask the guide' }).click();

    await expect(page.locator('.exchange-answer')).toContainText('It returns null.');
    await expect(page.locator('.exchange-source')).toHaveText(
      /^Answered by the guide, not the author \(this recorded review names no author session\) · \$0\.03$/,
    );
  } finally {
    await docent.stop();
  }
});

test("with the author's session, the author answers", async ({ page }) => {
  const session = '11111111-2222-4333-8444-555555555555';
  const docent = await launch('cli.js', ['review', '--fixture', fixture, '--session', session]);
  try {
    await page.goto(docent.url);
    await page.getByLabel('Your question').fill('Why return null here?');
    await page.getByRole('button', { name: 'Ask the author' }).click();

    await expect(page.locator('.exchange-source')).toHaveText(
      /^Answered by the author's session, in a read-only copy · \$0\.03$/,
    );
  } finally {
    await docent.stop();
  }
});
