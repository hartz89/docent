// The tour eval: runs the server's real tour job over fixtures, then scores each tour on defects
// found, cost, and stop quality. GitHub and the model sit behind injected boundaries, so tests
// replay recorded output and never make a call.
import { type LedgerLine, parseUnifiedDiff } from '@docent/core';
import {
  AgentError,
  type AgentRunner,
  generateTour,
  placeLines,
  proveForReview,
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
import { neutralCheck } from './neutral.ts';
import { type StopQuality, stopQuality } from './stop-quality.ts';

export type FindingResult = {
  file: string;
  lines: { start: number; end: number };
  /** Needs facts the diff and repo can't show, so it's reported apart from the rest. */
  externalKnowledge: boolean;
  /** Some stop cites lines overlapping the finding (the manifest's scoring, with tolerance). */
  cited: boolean;
  /**
   * The judge says a stop explains the behavior where the defect lives, clearly enough to see the
   * problem, and that stop cites the defect's lines (with tolerance). Calling it a problem isn't
   * required.
   */
  explained: boolean;
};

export type GradedStop = {
  stop: number;
  kind: string;
  title: string;
  mechanical: StopQuality;
  judged: Pick<StopGrade, 'behaviorFirst' | 'unfoundedOpinion' | 'why'>;
  /** The neutral check's answer for the first sentence, or null if it didn't run. */
  neutralClear: boolean | null;
};

type RunBase = {
  fixture: string;
  prompt: TourPromptVersion;
  tourUsd: number;
  judgeUsd: number;
  /** Every expected finding. A failed run keeps them all, as not found, so totals never shrink. */
  findings: FindingResult[];
};

export type FixtureRun =
  | (RunBase & {
      status: 'ok';
      stopCount: number;
      maxStops: number;
      /** Checker problems left after the last retry. Zero means the tour passed every check. */
      problemsLeft: number;
      /** One plus the retries. */
      attempts: number;
      /** The skip ledger: where every changed line stands (core's L1–L4). */
      ledger: { onRoute: number; provenSkip: number; notOnRoute: number };
      /**
       * Changed lines inside the manifest's `mustNotSkip` ranges, and how many of them aren't on
       * the route (proven skip or not on the route). Target zero. `flagged`: a stop that cites
       * one of them carries a danger or mismatch flag.
       */
      important: { lines: number; offRoute: number; flagged: boolean };
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

/** Every expected finding, none found yet. */
const notFound = (manifest: FixtureManifest): FindingResult[] =>
  manifest.expectedFindings.map((finding) => ({
    file: finding.file,
    lines: finding.lines,
    externalKnowledge: finding.externalKnowledge !== undefined,
    cited: false,
    explained: false,
  }));

/** A run that produced nothing to score. Its findings all count as not found. */
export function failedRun(
  manifest: FixtureManifest,
  prompt: TourPromptVersion,
  error: string,
): FixtureRun {
  const findings = notFound(manifest);
  return {
    fixture: manifest.id,
    prompt,
    tourUsd: 0,
    judgeUsd: 0,
    findings,
    status: 'failed',
    error,
  };
}

/** One tour, one judgment, one scored result. Never throws: a failure is a result too. */
export async function runFixture(options: RunOptions): Promise<FixtureRun> {
  const { manifest, workspace, prompt, runner } = options;
  const base = {
    fixture: manifest.id,
    prompt,
    tourUsd: 0,
    judgeUsd: 0,
    findings: notFound(manifest),
  };
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

  let lines: readonly LedgerLine[];
  try {
    lines = await placeLines(diff, tour, await proveForReview(workspace, diff), workspace.readFile);
  } catch (error) {
    return { ...base, tourUsd, status: 'failed', error: `Ledger: ${String(error)}` };
  }
  const placed = (kind: LedgerLine['place']['kind']) =>
    lines.filter((l) => l.place.kind === kind).length;
  const important = lines.filter(
    ({ line }) =>
      line.side === 'new' &&
      manifest.mustNotSkip.some(
        (m) => m.file === line.path && line.line >= m.lines.start && line.line <= m.lines.end,
      ),
  );
  const flaggedStops = new Set(tour.stops.filter((s) => s.flags.length > 0).map((s) => s.id));

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
  const findings = manifest.expectedFindings.map((finding, i): FindingResult => {
    const from = finding.lines.start - scoring.toleranceLines;
    const to = finding.lines.end + scoring.toleranceLines;
    const citesIt = (stop: TourView['stops'][number] | undefined) =>
      stop?.anchors.some(
        (a) =>
          a.side === 'new' && a.path === finding.file && a.startLine <= to && a.endLine >= from,
      ) ?? false;
    const grade: FindingGrade | undefined = judgment.findings[i];
    const explainer = grade?.stop ? tour.stops[grade.stop - 1] : undefined;
    return {
      file: finding.file,
      lines: finding.lines,
      externalKnowledge: finding.externalKnowledge !== undefined,
      cited: tour.stops.some(citesIt),
      explained: (grade?.explained ?? false) && citesIt(explainer),
    };
  });

  const stops = tour.stops.flatMap((stop, i): GradedStop[] => {
    if (!isGradedStop(stop)) return [];
    const grade = judgment.stops.find((g) => g.stop === i + 1);
    if (!grade) return [];
    const { behaviorFirst, unfoundedOpinion, why } = grade;
    return [
      {
        stop: i + 1,
        kind: stop.kind,
        title: stop.title,
        mechanical: stopQuality(stop.body),
        judged: { behaviorFirst, unfoundedOpinion, why },
        neutralClear: null,
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
    ledger: {
      onRoute: placed('on_route'),
      provenSkip: placed('proven_skip'),
      notOnRoute: placed('not_on_route'),
    },
    important: {
      lines: important.length,
      offRoute: important.filter((l) => l.place.kind !== 'on_route').length,
      flagged: important.some(
        (l) => l.place.kind === 'on_route' && l.place.stops.some((id) => flaggedStops.has(id)),
      ),
    },
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

/**
 * The neutral check for one fixture: every prompt's first sentences, mixed in one blind list.
 * Fills in each graded stop's `neutralClear`, and splits the call's cost evenly over the runs.
 * Never throws: on failure the answers stay null and the error comes back.
 */
export async function runNeutralCheck(input: {
  runs: readonly FixtureRun[];
  prTitle: string;
  runner: AgentRunner;
  judgeModel: string;
  judgeCwd: string;
}): Promise<string | null> {
  const ok = input.runs.flatMap((r) => (r.status === 'ok' ? [r] : []));
  const items = ok.flatMap((run) =>
    run.stops.map((s) => ({
      key: `${run.prompt}:${s.stop}`,
      sentence: s.mechanical.firstSentence,
    })),
  );
  if (!items.length) return null;
  const charge = (total: number) => {
    for (const run of ok) run.judgeUsd += total / ok.length;
  };
  try {
    const { clear, cost } = await neutralCheck({
      runner: input.runner,
      model: input.judgeModel,
      cwd: input.judgeCwd,
      prTitle: input.prTitle,
      items,
    });
    charge(usd([cost]));
    for (const run of ok) {
      for (const s of run.stops) s.neutralClear = clear.get(`${run.prompt}:${s.stop}`) ?? null;
    }
    return null;
  } catch (error) {
    if (error instanceof AgentError) charge(usd([error.cost]));
    return `Neutral check: ${String(error)}`;
  }
}

// ---- Totals and the report ----

export type PromptTotals = {
  prompt: TourPromptVersion;
  fixtures: number;
  failed: number;
  /** Findings that need no outside knowledge. The headline defect numbers. */
  findings: { expected: number; cited: number; explained: number };
  externalFindings: { expected: number; cited: number; explained: number };
  /** Danger flags on fixtures that expect none, and expected ones that were missed. */
  danger: { falseAlarms: number; missed: number };
  overLongTours: number;
  stops: number;
  /** Graded stops with review advice or an unbacked concern. Target zero. */
  unfoundedOpinions: number;
  /** Shares of graded stops, 0 to 1. */
  quality: {
    plainFirstSentence: number;
    withinLength: number;
    behaviorFirst: number;
  };
  /** The neutral check: first sentences a blind reader found clear, of those it read. */
  neutral: { clear: number; read: number };
  /** Retries over every tour that ran, and how many tours needed one. */
  retries: { total: number; tours: number; ran: number };
  /** Changed lines summed over the tours that ran, by where the ledger put them. */
  ledger: { onRoute: number; provenSkip: number; notOnRoute: number };
  /** `mustNotSkip` lines not on the route, of all of them. Target zero. */
  important: { lines: number; offRoute: number };
  tourUsd: number;
  judgeUsd: number;
};

const share = (count: number, total: number) => (total === 0 ? 0 : count / total);

export function totals(runs: readonly FixtureRun[], prompt: TourPromptVersion): PromptTotals {
  const mine = runs.filter((r) => r.prompt === prompt);
  const ok = mine.flatMap((r) => (r.status === 'ok' ? [r] : []));
  // Failed runs count too: their findings are all "not found".
  const findings = mine.flatMap((r) => r.findings);
  const count = (list: FindingResult[]) => ({
    expected: list.length,
    cited: list.filter((f) => f.cited).length,
    explained: list.filter((f) => f.explained).length,
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
    unfoundedOpinions: stops.filter((s) => s.judged.unfoundedOpinion).length,
    quality: {
      plainFirstSentence: rate((s) => !s.mechanical.codeInFirstSentence),
      withinLength: rate((s) => s.mechanical.withinLength),
      behaviorFirst: rate((s) => s.judged.behaviorFirst),
    },
    neutral: {
      clear: stops.filter((s) => s.neutralClear === true).length,
      read: stops.filter((s) => s.neutralClear !== null).length,
    },
    retries: {
      total: ok.reduce((sum, r) => sum + r.attempts - 1, 0),
      tours: ok.filter((r) => r.attempts > 1).length,
      ran: ok.length,
    },
    ledger: {
      onRoute: ok.reduce((sum, r) => sum + r.ledger.onRoute, 0),
      provenSkip: ok.reduce((sum, r) => sum + r.ledger.provenSkip, 0),
      notOnRoute: ok.reduce((sum, r) => sum + r.ledger.notOnRoute, 0),
    },
    important: {
      lines: ok.reduce((sum, r) => sum + r.important.lines, 0),
      offRoute: ok.reduce((sum, r) => sum + r.important.offRoute, 0),
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

/** Marks a headline count that includes failed runs, whose defects count as missed. */
const failedMark = (t: PromptTotals) =>
  t.failed ? ` (${t.failed} failed run${t.failed === 1 ? '' : 's'}, counted as missed)` : '';
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
      if (run.status === 'failed') {
        const defects = run.findings.length
          ? `, ${run.findings.length} defect(s) counted as missed`
          : '';
        return `**failed**${defects}: ${run.error.slice(0, 80)}; ${money(run.tourUsd + run.judgeUsd)}`;
      }
      const found = run.findings.length
        ? `${run.findings.filter((f) => f.explained).length}/${run.findings.length} explained, ${run.findings.filter((f) => f.cited).length}/${run.findings.length} cited`
        : 'no defects';
      const s = run.stops;
      const n = (pick: (g: GradedStop) => boolean) => `${s.filter(pick).length}/${s.length}`;
      const read = s.filter((g) => g.neutralClear !== null);
      const neutral = read.length
        ? `${read.filter((g) => g.neutralClear).length}/${read.length}`
        : 'not run';
      const { onRoute, provenSkip, notOnRoute } = run.ledger;
      const route = `${run.attempts} attempt${run.attempts === 1 ? '' : 's'}; lines ${onRoute} on the route, ${provenSkip} proven, ${notOnRoute} not; important off route ${run.important.offRoute}/${run.important.lines}${run.important.flagged ? ', flagged' : ''}`;
      return `${found}; opinions ${n((g) => g.judged.unfoundedOpinion)}, behavior-first ${n((g) => g.judged.behaviorFirst)}, neutral clear ${neutral}, plain first ${n((g) => !g.mechanical.codeInFirstSentence)}; ${run.stopCount} stops; ${route}; ${money(run.tourUsd + run.judgeUsd)}`;
    });
    return `| ${id} | ${cells.join(' | ')} |`;
  });

  return `# Tour eval, ${input.date}

Tour model \`${input.model}\`, judge \`${input.judgeModel}\` (rubric v${input.judgeRubric}). One run per fixture and prompt. Generated by \`pnpm eval:tours\`; see [\`packages/evals/AGENTS.md\`](../../../packages/evals/AGENTS.md).

## Totals

${head}
${row('Defects explained, cited (judge)', (t) => `${t.findings.explained}/${t.findings.expected}${failedMark(t)}`)}
${row('Defects cited (line overlap)', (t) => `${t.findings.cited}/${t.findings.expected}${failedMark(t)}`)}
${row('External-knowledge defects explained', (t) => `${t.externalFindings.explained}/${t.externalFindings.expected}`)}
${row('Danger flags: false alarms / missed', (t) => `${t.danger.falseAlarms} / ${t.danger.missed}`)}
${row('Graded stops', (t) => `${t.stops}`)}
${row('Stops with an unfounded opinion (judge, target 0)', (t) => `${t.unfoundedOpinions} (${pct(share(t.unfoundedOpinions, t.stops))})`)}
${row('First sentence states the behavior change (judge)', (t) => pct(t.quality.behaviorFirst))}
${row('First sentence clear to a blind reader (neutral check)', (t) => (t.neutral.read ? `${pct(share(t.neutral.clear, t.neutral.read))} (${t.neutral.clear}/${t.neutral.read})` : 'not run'))}
${row('First sentence names no code (script)', (t) => pct(t.quality.plainFirstSentence))}
${row('Within length (script)', (t) => pct(t.quality.withinLength))}
${row('Tours over the stop cap', (t) => `${t.overLongTours}`)}
${row('Retries per tour (tours that retried)', (t) => `${(t.retries.total / Math.max(t.retries.ran, 1)).toFixed(2)} (${t.retries.tours}/${t.retries.ran})`)}
${row('Changed lines not on the route (attention saved)', (t) => {
  const off = t.ledger.provenSkip + t.ledger.notOnRoute;
  return `${pct(share(off, off + t.ledger.onRoute))} (${off}/${off + t.ledger.onRoute}; ${t.ledger.provenSkip} proven)`;
})}
${row('Important lines not on the route (target 0)', (t) => `${t.important.offRoute}/${t.important.lines}`)}
${row('Failed runs', (t) => `${t.failed}/${t.fixtures}`)}
${row('Tour cost', (t) => money(t.tourUsd))}
${row('Judge cost', (t) => money(t.judgeUsd))}

## Per fixture

| Fixture | ${input.prompts.map((p) => `v${p}`).join(' | ')} |
|---|${input.prompts.map(() => '---').join('|')}|
${perFixture.join('\n')}
`;
}
