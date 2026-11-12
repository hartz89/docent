import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test as base } from '@playwright/test';

type Docent = {
  /** The startup URL the server printed, token fragment included. */
  url: string;
};

/**
 * Starts a built entry point (`apps/server/dist/*.js`) and reads the startup URL it prints, the
 * same way a user would. `output` holds every line it has printed so far. Stop it with the
 * returned function, which kills that process by PID. Each launch gets its own empty data
 * folder, `dataDir`, so run logs land there and never in the real one.
 */
export async function launch(
  entry: string,
  args: readonly string[] = [],
): Promise<{ url: string; output: string[]; dataDir: string; stop: () => Promise<void> }> {
  const script = fileURLToPath(new URL(`../apps/server/dist/${entry}`, import.meta.url));
  const dataDir = mkdtempSync(join(tmpdir(), 'docent-e2e-'));
  const child: ChildProcess = spawn(process.execPath, [script, ...args], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, CI: '1', DOCENT_DATA_DIR: dataDir, DOCENT_RUN_LOG: '' },
  });
  const output: string[] = [];
  const url = await new Promise<string>((resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`${entry} exited early with code ${code}`)));
    if (!child.stdout) return reject(new Error('No stdout'));
    createInterface({ input: child.stdout }).on('line', (line) => {
      output.push(line);
      const match = line.match(/https?:\/\/\S+/);
      if (match) resolve(match[0]);
    });
  });
  return {
    url,
    output,
    dataDir,
    stop: async () => {
      child.kill();
      await once(child, 'exit');
    },
  };
}

/** The production server with no review open, once per worker. */
export const test = base.extend<object, { docent: Docent }>({
  docent: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructuring pattern here.
    async ({}, use) => {
      const server = await launch('main.js');
      await use({ url: server.url });
      await server.stop();
    },
    { scope: 'worker' },
  ],
});

export { expect } from '@playwright/test';
