// `pnpm eval:updates`: measures tour updates (issue #65). For each push sequence, a whole tour
// is written at the earlier head, then the later head's tour is written twice: as an update of
// the earlier one, and whole, to compare. The push sequences are this repo's own PRs, fetched
// at the exact commits. Adversarial fixtures with a first push (the hidden change arrives in
// the second) are scored on whether the update still routes and flags it. Costs real money.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { type CommitSha, commitSha, parseUnifiedDiff } from '@docent/core';
import {
  basisFor,
  commitReader,
  defaultCacheDir,
  generateTour,
  git,
  planUpdate,
  proveForReview,
  sdkRunner,
  TOUR_PROMPT_VERSION,
  type UpdatePlan,
  type Workspace,
} from '@docent/server/evals';
import { loadAdversarial, openAdversarial } from './adversarial.ts';
import { DEFAULT_JUDGE_MODEL } from './judge.ts';
import type { FixtureManifest } from './manifest.ts';
import { type FixtureRun, runFixture } from './tour-eval.ts';

const usage = `Usage: pnpm eval:updates [options]

Options:
  --only <id>         Only this sequence (like docent-108) or adversarial fixture. Repeat for several.
  --model <id>        Tour model (default: $DOCENT_MODEL or claude-opus-5-5)
  --budget <usd>      Start no new sequence once spend plus $1.50 would pass this (default: 10)`;

/** Review-then-fix pushes on this repo's own PRs: the head a tour was written at, then the fix. */
const SEQUENCES = [
  {
    pr: 92,
    from: '686562b4eaa33f9d5946a49cff3f7f634c230a01',
    to: '5747ba321846870f733e8c312cbc284f4a976d20',
  },
  {
    pr: 108,
    from: '2ce4f8f9aab7d37008792b5e5e0367761977f206',
    to: 'f17858bdf0160659b10c7fb98e303b9fc8dd68b3',
  },
  {
    pr: 109,
    from: '9acaf575cf2ca14f94504a8db97af7613b627f3c',
    to: 'c1ea78e9e12f594323af3e59fb84d6fead825ae7',
  },
] as const;
const REPO = 'hartz89/docent' as const;

const { values } = parseArgs({
  options: {
    only: { type: 'string', multiple: true },
    model: { type: 'string' },
    budget: { type: 'string', default: '10' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
if (values.help) {
  console.log(usage);
  process.exit(0);
}
const model = values.model ?? process.env.DOCENT_MODEL ?? 'claude-opus-5-5';
const budget = Number(values.budget);
const judgeModel = DEFAULT_JUDGE_MODEL;
const judgeCwd = await mkdtemp(join(tmpdir(), 'docent-judge-'));
const reposDir = join(defaultCacheDir(), 'evals', 'update-repos');

const gh = async (args: readonly string[]) =>
  (await promisify(execFile)('gh', args, { maxBuffer: 1 << 26 })).stdout;

/** One PR at an exact head, checked out read-only the way the server checks a PR out. */
async function openAt(
  pr: Omit<Workspace['pr'], 'base' | 'head'>,
  base: CommitSha,
  head: CommitSha,
): Promise<Workspace> {
  const dir = join(reposDir, head);
  const ready = join(dir, '.git', 'docent-eval-ready');
  if (!existsSync(ready)) {
    await mkdir(dir, { recursive: true });
    await git(dir, ['init', '--quiet']);
    await git(dir, ['remote', 'add', 'origin', `https://github.com/${REPO}.git`]);
    await git(dir, [
      'fetch',
      '--quiet',
      '--depth=1',
      '--filter=blob:none',
      '--no-recurse-submodules',
      'origin',
      base,
      head,
    ]);
    await git(dir, ['checkout', '--quiet', '--detach', head]);
    await writeFile(ready, '');
  }
  const diffText = (await git(dir, ['diff', '--no-color', base, head])).stdout;
  return {
    pr: { ...pr, base, head },
    diffText,
    commitMessages: [],
    headInBaseRepo: true,
    dir,
    ...commitReader(dir, base, head),
    current: async () => ({ head, baseRef: pr.baseRef }),
    postReview: async () => {
      throw new Error('An eval never posts a review.');
    },
  };
}

type Sequence = {
  id: string;
  from: Workspace;
  to: Workspace;
  manifest: FixtureManifest;
  cleanup?: () => Promise<void>;
};

async function realSequence(seq: (typeof SEQUENCES)[number]): Promise<Sequence> {
  const view = JSON.parse(
    await gh([
      'pr',
      'view',
      String(seq.pr),
      '--repo',
      REPO,
      '--json',
      'number,title,body,author,baseRefName,headRefName,url',
    ]),
  ) as {
    number: number;
    title: string;
    body: string;
    author: { login: string };
    baseRefName: string;
    headRefName: string;
    url: string;
  };
  const mergeBase = async (head: string) =>
    commitSha(
      (
        await gh(['api', `repos/${REPO}/compare/main...${head}`, '--jq', '.merge_base_commit.sha'])
      ).trim(),
    );
  const pr = {
    url: view.url,
    repo: REPO,
    number: view.number,
    title: view.title,
    body: view.body,
    author: view.author.login,
    baseRef: view.baseRefName,
    headRef: view.headRefName,
  };
  const from = await openAt(pr, await mergeBase(seq.from), commitSha(seq.from));
  const to = await openAt(pr, await mergeBase(seq.to), commitSha(seq.to));
  const id = `docent-${seq.pr}`;
  const manifest: FixtureManifest = {
    id,
    visibility: 'public',
    source: { repo: REPO, pr: seq.pr, base: to.pr.base, head: to.pr.head },
    license: 'Apache-2.0',
    title: view.title,
    size: 'medium',
    jobs: ['tour'],
    negativeControl: true,
    expectedFindings: [],
    mustNotSkip: [],
    expectDangerFlag: false,
    evidence: [],
  };
  return { id, from, to, manifest };
}

type Measured = {
  usd: number;
  firstStopMs: number | null;
  tourMs: number;
  attempts: number;
  problemsLeft: number;
  stops: number;
  /** Stops written for the update; zero for a whole tour. */
  newStops: number;
  /** Graded stops whose first sentence states the behavior change, per the judge. */
  behaviorFirst: string;
  unfounded: number;
  /** Graded stops within the mechanical limits, with no code in the first sentence. */
  mechanical: string;
  ledger: { onRoute: number; provenSkip: number; notOnRoute: number };
  explained: string | null;
  hiddenOffRoute: number | null;
  danger: boolean | null;
};

function measured(run: FixtureRun): Measured | string {
  if (run.status !== 'ok') return run.error;
  const graded = run.stops.length;
  const share = (n: number) => `${n}/${graded}`;
  const hasFindings = run.findings.length > 0;
  return {
    usd: run.tourUsd,
    firstStopMs: run.speed.firstStopMs,
    tourMs: run.speed.tourMs,
    attempts: run.attempts,
    problemsLeft: run.problemsLeft,
    stops: run.stopCount,
    newStops: run.raw.tour.stops.filter((s) => s.updated).length,
    behaviorFirst: share(run.stops.filter((s) => s.judged.behaviorFirst).length),
    unfounded: run.stops.filter((s) => s.judged.unfoundedOpinion).length,
    mechanical: share(
      run.stops.filter((s) => s.mechanical.withinLength && !s.mechanical.codeInFirstSentence)
        .length,
    ),
    ledger: run.ledger,
    explained: hasFindings
      ? `${run.findings.filter((f) => f.explained).length}/${run.findings.length}`
      : null,
    hiddenOffRoute: hasFindings ? run.important.offRoute : null,
    danger: run.danger ? run.danger.raised : null,
  };
}

type Result = {
  id: string;
  /** The earlier head's whole tour, which the update starts from. */
  first: { usd: number; tourMs: number; stops: number } | string;
  plan: { kept: number; stale: number; movedLines: number; changedLines: number } | null;
  updated: Measured | string | null;
  fresh: Measured | string;
};

const usdOf = (costs: readonly { costMicroUsd: number }[]) =>
  costs.reduce((sum, c) => sum + c.costMicroUsd, 0) / 1e6;

async function runSequence(seq: Sequence): Promise<{ result: Result; usd: number }> {
  let usd = 0;
  const parse = (w: Workspace) => parseUnifiedDiff(w.diffText, w.pr.base, w.pr.head);
  const fromDiff = parse(seq.from);
  const toDiff = parse(seq.to);
  const started = Date.now();
  let first: Result['first'];
  let plan: UpdatePlan | null = null;
  try {
    const tour = await generateTour({
      workspace: seq.from,
      diff: fromDiff,
      runner: sdkRunner,
      model,
      proofs: proveForReview(seq.from, fromDiff),
      onProgress: () => {},
    });
    usd += usdOf(tour.costs);
    first = { usd: usdOf(tour.costs), tourMs: Date.now() - started, stops: tour.tour.stops.length };
    const basis = await basisFor(tour.tour, fromDiff, seq.from.pr, seq.from.readFile);
    plan = await planUpdate(basis, seq.to.pr, toDiff, seq.to.readFile);
  } catch (error) {
    first = String(error);
  }
  const common = {
    manifest: seq.manifest,
    workspace: seq.to,
    prompt: TOUR_PROMPT_VERSION,
    runner: sdkRunner,
    model,
    judgeModel,
    judgeCwd,
  };
  // One after the other, so neither slows the other down.
  const updated = plan ? await runFixture({ ...common, update: plan }) : null;
  const fresh = await runFixture(common);
  for (const run of [updated, fresh]) if (run) usd += run.tourUsd + run.judgeUsd;
  const changedLines = toDiff.files
    .flatMap((f) => f.hunks.flatMap((h) => h.lines))
    .filter((l) => l.kind !== 'context').length;
  return {
    usd,
    result: {
      id: seq.id,
      first,
      plan: plan && {
        kept: plan.stops.filter((s) => s.state === 'kept').length,
        stale: plan.stops.filter((s) => s.state === 'stale').length,
        movedLines: plan.moved.length,
        changedLines,
      },
      updated: updated && measured(updated),
      fresh: measured(fresh),
    },
  };
}

const wanted = values.only;
const pick = (id: string) => !wanted || wanted.includes(id);
const pending: (() => Promise<Sequence>)[] = [
  ...SEQUENCES.filter((s) => pick(`docent-${s.pr}`)).map((s) => () => realSequence(s)),
  ...(await loadAdversarial())
    .filter((f) => f.firstPush && pick(f.id))
    .map((fixture) => async () => {
      const { workspace, manifest, first, cleanup } = await openAdversarial(fixture);
      if (!first) throw new Error(`${fixture.id} has no first push`);
      return { id: fixture.id, from: first, to: workspace, manifest, cleanup };
    }),
];

const results: Result[] = [];
let spent = 0;
for (const open of pending) {
  if (spent + 1.5 > budget) {
    console.error(`Budget of $${budget} reached; stopping.`);
    break;
  }
  const seq = await open();
  try {
    const { result, usd } = await runSequence(seq);
    spent += usd;
    results.push(result);
    console.error(`${seq.id}: $${usd.toFixed(2)} (total $${spent.toFixed(2)})`);
  } finally {
    await seq.cleanup?.();
  }
}

const secs = (ms: number | null) => (ms === null ? '–' : `${(ms / 1000).toFixed(1)}s`);
const row = (id: string, tour: string, m: Measured | string | null) =>
  m === null
    ? `| ${id} | ${tour} | no update planned |||||||||||`
    : typeof m === 'string'
      ? `| ${id} | ${tour} | failed: ${m.replace(/\|/g, '/')} |||||||||||`
      : `| ${id} | ${tour} | $${m.usd.toFixed(3)} | ${secs(m.firstStopMs)} | ${secs(m.tourMs)} | ${m.attempts} | ${m.problemsLeft} | ${m.stops} (${m.newStops} new) | ${m.behaviorFirst} | ${m.unfounded} | ${m.mechanical} | ${m.explained ?? '–'} | ${m.hiddenOffRoute ?? '–'} | ${m.danger ?? '–'} |`;
const date = new Date().toISOString().slice(0, 10);
const lines = [
  `# Tour updates against whole tours, ${date}`,
  '',
  `Model ${model}, prompt v${TOUR_PROMPT_VERSION}, judge ${judgeModel}. One run each. Total spend $${spent.toFixed(2)}.`,
  '',
  '| Sequence | Tour | Cost | First stop | Whole tour | Attempts | Problems left | Stops | Behavior first | Unfounded | Mechanical | Explained | Hidden off route | Danger flag |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
];
for (const r of results) {
  const plan = r.plan
    ? `${r.plan.kept} kept, ${r.plan.stale} stale, ${r.plan.movedLines}/${r.plan.changedLines} lines new`
    : 'no plan';
  const first = typeof r.first === 'string' ? `failed: ${r.first}` : `$${r.first.usd.toFixed(3)}`;
  lines.push(`| ${r.id} | earlier head, whole (${plan}) | ${first} |||||||||||`);
  lines.push(row(r.id, 'update', r.updated));
  lines.push(row(r.id, 'whole', r.fresh));
}
const markdown = `${lines.join('\n')}\n`;
const outDir = join(import.meta.dirname, '..', '..', '..', 'docs', 'research', 'evals');
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, `${date}-tour-updates.md`), markdown);
await writeFile(
  join(outDir, `${date}-tour-updates.json`),
  `${JSON.stringify({ date, model, judgeModel, spent, results }, null, 2)}\n`,
);
console.log(markdown);
