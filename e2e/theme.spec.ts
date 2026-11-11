import { fileURLToPath } from 'node:url';
import { expect, launch, test } from './fixtures.ts';

const fixture = fileURLToPath(new URL('fixtures/hono-4813', import.meta.url));

const LIGHT_GROUND = 'rgb(252, 251, 248)';
const DARK_GROUND = 'rgb(18, 21, 26)';

test('the page follows a light system theme, and the top bar toggle overrides it across reloads', async ({
  page,
}) => {
  const docent = await launch('cli.js', ['review', '--fixture', fixture]);
  try {
    await page.emulateMedia({ colorScheme: 'light' });

    await test.step('a light system setting gets the light theme', async () => {
      await page.goto(docent.url);
      await expect(page.locator('.narration-title')).toBeVisible();
      await expect(page.locator('body')).toHaveCSS('background-color', LIGHT_GROUND);
    });

    const toggle = page.locator('.topbar').getByRole('button', { name: /^Theme:/ });

    await test.step('the toggle switches to dark, and dark survives a reload', async () => {
      await expect(toggle).toHaveAccessibleName(/matches your system/);
      await toggle.click();
      await expect(toggle).toHaveAccessibleName(/^Theme: dark/);
      await expect(page.locator('body')).toHaveCSS('background-color', DARK_GROUND);

      await page.reload();
      await expect(page.locator('.narration-title')).toBeVisible();
      await expect(toggle).toHaveAccessibleName(/^Theme: dark/);
      await expect(page.locator('body')).toHaveCSS('background-color', DARK_GROUND);
    });

    await test.step('two more clicks go back to following the system', async () => {
      await toggle.click();
      await toggle.click();
      await expect(toggle).toHaveAccessibleName(/matches your system/);
      await expect(page.locator('body')).toHaveCSS('background-color', LIGHT_GROUND);
      // Following the system means following it live.
      await page.emulateMedia({ colorScheme: 'dark' });
      await expect(page.locator('body')).toHaveCSS('background-color', DARK_GROUND);
    });
  } finally {
    await docent.stop();
  }
});
