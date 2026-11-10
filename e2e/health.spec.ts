import { expect, test } from './fixtures.ts';

test('opening the startup URL shows that the server is healthy', async ({ page, docent }) => {
  await page.goto(docent.url);

  await expect(page.getByText(/Server OK, version \d+\.\d+\.\d+/)).toBeVisible();
  // The token is moved out of the address bar once the page has it.
  expect(page.url()).not.toContain('token');
  // With no review open, the tab just says Docent, with its icon.
  await expect(page).toHaveTitle('Docent');
  const icon = await page.request.get(new URL('/favicon.svg', docent.url).href);
  expect(icon.ok()).toBe(true);
  expect(icon.headers()['content-type']).toContain('image/svg+xml');
});
