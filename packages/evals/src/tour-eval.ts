// The tour eval: runs the server's real tour job over fixtures, then scores each tour on defects
// found, cost, and stop quality. GitHub and the model sit behind injected boundaries, so tests
// replay recorded output and never make a call.
import { parseUnifiedDiff } from '@docent/core';
import {
  AgentError,
  type AgentRunner,
  generateTour,
  TourError,
  type TourPromptVersion,
  type TourView,
  type Workspace,
} from '@docent/server/evals';
import {
  type FindingGrade,
  isGradedStop,
  type Judgment,
  judgeTour,
  type StopGrade,
} from './judge.ts';
import { type FixtureManifest, scoringFor } from './manifest.ts';
import { type StopQuality, stopQuality } from './stop-quality.ts';

export type FindingResult = {
  file: string;
  lines: { start: number; end: number };
  /** Needs facts the diff and repo can't show, so it's reported apart from the rest. */
  externalKnowledge: boolean;
  /** Some stop cites lines overlapping the finding (the manifest's scoring, with tolerance). */
  cited: boolean;
  /** The judge says a stop states the defect or points the reviewer at it. */
  surfaced: boolean;
};

export type GradedStop = {
  stop: number;
  kind: string;
  title: string;
  mechanical: StopQuality;
  judged: Pick<StopGrade, 'behaviorFirst' | 'namesCheck' | 'why'>;
};

type RunBase = { fixture: string; prompt: TourPromptVersion; tourUsd: number; judgeUsd: number };

export type FixtureRun =
  | (RunBase & {
      status: 'ok';
      stopCount: number;
      maxStops: number;
      /** Checker problems left after the last retry. Zero means the tour passed every check. */
      problemsLeft: number;
      attempts: number;
      findings: FindingResult[];
      /** Only for fixtures that exercise the danger job. */
      danger: { expected: boolean; raised: boolean } | null;
      stops: GradedStop[];
      /** The full tour and judgment, for the raw dump. Left out of the committed summary. */
      raw: { tour: TourView; judgment: Judgment };
    })
  | (RunBase & { status: 'failed'; error: string });

const usd = (records: readonly { costMicroUsd: number }[]) =>
  records.reduce((sum, r) => sum + r.costMicroUsd, 0) / 1e6;

export type RunOptions = {
  manifest: FixtureManifest;
  workspace: Workspace;
  prompt: TourPromptVersion;
  runner: AgentRunner;
  model: string;
  judgeModel: string;
  /** An empty folder for the judge, which needs no files. */
  judgeCwd: string;
};

/** One tour, one judgment, one scored result. Never throws: a failure is a result too. */
export async function runFixture(options: RunOptions): Promise<FixtureRun> {
  const { manifest, workspace, prompt, runner } = options;
  const base = { fixture: manifest.id, prompt, tourUsd: 0, judgeUsd: 0 };
  const diff = parseUnifiedDiff(workspace.diffText, workspace.pr.base, workspace.pr.head);

  let outcome: Awaited<ReturnType<typeof generateTour>>;
  try {
    outcome = await generateTour({
      workspace,
      diff,
      runner,
      model: options.model,
      promptVersion: prompt,
      onProgress: () => {},
    });
  } catch (error) {
    const tourUsd = error instanceof TourError ? usd(error.costs) : 0;
    return { ...base, tourUsd, status: 'failed', error: String(error) };
  }
  const tourUsd = usd(outcome.costs);
  const { tour } = outcome;

  let judgment: Judgment;
  try {
    judgment = await judgeTour({
      runner,
      model: options.judgeModel,
      cwd: options.judgeCwd,
      pr: workspace.pr,
      tour,
      findings: manifest.expectedFindings,
    });
  } catch (error) {
    const judgeUsd = error instanceof AgentError ? usd([error.cost]) : 0;
    return { ...base, tourUsd, judgeUsd, status: 'failed', error: `Judge: ${String(error)}` };
  }

  const scoring = scoringFor(manifest);
  const findings = manifest.expectedFindings.map((finding, i) => {
    const from = finding.lines.start - scoring.toleranceLines;
    const to = finding.lines.end + scoring.toleranceLines;
    const cited = tour.stops.some((stop) =>
      stop.anchors.some(
        (a) =>
          a.side === 'new' && a.path === finding.file && a.startLine <= to && a.endLine >= from,
      ),
    );
    const grade: FindingGrade | undefined = judgment.findings[i];
    return {
      file: finding.file,
      lines: finding.lines,
      externalKnowledge: finding.externalKnowledge !== undefined,
      cited,
      surfaced: grade?.surfaced ?? false,
    };
  });

  const stops = tour.stops.flatMap((stop, i): GradedStop[] => {
    if (!isGradedStop(stop)) return [];
    const grade = judgment.stops.find((g) => g.stop === i + 1);
    if (!grade) return [];
    const { behaviorFirst, namesCheck, why } = grade;
    return [
      {
        stop: i + 1,
        kind: stop.kind,
        title: stop.title,
        mechanical: stopQuality(stop.body),
        judged: { behaviorFirst, namesCheck, why },
      },
    ];
  });

  return {
    ...base,
    tourUsd,
    judgeUsd: usd([judgment.cost]),
    status: 'ok',
    stopCount: tour.stops.length,
    maxStops: scoring.maxStops,
    problemsLeft: outcome.problems.length,
    attempts: outcome.attempts,
    findings,
    danger: manifest.jobs.includes('danger')
      ? {
          expected: manifest.expectDangerFlag,
          raised: tour.stops.some((s) => s.flags.includes('danger')),
        }
      : null,
    stops,
    raw: { tour, judgment },
  };
}

// ---- Totals and the report ----

export type PromptTotals = {
  prompt: TourPromptVersion;
  fixtures: number;
  failed: number;
  /** Findings that need no outside knowledge. The headline defect numbers. */
  findings: { expected: number; cited: number; surfaced: number };
  externalFindings: { expected: number; cited: number; surfaced: number };
  /** Danger flags on fixtures that expect none, and expected ones that were missed. */
  danger: { falseAlarms: number; missed: number };
  overLongTours: number;
  stops: number;
  /** Shares of graded stops, 0 to 1. */
  quality: {
    plainFirstSentence: number;
    withinLength: number;
    behaviorFirst: number;
    namesCheck: number;
  };
  tourUsd: number;
  judgeUsd: number;
};

const share = (count: number, total: number) => (total === 0 ? 0 : count / total);

export function totals(runs: readonly FixtureRun[], prompt: TourPromptVersion): PromptTotals {
  const mine = runs.filter((r) => r.prompt === prompt);
  const ok = mine.flatMap((r) => (r.status === 'ok' ? [r] : []));
  const findings = ok.flatMap((r) => r.findings);
  const count = (list: FindingResult[]) => ({
    expected: list.length,
    cited: list.filter((f) => f.cited).length,
    surfaced: list.filter((f) => f.surfaced).length,
  });
  const stops = ok.flatMap((r) => r.stops);
  const rate = (pick: (s: GradedStop) => boolean) => share(stops.filter(pick).length, stops.length);
  return {
    prompt,
    fixtures: mine.length,
    failed: mine.length - ok.length,
    findings: count(findings.filter((f) => !f.externalKnowledge)),
    externalFindings: count(findings.filter((f) => f.externalKnowledge)),
    danger: {
      falseAlarms: ok.filter((r) => r.danger && !r.danger.expected && r.danger.raised).length,
      missed: ok.filter((r) => r.danger?.expected && !r.danger.raised).length,
    },
    overLongTours: ok.filter((r) => r.stopCount > r.maxStops).length,
    stops: stops.length,
    quality: {
      plainFirstSentence: rate((s) => !s.mechanical.codeInFirstSentence),
      withinLength: rate((s) => s.mechanical.withinLength),
      behaviorFirst: rate((s) => s.judged.behaviorFirst),
      namesCheck: rate((s) => s.judged.namesCheck),
    },
    tourUsd: mine.reduce((sum, r) => sum + r.tourUsd, 0),
    judgeUsd: mine.reduce((sum, r) => sum + r.judgeUsd, 0),
  };
}

/** The committed summary: everything but the raw tours and judgments. */
export function summaryRuns(runs: readonly FixtureRun[]) {
  return runs.map((run) => {
    if (run.status !== 'ok') return run;
    const { raw: _raw, ...rest } = run;
    return rest;
  });
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const money = (n: number) => `$${n.toFixed(2)}`;

export function renderMarkdown(input: {
  date: string;
  model: string;
  judgeModel: string;
  judgeRubric: number;
  runs: readonly FixtureRun[];
  prompts: readonly TourPromptVersion[];
}): string {
  const all = input.prompts.map((p) => totals(input.runs, p));
  const head = `| | ${input.prompts.map((p) => `v${p}`).join(' | ')} |\n|---|${input.prompts.map(() => '---').join('|')}|`;
  const row = (label: string, cell: (t: PromptTotals) => string) =>
    `| ${label} | ${all.map(cell).join(' | ')} |`;

  const fixtures = [...new Set(input.runs.map((r) => r.fixture))];
  const perFixture = fixtures.map((id) => {
    const cells = input.prompts.map((p) => {
      const run = input.runs.find((r) => r.fixture === id && r.prompt === p);
      if (!run) return 'not run';
      if (run.status === 'failed') return `failed (${money(run.tourUsd)})`;
      const found = run.findings.length
        ? `${run.findings.filter((f) => f.surfaced).length}/${run.findings.length} surfaced, ${run.findings.filter((f) => f.cited).length}/${run.findings.length} cited`
        : 'no defects';
      const s = run.stops;
      const n = (pick: (g: GradedStop) => boolean) => `${s.filter(pick).length}/${s.length}`;
      return `${found}; behavior-first ${n((g) => g.judged.behaviorFirst)}, names check ${n((g) => g.judged.namesCheck)}, plain first ${n((g) => !g.mechanical.codeInFirstSentence)}; ${run.stopCount} stops; ${money(run.tourUsd + run.judgeUsd)}`;
    });
    return `| ${id} | ${cells.join(' | ')} |`;
  });

  return `# Tour eval, ${input.date}

Tour model \`${input.model}\`, judge \`${input.judgeModel}\` (rubric v${input.judgeRubric}). One run per fixture and prompt. Generated by \`pnpm eval:tours\`; see [\`packages/evals/AGENTS.md\`](../../../packages/evals/AGENTS.md).

## Totals

${head}
${row('Defects surfaced (judge)', (t) => `${t.findings.surfaced}/${t.findings.expected}`)}
${row('Defects cited (line overlap)', (t) => `${t.findings.cited}/${t.findings.expected}`)}
${row('External-knowledge defects surfaced', (t) => `${t.externalFindings.surfaced}/${t.externalFindings.expected}`)}
${row('Danger flags: false alarms / missed', (t) => `${t.danger.falseAlarms} / ${t.danger.missed}`)}
${row('Graded stops', (t) => `${t.stops}`)}
${row('First sentence names no code (script)', (t) => pct(t.quality.plainFirstSentence))}
${row('Within length (script)', (t) => pct(t.quality.withinLength))}
${row('First sentence states the behavior change (judge)', (t) => pct(t.quality.behaviorFirst))}
${row('Names what to check, or says nothing needs it (judge)', (t) => pct(t.quality.namesCheck))}
${row('Tours over the stop cap', (t) => `${t.overLongTours}`)}
${row('Failed runs', (t) => `${t.failed}/${t.fixtures}`)}
${row('Tour cost', (t) => money(t.tourUsd))}
${row('Judge cost', (t) => money(t.judgeUsd))}

## Per fixture

| Fixture | ${input.prompts.map((p) => `v${p}`).join(' | ')} |
|---|${input.prompts.map(() => '---').join('|')}|
${perFixture.join('\n')}
`;
}
