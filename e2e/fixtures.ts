import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test as base } from '@playwright/test';

type Docent = {
  /** The startup URL the server printed, token fragment included. */
  url: string;
};

/**
 * Starts the real production server (`node apps/server/dist/main.js`) once per
 * worker, and reads the startup URL it prints, the same way a user would.
 */
export const test = base.extend<object, { docent: Docent }>({
  docent: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructuring pattern here.
    async ({}, use) => {
      const main = fileURLToPath(new URL('../apps/server/dist/main.js', import.meta.url));
      const server = spawn(process.execPath, [main], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      const url = await new Promise<string>((resolve, reject) => {
        server.once('exit', (code) => reject(new Error(`Server exited early with code ${code}`)));
        createInterface({ input: server.stdout }).on('line', (line) => {
          const match = line.match(/https?:\/\/\S+/);
          if (match) resolve(match[0]);
        });
      });

      await use({ url });

      server.kill();
      await once(server, 'exit');
    },
    { scope: 'worker' },
  ],
});

export { expect } from '@playwright/test';
