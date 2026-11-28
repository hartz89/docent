import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, launch, test } from './fixtures.ts';

const recorded = fileURLToPath(new URL('fixtures/hono-4813', import.meta.url));

test("the intent stop shows the author's handoff, attributed and marked as claims", async ({
  page,
}) => {
  // The recorded PR has no handoff, so this copy of it gets one. Its text is made up for the test.
  const fixture = await mkdtemp(join(tmpdir(), 'docent-e2e-handoff-'));
  await cp(recorded, fixture, { recursive: true });
  const pr = JSON.parse(await readFile(join(fixture, 'pr.json'), 'utf8')) as { head: string };
  const handoff = {
    commit: pr.head,
    text: '**Intent:** a test handoff, not from the real PR.\n\n- Look first at the `credentials` branch.',
    url: 'https://github.com/honojs/hono/pull/4813#issuecomment-1',
  };
  await writeFile(join(fixture, 'pr.json'), JSON.stringify({ ...pr, handoff }));

  const docent = await launch('cli.js', ['review', '--fixture', fixture]);
  try {
    await page.goto(docent.url);
    const note = page.getByRole('region', { name: "From the author's handoff" });

    await expect(note).toContainText("The author's claims, as they wrote them");
    await expect(note).toContainText('written for the head commit');
    await expect(note.locator('strong')).toHaveText('Intent:');
    await expect(note.locator('code')).toHaveText('credentials');
    await expect(note.getByRole('link', { name: 'on GitHub' })).toHaveAttribute(
      'href',
      handoff.url,
    );

    // Only the intent stop carries it.
    await page.keyboard.press('ArrowRight');
    await expect(page.getByText('Stop 2 of')).toBeVisible();
    await expect(note).toHaveCount(0);
  } finally {
    await docent.stop();
  }
});
