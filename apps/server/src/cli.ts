// `docent review <github-pr-url>`: opens a PR for review in the local app.
// With `--prepare`, it only writes the tour to the cache and exits, so a later open is instant.
// `docent runs`: lists and summarizes past runs from the run log.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { sessionId } from '@docent/core';
import { type AgentRunner, sdkRunner } from './agent.ts';
import { fixedSession, localSessions, type SessionLocator } from './author-session.ts';
import { fixtureRunner, fixtureSource, recording } from './fixture.ts';
import {
  defaultCacheDir,
  defaultDataDir,
  githubSource,
  type PrSource,
  parsePrUrl,
} from './github.ts';
import { Review } from './review.ts';
import { RunLog, runLogDisabledByEnv } from './run-log.ts';
import { runsCommand } from './runs.ts';
import { startServer, version } from './server.ts';

const DEFAULT_MODEL = 'claude-opus-5-5';

const runsDir = join(defaultDataDir(), 'runs');

if (process.argv[2] === 'runs') {
  const { out, code } = runsCommand(process.argv.slice(3), runsDir);
  // Wait for the write, so a long summary piped to another program isn't cut off.
  await new Promise((resolve) =>
    (code ? process.stderr : process.stdout).write(`${out}\n`, resolve),
  );
  process.exit(code);
}

const usage = `Usage: docent review <github-pr-url> [options]
       docent runs [show <id|latest>]   (see: docent runs --help)

Options:
  --model <id>      Model for the guide (default: $DOCENT_MODEL or ${DEFAULT_MODEL})
  --session <id>    The author's Claude Code session, to answer questions. By default it's
                    found from the Claude-Session link in the PR, if it's on this machine
                    and worked on this PR's branch in this repo
  --fork-budget <usd>  Ask the guide instead when asking the author's session is estimated to
                    cost more than this per question (default: 2)
  --no-open         Don't open the browser (also off when CI is set)
  --no-cache        Ignore the cached tour and write a fresh one
  --prepare         Generate and cache the tour, print its cost, and exit (no browser)
  --record <dir>    Save the PR, files and guide replies as a fixture
  --fixture <dir>   Replay a recorded fixture: no GitHub or model calls
  --no-run-log      Don't write this run to the run log (or set DOCENT_RUN_LOG=off)`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: 'string' },
    session: { type: 'string' },
    'fork-budget': { type: 'string' },
    'no-open': { type: 'boolean', default: false },
    'no-cache': { type: 'boolean', default: false },
    'no-run-log': { type: 'boolean', default: false },
    prepare: { type: 'boolean', default: false },
    record: { type: 'string' },
    fixture: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const [command, url] = positionals;
if (values.help || command !== 'review' || (!url && !values.fixture)) {
  console.log(usage);
  process.exit(values.help ? 0 : 1);
}
if (url && !values.fixture && !parsePrUrl(url)) {
  console.error(`Not a GitHub pull request URL: ${url}\n\n${usage}`);
  process.exit(1);
}

const forkBudgetUsd =
  values['fork-budget'] === undefined ? undefined : Number(values['fork-budget']);
if (forkBudgetUsd !== undefined && !(Number.isFinite(forkBudgetUsd) && forkBudgetUsd >= 0)) {
  console.error(`--fork-budget takes a number of US dollars, like 0.50`);
  process.exit(1);
}

if (values.prepare && (values['no-cache'] || values.record)) {
  // A cache hit would skip the job, leaving a recording with no replies.
  const other = values.record ? '--record' : '--no-cache';
  console.error(`--prepare writes the tour to the cache, so it cannot be used with ${other}.`);
  process.exit(1);
}

// Resolves from both src/ and dist/, which sit at the same depth.
const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));
if (!values.prepare && !existsSync(webRoot)) {
  console.error(`Web app not built (missing ${webRoot}). Run: pnpm build`);
  process.exit(1);
}

/** Why the run ended, for the run log's last line. */
let endReason = 'exited';
const model = values.model ?? process.env.DOCENT_MODEL ?? DEFAULT_MODEL;
const cacheDir = defaultCacheDir();
const log = startRunLog();
let source: PrSource;
let runner: AgentRunner;
let locator: SessionLocator;
if (values.fixture) {
  source = fixtureSource(values.fixture);
  runner = fixtureRunner(values.fixture);
  // Replies are replayed, so a replay trusts --session without looking for it on this machine.
  locator = fixedSession(
    values.session
      ? {
          found: true,
          id: sessionId(values.session),
          cwd: null,
          via: 'the --session flag',
          contextTokens: null,
        }
      : { found: false, reason: 'This recorded review names no author session' },
  );
} else {
  source = githubSource(url ?? '', cacheDir);
  runner = sdkRunner;
  locator = localSessions(values.session !== undefined ? { explicit: values.session } : {});
  if (values.record) ({ source, runner } = recording(values.record, source, runner));
}

const review = new Review({
  source,
  runner,
  locator,
  model,
  log,
  ...(forkBudgetUsd !== undefined ? { forkBudgetUsd } : {}),
  // Fixtures and recordings always run the job, since a cached tour would skip it. Preparing
  // always caches: that is its whole point. (`--fixture --prepare` writes a replayed tour to
  // the cache, so point DOCENT_CACHE_DIR somewhere else for that.)
  ...(values.prepare || !(values.fixture || values.record || values['no-cache'])
    ? { cacheDir }
    : {}),
});

if (values.prepare) await prepare(review);
else await serve(review);

/** Writes the tour to the cache, then exits: 0 if it's ready, 1 if it failed. */
async function prepare(review: Review) {
  report(review);
  await review.done;
  const ready = review.snapshot().tour.state === 'ready';
  if (ready && url) console.log(`Open it with: pnpm docent review ${url}`);
  endReason = ready ? 'prepared' : 'prepare failed';
  // Exit outright, so a lingering agent subprocess can't hang an unattended run. Flush first.
  process.stdout.write('', () => process.exit(ready ? 0 : 1));
}

async function serve(review: Review) {
  const server = await startServer({ webRoot, review, log });

  // The token rides in the URL fragment, which browsers never send to servers.
  const link = `${server.origin}/#token=${server.token}`;
  console.log(`Docent is running at ${link}`);
  if (!values['no-open'] && !process.env.CI) openBrowser(link);

  if (log.path) console.log(`This run is logged to ${log.path} (see: docent runs).`);
  report(review);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      endReason = `stopped (${signal})`;
      void server.close().then(() => process.exit(0));
    });
  }
}

/**
 * Opens this launch's run log, unless it's turned off, and records how the run starts and ends.
 * Flags are logged as given; none of them holds a secret, and the log scrubs secrets anyway.
 */
function startRunLog(): RunLog {
  if (values['no-run-log'] || runLogDisabledByEnv()) return RunLog.off();
  const ref = url ? parsePrUrl(url) : null;
  const label = ref
    ? `${ref.owner}-${ref.name}-${ref.number}`
    : `fixture-${basename(values.fixture ?? 'none')}`;
  const log = RunLog.open({ dir: runsDir, label });
  const flags = Object.fromEntries(
    Object.entries(values).filter(([k, v]) => v !== false && v !== undefined && k !== 'help'),
  );
  log.event('run.start', {
    version,
    mode: values.prepare ? 'prepare' : 'review',
    ...(url ? { pr: url } : {}),
    ...(values.fixture ? { fixture: values.fixture } : {}),
    model,
    flags,
    node: process.version,
    platform: process.platform,
  });
  const started = Date.now();
  process.on('uncaughtExceptionMonitor', (error, origin) => log.error(origin, error));
  process.on('exit', (code) => {
    log.event('run.end', { reason: endReason, exitCode: code, ms: Date.now() - started });
    log.close();
  });
  return log;
}

/** Prints the tour's outcome: its cost, or why it failed. */
function report(review: Review) {
  const started = Date.now();
  review.subscribe((tour) => {
    if (tour.state === 'ready') {
      const cost = tour.costs.reduce((sum, c) => sum + c.costMicroUsd, 0) / 1e6;
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      console.log(
        tour.cached
          ? 'Tour loaded from cache: no model calls.'
          : `Tour ready in ${seconds}s: ${tour.tour.stops.length} stops, ${tour.attempts} attempt(s), $${cost.toFixed(4)} on ${tour.model}.`,
      );
      if (tour.problems.length) console.log(`Unresolved checks:\n- ${tour.problems.join('\n- ')}`);
      const author = review.snapshot().author;
      if (author?.found) {
        console.log(`Questions go to the author's session ${author.session} (${author.via}).`);
      } else if (author) {
        console.log(`Questions go to the guide: ${author.reason}.`);
      }
    } else if (tour.state === 'failed') {
      console.error(`Tour failed: ${tour.reason}`);
    }
  });
}

function openBrowser(target: string) {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [target]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', target]]
        : ['xdg-open', [target]];
  spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true })
    .on('error', () => console.log('Could not open a browser; open the link above.'))
    .unref();
}
