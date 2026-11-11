// Proves a packed tarball works the way a user gets it: installed from npm's registry into an
// empty folder, far from this repo, then run. It replays a recorded review, so there are no
// GitHub or model calls, and nothing needs a login.
// Run: node scripts/pack-smoke.ts dist/<tarball>.tgz (after pnpm pack:cli). Needs the network.

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const tarballArg = process.argv[2];
if (!tarballArg) {
  console.error('Usage: node scripts/pack-smoke.ts <tarball.tgz>');
  process.exit(1);
}
const tarball = resolve(tarballArg);
const fixture = join(import.meta.dirname, '..', 'e2e', 'fixtures', 'hono-4813');
const scratch = mkdtempSync(join(tmpdir(), 'docent-smoke-'));
// Same reason as in pack.ts: pnpm's settings must not steer npm.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith('npm_config_')),
);

let child: ChildProcess | undefined;
try {
  execFileSync('npm', ['init', '-y'], { cwd: scratch, env, stdio: 'ignore' });
  execFileSync('npm', ['install', '--no-audit', '--no-fund', tarball], {
    cwd: scratch,
    env,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  // Every installed package, less the scratch folder itself and Docent.
  const dependencies =
    execFileSync('npm', ['ls', '--all', '--parseable'], { cwd: scratch, env, encoding: 'utf8' })
      .trim()
      .split('\n').length - 2;
  const megabytes = folderBytes(join(scratch, 'node_modules')) / 1024 / 1024;
  const bin = join(scratch, 'node_modules', '.bin', 'docent');

  const help = execFileSync(bin, ['--help'], { cwd: scratch, encoding: 'utf8' });
  if (!help.includes('Usage: docent review')) throw new Error(`Unexpected --help output:\n${help}`);
  console.log('ok  docent --help');

  // The fixture is test input only; copy it in so the run touches nothing in this repo.
  cpSync(fixture, join(scratch, 'fixture'), { recursive: true });
  child = spawn(bin, ['review', '--fixture', 'fixture', '--no-open'], {
    cwd: scratch,
    env: { ...env, CI: '1', DOCENT_CACHE_DIR: join(scratch, 'cache') },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const lines: string[] = [];
  const url = await new Promise<string>((done, fail) => {
    child?.once('exit', (code) => fail(new Error(`docent exited early with code ${code}`)));
    if (!child?.stdout) return fail(new Error('No stdout'));
    createInterface({ input: child.stdout }).on('line', (line) => {
      lines.push(line);
      const match = line.match(/https?:\/\/\S+/);
      if (match) done(match[0]);
    });
  });
  const { origin, hash } = new URL(url);
  const auth = { authorization: `Bearer ${new URLSearchParams(hash.slice(1)).get('token')}` };

  const page = await fetch(origin);
  if (!page.ok || !(await page.text()).includes('<div id="root">')) {
    throw new Error(`The web app didn't load from ${origin}`);
  }
  console.log('ok  serves the web app');

  const health = (await (await fetch(`${origin}/api/health`, { headers: auth })).json()) as {
    version?: string;
  };
  console.log(`ok  /api/health reports version ${health.version}`);

  let state = 'working';
  for (let i = 0; i < 100 && state === 'working'; i++) {
    const review = (await (await fetch(`${origin}/api/review`, { headers: auth })).json()) as {
      tour: { state: string; reason?: string; tour?: { stops: unknown[] } };
    };
    state = review.tour.state;
    if (state === 'failed') throw new Error(`The tour failed: ${review.tour.reason}`);
    if (state === 'ready') console.log(`ok  tour ready: ${review.tour.tour?.stops.length} stops`);
    else await new Promise((r) => setTimeout(r, 100));
  }
  if (state !== 'ready') throw new Error(`The tour never finished:\n${lines.join('\n')}`);

  const unauthorized = await fetch(`${origin}/api/review`);
  if (unauthorized.status !== 401) throw new Error(`No token gave ${unauthorized.status}, not 401`);
  console.log('ok  refuses requests without the token');
  console.log(`Installed: ${dependencies} dependencies, ${megabytes.toFixed(0)} MB on disk.`);
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await once(child, 'exit');
  }
  rmSync(scratch, { recursive: true, force: true });
}

function folderBytes(dir: string): number {
  return readdirSync(dir, { recursive: true }).reduce<number>((sum, path) => {
    const stats = lstatSync(join(dir, String(path)));
    return stats.isFile() ? sum + stats.size : sum;
  }, 0);
}
