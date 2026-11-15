import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
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

test('a question and its answer are still there after a reload', async ({ page }) => {
  const docent = await launch('cli.js', ['review', '--fixture', fixture]);
  try {
    await page.goto(docent.url);
    await page.getByLabel('Your question').fill('What does it return with no Origin header?');
    await page.getByRole('button', { name: 'Ask the guide' }).click();
    await expect(page.locator('.exchange-answer')).toContainText('It returns null.');

    await page.reload();

    await expect(page.locator('.exchange-question')).toHaveText(
      'What does it return with no Origin header?',
    );
    await expect(page.locator('.exchange-answer')).toContainText('It returns null.');
    await expect(page.locator('.exchange-source')).toHaveText(
      /^Answered by the guide, not the author \(this recorded review names no author session\) · \$0\.03$/,
    );
    await expect(page.getByLabel('Ask a follow-up')).toBeVisible();
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

// The fixture's second author answer and both answer checks are hand-written, not recorded: the
// second answer is wrong about the code, and the second check says so. The first finds nothing.
test("the guide stays quiet on a sound answer, and notes what the code does when it isn't", async ({
  page,
}) => {
  const session = '11111111-2222-4333-8444-555555555555';
  const docent = await launch('cli.js', ['review', '--fixture', fixture, '--session', session]);
  try {
    await page.goto(docent.url);
    const guide = page.getByRole('complementary', { name: 'The guide' });
    const notes = guide.locator('.callout.correction');

    await guide.getByLabel('Your question').fill('What does it return with no Origin header?');
    await guide.getByRole('button', { name: 'Ask the author' }).click();
    await expect(guide.locator('.exchange-answer')).toHaveCount(1);

    await guide.getByLabel('Ask a follow-up').fill('And what header does that request get?');
    await guide.getByRole('button', { name: 'Ask the author' }).click();
    await expect(guide.locator('.exchange-answer')).toHaveCount(2);

    // One note, under the second answer only, saying what the code does, with its lines.
    await expect(notes).toHaveCount(1);
    await expect(guide.locator('.exchange').first().locator('.callout')).toHaveCount(0);
    const note = guide.locator('.exchange').nth(1).locator('.callout.correction');
    await expect(note).toContainText('The code returns origin || null when credentials are on');
    await expect(note.locator('.correction-source')).toHaveText(
      /^Noted by the guide, at head · <\$0\.01$/,
    );

    await note.getByRole('button', { name: 'index.ts 109–112' }).click();
    await expect(page.locator('.code-range')).toHaveText(
      "lines 109–112 · cited by the guide's note",
    );
    await expect(page.locator('.code-path')).toHaveText('src/middleware/cors/index.ts');
  } finally {
    await docent.stop();
  }
});

test('the run log records the question, its answer, and who answered', async ({ page }) => {
  const docent = await launch('cli.js', ['review', '--fixture', fixture]);
  try {
    await page.goto(docent.url);
    await page.getByLabel('Your question').fill('What does it return with no Origin header?');
    await page.getByRole('button', { name: 'Ask the guide' }).click();
    await expect(page.locator('.exchange-answer')).toContainText('It returns null.');
  } finally {
    await docent.stop();
  }

  const runs = join(docent.dataDir, 'runs');
  const [file, ...others] = await readdir(runs);
  expect(others).toEqual([]);
  const events = (await readFile(join(runs, file ?? ''), 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(events.find((e) => e.kind === 'question')).toMatchObject({
    question: 'What does it return with no Origin header?',
    source: 'guide',
    whyNotAuthor: 'This recorded review names no author session',
    answer: expect.stringContaining('It returns `null`.'),
  });
  // The page reported where the reader was, and the run closed cleanly.
  expect(events.some((e) => e.kind === 'ui.stop')).toBe(true);
  expect(events.at(-1)).toMatchObject({ kind: 'run.end', reason: 'stopped (SIGTERM)' });
});
