import { fileURLToPath } from 'node:url';
import { expect, launch, test } from './fixtures.ts';

// The PR's description is untrusted text from GitHub. It renders as Markdown, but it can never
// run script, load an image, or inject markup.
const fixture = fileURLToPath(new URL('fixtures/ledger-demo', import.meta.url));

const hostile = [
  '<details><summary>Known gaps</summary>',
  '',
  'Read [the spec](https://example.com/spec) and [this](javascript:void0) and [that](JAVASCRIPT:void0).',
  '',
  '![tracking pixel](https://evil.example/p.png)',
  '',
  'Hidden <!-- a template comment --> here. <img src=x onerror=alert(3)>',
  '',
  '```html',
  '<!-- kept in code -->',
  '```',
  '',
  '<!--',
  'A template hint, e.g.',
  '```',
  'fix: thing',
  '```',
  '-->',
  '</details>',
].join('\n');

test('a hostile description renders as text: safe links only, no images, no markup', async ({
  page,
}) => {
  const docent = await launch('cli.js', ['review', '--fixture', fixture]);
  try {
    await page.route('**/api/review', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.pr.body = hostile;
      await route.fulfill({ response: res, json: body });
    });
    const fetched: string[] = [];
    page.on('request', (request) => fetched.push(request.url()));
    await page.goto(docent.url);

    const description = page.locator('.overview .description');
    await expect(description).toContainText('Read the spec and this and that.');

    await test.step('only the http(s) link is a link, and it shows where it goes', async () => {
      const links = description.getByRole('link');
      await expect(links).toHaveCount(1);
      await expect(links).toHaveAttribute('href', 'https://example.com/spec');
      await expect(links).toHaveAttribute('title', 'https://example.com/spec');
      await expect(links).toHaveAttribute('rel', 'noreferrer');
    });

    await test.step('images and raw HTML stay text, and nothing is fetched', async () => {
      await expect(description.locator('img')).toHaveCount(0);
      await expect(description).toContainText('tracking pixel');
      await expect(description).toContainText('<img src=x onerror=alert(3)>');
      expect(fetched.filter((url) => url.includes('evil.example'))).toEqual([]);
    });

    await test.step('comments and details tags go, except inside code', async () => {
      await expect(description.getByRole('heading', { name: 'Known gaps' })).toBeVisible();
      await expect(description).not.toContainText('a template comment');
      // A comment runs to its end even across a code fence, as on GitHub.
      await expect(description).not.toContainText('template hint');
      await expect(description.locator('.md-code')).toHaveCount(1);
      await expect(description).not.toContainText('<details>');
      await expect(description.locator('.md-code')).toHaveText('<!-- kept in code -->');
    });
  } finally {
    await docent.stop();
  }
});
