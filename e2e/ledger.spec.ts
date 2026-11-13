import { fileURLToPath } from 'node:url';
import { expect, launch, test } from './fixtures.ts';

// A small recorded PR with all three kinds of changed lines: a behavior change the tour cites, a
// rename and a re-indent that core proves, and a docs file nobody cites, with the guide's note.
const fixture = fileURLToPath(new URL('fixtures/ledger-demo', import.meta.url));

test('the left pane shows where every changed line stands: on the route, proven, or listed', async ({
  page,
}) => {
  const docent = await launch('cli.js', ['review', '--fixture', fixture]);
  try {
    await page.goto(docent.url);
    const route = page.getByRole('tabpanel', { name: /Route/ });

    await test.step('one bar counts every changed line in three groups', async () => {
      const ledger = route.getByRole('region', { name: 'Every changed line' });
      await expect(ledger).toContainText('14 changed lines');
      await expect(ledger).toContainText('every line shown');
      await expect(ledger.getByRole('definition')).toHaveText(['4', '8', '2']);
    });

    await test.step('proven skips carry the script’s label, and a rename shows its mapping', async () => {
      const proven = route.getByRole('region', { name: 'Proven skips' });
      await expect(proven.getByRole('heading')).toContainText('3 files · 8 lines');
      const names = proven.getByRole('button', { name: /names\.ts/ });
      await expect(names.locator('.proof')).toHaveText('proven rename');
      await expect(names).toContainText('getName → readName');
      await expect(proven.getByRole('button', { name: /format\.ts/ }).locator('.proof')).toHaveText(
        'proven whitespace only',
      );
    });

    await test.step('the rest is listed by file, with the guide’s note marked as its word', async () => {
      const off = route.getByRole('region', { name: 'Not on the route' });
      const notes = off.getByRole('button', { name: /notes\.md/ });
      await expect(notes.locator('.guide-note')).toHaveText(
        'guide: Release notes for the new flag',
      );
      // A note is prose, never a proof chip.
      await expect(off.locator('.proof')).toHaveCount(0);
      await notes.click();
      await expect(page.locator('.code-path')).toHaveText('docs/notes.md');
      await expect(page.locator('.code-side')).toHaveText('head');
      await expect(page.locator('.line[data-line="3"]')).toHaveClass(/added.*off-route/);
    });

    await test.step('an uncited removed line opens at base, marked not on the route', async () => {
      const off = route.getByRole('region', { name: 'Not on the route' });
      await off.getByRole('button', { name: 'Open 1 removed line at base' }).click();
      await expect(page.locator('.code-path')).toHaveText('docs/notes.md');
      await expect(page.locator('.code-side')).toHaveText('base');
      const removed = page.locator('.line[data-line="3"]');
      await expect(removed).toHaveClass(/removed.*off-route/);
      await expect(removed).toContainText('Greetings are plain.');
    });

    await test.step('the file tree marks a proven skip with a dashed dot', async () => {
      await page.getByRole('tab', { name: /Files/ }).click();
      const row = (name: string) => page.locator('.tree-node.changed', { hasText: name });
      await expect(row('format.ts').locator('.route-dot')).toHaveClass(/proven/);
      await expect(row('greet.ts').locator('.route-dot')).toHaveClass(/\bon\b/);
      await expect(row('notes.md').locator('.route-dot')).toHaveClass(/\boff\b/);
    });
  } finally {
    await docent.stop();
  }
});
