// `pnpm eval:tours --prompt v2 --prompt v3`: runs each tour prompt over the public fixtures, once
// each, with real GitHub and model calls. Writes a summary report to docs/research/evals/ and
// the raw tours to Docent's cache folder. Costs real money; see packages/evals/AGENTS.md.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  defaultCacheDir,
  githubSource,
  sdkRunner,
  TOUR_PROMPT_VERSION,
  TOUR_PROMPTS,
  type TourPromptVersion,
  type Workspace,
} from '@docent/server/evals';
import { loadAdversarial, openAdversarial } from './adversarial.ts';
import { loadFixtures, PUBLIC_FIXTURES_DIR } from './fixtures.ts';
import { DEFAULT_JUDGE_MODEL, JUDGE_RUBRIC_VERSION } from './judge.ts';
import type { FixtureManifest } from './manifest.ts';
import {
  type FixtureRun,
  failedRun,
  renderMarkdown,
  runFixture,
  runNeutralCheck,
  summaryRuns,
  totals,
} from './tour-eval.ts';

const usage = `Usage: pnpm eval:tours [options]

Options:
  --prompt <v>        Tour prompt version, like v2. Repeat to compare. (default: v${TOUR_PROMPT_VERSION})
  --fixture <id>      Only this fixture. Repeat for several. (default: every public tour fixture,
                      and every adversarial one)
  --model <id>        Tour model (default: $DOCENT_MODEL or claude-opus-5-5)
  --judge-model <id>  Judge model (default: ${DEFAULT_JUDGE_MODEL})
  --budget <usd>      Start no new fixture unless spend so far, plus $0.75 held back per
                      running or new tour, stays within this (default: 12)
  --label <name>      Report name suffix (default: the prompt versions, like v2-v3)`;

const { values } = parseArgs({
  options: {
    prompt: { type: 'string', multiple: true },
    fixture: { type: 'string', multiple: true },
    model: { type: 'string' },
    'judge-model': { type: 'string' },
    budget: { type: 'string', default: '12' },
    label: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
if (values.help) {
  console.log(usage);
  process.exit(0);
}

const asked = [...new Set(values.prompt ?? [`v${TOUR_PROMPT_VERSION}`])];
const prompts = asked.map((raw) => {
  const n = Number(raw.replace(/^v/, ''));
  if (!(n in TOUR_PROMPTS)) {
    console.error(
      `No tour prompt ${raw}. Known: ${Object.keys(TOUR_PROMPTS)
        .map((k) => `v${k}`)
        .join(', ')}`,
    );
    process.exit(1);
  }
  return n as TourPromptVersion;
});
const budget = Number(values.budget);
if (!Number.isFinite(budget) || budget <= 0) {
  console.error(`--budget must be a positive number of US dollars, like 12. Got: ${values.budget}`);
  process.exit(1);
}
const model = values.model ?? process.env.DOCENT_MODEL ?? 'claude-opus-5-5';
const cacheDir = defaultCacheDir();
const judgeModel = values['judge-model'] ?? DEFAULT_JUDGE_MODEL;

const { manifests, problems } = loadFixtures(PUBLIC_FIXTURES_DIR, 'public');
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
const wanted = values.fixture;
type Opened = { workspace: Workspace; manifest: FixtureManifest; cleanup?: () => Promise<void> };
/** Each fixture to run, and how to open its PR: from GitHub, or built locally (adversarial). */
const fixtures: {
  id: string;
  /** Known before opening for a GitHub fixture, so a failure to open counts its findings missed. */
  manifest: FixtureManifest | null;
  open: () => Promise<Opened | 'moved'>;
}[] = [
  ...manifests
    .filter((m) => m.jobs.includes('tour'))
    .map((manifest) => ({
      id: manifest.id,
      manifest,
      open: async (): Promise<Opened | 'moved'> => {
        const { repo, pr } = manifest.source;
        const workspace = await githubSource(
          `https://github.com/${repo}/pull/${pr}`,
          cacheDir,
        )(() => {});
        return workspace.pr.head === manifest.source.head ? { workspace, manifest } : 'moved';
      },
    })),
  ...(await loadAdversarial()).map((fixture) => ({
    id: fixture.id,
    manifest: null,
    open: () => openAdversarial(fixture),
  })),
].filter((f) => !wanted || wanted.includes(f.id));
if (wanted && fixtures.length !== wanted.length) {
  console.error(`Unknown or non-tour fixture in: ${wanted.join(', ')}`);
  process.exit(1);
}

const date = new Date().toISOString().slice(0, 10);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const rawDir = join(cacheDir, 'evals', stamp);
await mkdir(rawDir, { recursive: true });
const judgeCwd = await mkdtemp(join(tmpdir(), 'docent-judge-'));

const runs: FixtureRun[] = [];
const spent = () => runs.reduce((sum, r) => sum + r.tourUsd + r.judgeUsd, 0);
const skipped: string[] = [];

// Fixtures run three at a time; the prompts for one fixture share its checkout.
/**
 * What one tour plus its judgment might cost, held back from the budget while it runs. Observed
 * runs cost $0.05 to $0.71; a tour that retries can cost more, so this bounds overshoot, it
 * doesn't forbid it.
 */
const RESERVE_PER_RUN_USD = 0.75;
let inFlight = 0;
const queue = [...fixtures];
async function worker() {
  for (let fixture = queue.shift(); fixture; fixture = queue.shift()) {
    // Reserve an estimate for every tour still running, so parallel workers can't all start on
    // the same stale total and overshoot together.
    if (spent() + (inFlight + prompts.length) * RESERVE_PER_RUN_USD > budget) {
      skipped.push(fixture.id);
      continue;
    }
    let opened: Opened | 'moved';
    try {
      opened = await fixture.open();
    } catch (error) {
      if (fixture.manifest) {
        for (const prompt of prompts) runs.push(failedRun(fixture.manifest, prompt, String(error)));
      } else {
        console.error(`${fixture.id}: ${String(error)}. Skipping.`);
        skipped.push(fixture.id);
      }
      continue;
    }
    if (opened === 'moved') {
      console.error(`${fixture.id}: the PR's head moved; run check:fixtures. Skipping.`);
      skipped.push(fixture.id);
      continue;
    }
    const { workspace, manifest } = opened;
    inFlight += prompts.length;
    const mine = await Promise.all(
      prompts.map(async (prompt) => {
        const run = await runFixture({
          manifest,
          workspace,
          prompt,
          runner: sdkRunner,
          model,
          judgeModel,
          judgeCwd,
        });
        runs.push(run);
        inFlight--;
        return run;
      }),
    );
    // One blind list per fixture, mixing every prompt's first sentences.
    const neutralError = await runNeutralCheck({
      runs: mine,
      prTitle: workspace.pr.title,
      runner: sdkRunner,
      judgeModel,
      judgeCwd,
    });
    if (neutralError) console.error(`${manifest.id}: ${neutralError}`);
    await opened.cleanup?.();
    for (const run of mine) {
      await writeFile(
        join(rawDir, `${manifest.id}-v${run.prompt}.json`),
        JSON.stringify(run, null, 2),
      );
      const cost = `$${(run.tourUsd + run.judgeUsd).toFixed(2)}`;
      const what =
        run.status === 'ok'
          ? `${run.findings.filter((f) => f.explained).length}/${run.findings.length} explained, ${run.stops.filter((g) => g.judged.unfoundedOpinion).length} opinions`
          : `failed: ${run.error}`;
      console.error(
        `${manifest.id} v${run.prompt}: ${what}, ${cost} (total $${spent().toFixed(2)})`,
      );
    }
  }
}
await Promise.all([worker(), worker(), worker()]);

const order = (r: FixtureRun) => fixtures.findIndex((f) => f.id === r.fixture) * 100 + r.prompt;
runs.sort((a, b) => order(a) - order(b));

const label = values.label ?? prompts.map((p) => `v${p}`).join('-');
const outDir = join(import.meta.dirname, '..', '..', '..', 'docs', 'research', 'evals');
await mkdir(outDir, { recursive: true });
const name = `${date}-tours-${label}`;
const report = { date, model, judgeModel, judgeRubric: JUDGE_RUBRIC_VERSION, runs, prompts };
let markdown = renderMarkdown(report);
if (skipped.length) {
  markdown += `\nNot run (budget of $${budget} reached, or the PR moved): ${skipped.join(', ')}.\n`;
}
await writeFile(join(outDir, `${name}.md`), markdown);
await writeFile(
  join(outDir, `${name}.json`),
  `${JSON.stringify(
    {
      date,
      model,
      judgeModel,
      judgeRubric: JUDGE_RUBRIC_VERSION,
      totals: prompts.map((p) => totals(runs, p)),
      runs: summaryRuns(runs),
      skipped,
    },
    null,
    2,
  )}\n`,
);
console.log(markdown);
console.log(`Report: docs/research/evals/${name}.md\nRaw tours: ${rawDir}`);
