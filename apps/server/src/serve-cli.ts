// `docent serve`: runs the launcher on a fixed localhost port, so links can open reviews.
// `docent serve --stop` stops it. See docs/launcher.md.
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { createAdaptorServer } from '@hono/node-server';
import { sdkRunner } from './agent.ts';
import { fixedSession, localSessions } from './author-session.ts';
import { fixtureRunner, fixtureSource } from './fixture.ts';
import { defaultCacheDir, githubSource, type PrInfo, parsePrUrl, readPrHead } from './github.ts';
import { createLauncher, type PrPreview } from './launcher.ts';
import { DEFAULT_MODEL, Review, tourCachePath } from './review.ts';
import { startServer } from './server.ts';

const DEFAULT_PORT = 4917;

const usage = `Usage: docent serve [options]

Runs the launcher on 127.0.0.1, so a link like
  http://127.0.0.1:${DEFAULT_PORT}/open?pr=https://github.com/owner/repo/pull/1
opens a confirm page, and a click on it opens the review.

Options:
  --port <n>        Port to listen on (default: "port" in the config file, or ${DEFAULT_PORT})
  --model <id>      Model for the guide (default: $DOCENT_MODEL or ${DEFAULT_MODEL})
  --stop            Stop the launcher running on that port
  --fixture <dir>   Replay a recorded fixture: no GitHub or model calls

Config: ${configPath()}
  { "allowedRepos": ["owner/repo"], "port": ${DEFAULT_PORT} }
  Links open only PRs in allowedRepos. With no config file, only the repository Docent itself
  was cloned from is allowed.`;

const { values } = parseArgs({
  args: process.argv.slice(3),
  options: {
    port: { type: 'string' },
    model: { type: 'string' },
    stop: { type: 'boolean', default: false },
    fixture: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
if (values.help) {
  console.log(usage);
  process.exit(0);
}

const config = await loadConfig(configPath());
const port = values.port !== undefined ? Number(values.port) : (config.port ?? DEFAULT_PORT);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('--port takes a port number, like 4917 (0 picks a free one, for tests)');
  process.exit(1);
}
const cacheDir = defaultCacheDir();
const pidFile = (p: number) => join(cacheDir, `launcher-${p}.pid`);

if (values.stop) await stop(port);
else await serve();

async function serve() {
  const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));
  // Checked per review, not at startup, so a launcher started at login before a build doesn't
  // crash-loop; the confirm click says what's missing instead.
  const webMissing = `Web app not built (missing ${webRoot}). Run: pnpm build`;
  if (!existsSync(webRoot)) console.error(webMissing);
  const model = values.model ?? process.env.DOCENT_MODEL ?? DEFAULT_MODEL;
  const allowedRepos = config.allowedRepos ?? (await ownRepo());
  const fixture = values.fixture;

  const preview = fixture
    ? async (url: string): Promise<PrPreview> => {
        const pr = JSON.parse(await readFile(join(fixture, 'pr.json'), 'utf8')) as PrInfo;
        if (url.toLowerCase() !== pr.url.toLowerCase()) {
          throw new Error(`This launcher replays a fixture, so it only opens ${pr.url}`);
        }
        return { ...pr, url, cached: false };
      }
    : async (url: string): Promise<PrPreview> => {
        const pr = await readPrHead(url);
        return { ...pr, url, cached: existsSync(tourCachePath(cacheDir, pr, model)) };
      };

  // The launcher checks requests against its port, which is only known after listening (with
  // --port 0). Nothing is served before it's set.
  let launcher: ReturnType<typeof createLauncher> | undefined;
  const server = createAdaptorServer({
    fetch: (request) => launcher?.app.fetch(request) ?? new Response('Starting', { status: 503 }),
  });
  server.listen(port, '127.0.0.1');
  try {
    await once(server, 'listening');
  } catch (error) {
    if ((error as { code?: string }).code === 'EADDRINUSE') {
      console.error(
        `Port ${port} is in use. If the launcher is already running, it's ready; stop it with: docent serve --stop`,
      );
      process.exit(1);
    }
    throw error;
  }
  const actualPort = (server.address() as { port: number }).port;
  launcher = createLauncher({
    port: actualPort,
    allowedRepos,
    configPath: configPath(),
    preview,
    start: async (pr) => {
      if (!existsSync(webRoot)) throw new Error(webMissing);
      const review = fixture
        ? new Review({
            source: fixtureSource(fixture),
            runner: fixtureRunner(fixture),
            locator: fixedSession({
              found: false,
              reason: 'This recorded review names no author session',
            }),
            model,
          })
        : new Review({
            source: githubSource(pr.url, cacheDir),
            runner: sdkRunner,
            locator: localSessions({}),
            model,
            cacheDir,
          });
      review.subscribe((tour) => {
        if (tour.state === 'failed') console.error(`${pr.url}: tour failed: ${tour.reason}`);
      });
      const server = await startServer({ webRoot, review });
      // Never the token: logs outlive the review.
      console.log(`Opened ${pr.url} at ${server.origin}`);
      return server;
    },
  });

  await mkdir(cacheDir, { recursive: true });
  await writeFile(pidFile(actualPort), `${process.pid}\n`);

  console.log(`Docent launcher is listening at http://127.0.0.1:${actualPort}`);
  console.log(
    allowedRepos.length
      ? `Links may open PRs in: ${allowedRepos.join(', ')}`
      : `No repositories are allowed. Add some to ${configPath()}`,
  );

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      // An open progress stream can hold a server open; don't let it hold up the exit.
      setTimeout(() => process.exit(0), 3000).unref();
      void Promise.allSettled([
        launcher?.close(),
        new Promise((resolve) => server.close(resolve)),
        rm(pidFile(actualPort), { force: true }),
      ]).then(() => process.exit(0));
    });
  }
}

/** Stops the launcher on `port` by the PID it wrote, after checking that PID is still it. */
async function stop(p: number) {
  const file = pidFile(p);
  const pid = existsSync(file) ? Number((await readFile(file, 'utf8')).trim()) : Number.NaN;
  if (!Number.isInteger(pid) || pid <= 0) {
    console.log(`No launcher is running on port ${p}.`);
    return;
  }
  // The PID may have been reused since a crash; only signal a process that is a launcher.
  const command = await promisify(execFile)('ps', ['-p', String(pid), '-o', 'command='])
    .then(({ stdout }) => stdout)
    .catch(() => '');
  if (!/cli\.[jt]s serve\b/.test(command)) {
    await rm(file, { force: true });
    console.log(`No launcher is running on port ${p}.`);
    return;
  }
  process.kill(pid, 'SIGTERM');
  console.log(`Stopped the launcher on port ${p} (PID ${pid}).`);
}

/** The config file: $DOCENT_CONFIG, or config.json in the user's config folder. */
function configPath(): string {
  if (process.env.DOCENT_CONFIG) return process.env.DOCENT_CONFIG;
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'docent', 'config.json');
}

async function loadConfig(path: string): Promise<{ allowedRepos?: string[]; port?: number }> {
  if (!existsSync(path)) return {};
  const fail = (why: string): never => {
    console.error(`${path}: ${why}`);
    process.exit(1);
  };
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    return fail(`not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const { allowedRepos, port } = (raw ?? {}) as { allowedRepos?: unknown; port?: unknown };
  if (
    allowedRepos !== undefined &&
    !(
      Array.isArray(allowedRepos) &&
      allowedRepos.every(
        (repo) =>
          typeof repo === 'string' &&
          parsePrUrl(`https://github.com/${repo}/pull/1`) !== null &&
          repo.split('/').length === 2,
      )
    )
  ) {
    return fail('"allowedRepos" must be a list like ["owner/repo"]');
  }
  if (port !== undefined && !(Number.isInteger(port) && (port as number) > 0)) {
    return fail('"port" must be a port number');
  }
  return {
    ...(allowedRepos ? { allowedRepos: allowedRepos as string[] } : {}),
    ...(port !== undefined ? { port: port as number } : {}),
  };
}

/** The GitHub repo Docent itself was cloned from: the default allow list. None if unknown. */
async function ownRepo(): Promise<string[]> {
  const root = dirname(fileURLToPath(new URL('../../../package.json', import.meta.url)));
  try {
    const { stdout } = await promisify(execFile)('git', [
      '-C',
      root,
      'remote',
      'get-url',
      'origin',
    ]);
    const match = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(stdout.trim());
    return match?.[1] && match[2] ? [`${match[1]}/${match[2]}`] : [];
  } catch {
    return [];
  }
}
