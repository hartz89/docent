import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { test as base } from '@playwright/test';

type Docent = {
  /** The startup URL the server printed, token fragment included. */
  url: string;
};

/**
 * Starts a built entry point (`apps/server/dist/*.js`), with any extra environment variables, and
 * reads the startup URL it prints, the
 * same way a user would. `output` holds every line it has printed so far. Stop it with the
 * returned function, which kills that process by PID.
 */
export async function launch(
  entry: string,
  args: readonly string[] = [],
  env: Record<string, string> = {},
): Promise<{ url: string; output: string[]; stop: () => Promise<void> }> {
  const script = fileURLToPath(new URL(`../apps/server/dist/${entry}`, import.meta.url));
  const child: ChildProcess = spawn(process.execPath, [script, ...args], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, CI: '1', ...env },
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
