import { expect, test } from './fixtures.ts';

test('opening the startup URL shows that the server is healthy', async ({ page, docent }) => {
  await page.goto(docent.url);

  await expect(page.getByText(/Server OK, version \d+\.\d+\.\d+/)).toBeVisible();
  // The token is moved out of the address bar once the page has it.
  expect(page.url()).not.toContain('token');
});
