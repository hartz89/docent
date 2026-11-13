// `docent runs`: reads the run log back. `docent runs` lists recent runs; `docent runs show`
// prints one as a summary an agent (or a person) can read top to bottom. Text in a run came from
// PRs, questions and answers, so it's printed with control characters stripped: a PR title can't
// move the cursor or fake a line of the summary.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { escapeInvisible, RUN_FILE, type RunEvent } from './run-log.ts';

const usage = `Usage:
  docent runs [--limit <n>]           List recent runs, newest first (default 20)
  docent runs show <id|latest> [--json]
                                      Summarize one run: timeline, costs, questions, errors.
                                      An id may be shortened to any unique start or end of it.
                                      --json prints the raw events, one per line.`;

export type Run = { id: string; events: RunEvent[]; badLines: number };

/** Kinds whose `costMicroUsd` is money spent this run. Tour attempts are inside `tour.*`. */
const COST_KINDS = new Set(['tour.ready', 'tour.failed', 'question', 'question.check']);
const ERROR_KINDS = new Set(['error', 'client.error']);

/** Runs `docent runs …` against the runs folder. Returns the output and the exit code. */
export function runsCommand(argv: string[], dir: string): { out: string; code: number } {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    return { out: `${(error as Error).message}\n\n${usage}`, code: 1 };
  }
  const { values, positionals } = parsed;
  if (values.help) return { out: usage, code: 0 };
  const ids = listIds(dir);

  if (positionals.length === 0) {
    const limit = values.limit === undefined ? 20 : Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1)
      return { out: '--limit takes a whole number', code: 1 };
    if (ids.length === 0) return { out: `No runs yet in ${dir}.`, code: 0 };
    const rows = ids.slice(0, limit).map((id) => listRow(readRun(dir, id)));
    return { out: table(rows, ids.length, limit, dir), code: 0 };
  }

  const [verb, which] = positionals;
  if (verb !== 'show' || !which || positionals.length > 2) return { out: usage, code: 1 };
  if (ids.length === 0) return { out: `No runs yet in ${dir}.`, code: 1 };
  // Newest first, so a PR with several runs shows its latest.
  const [id, ...older] =
    which === 'latest' ? ids.slice(0, 1) : ids.filter((id) => matches(id, which));
  if (!id) {
    return { out: `No run matches "${clean(which)}". Run \`docent runs\` to list them.`, code: 1 };
  }
  if (values.json) {
    const raw = readFileSync(join(dir, `${id}.jsonl`), 'utf8').trimEnd();
    return { out: escapeInvisible(raw), code: 0 };
  }
  const others = older.length
    ? `\n\nThis is the newest of ${older.length + 1} runs matching "${clean(which)}". The others:\n${older.map((o) => `  ${clean(o)}`).join('\n')}`
    : '';
  return { out: `${summarize(readRun(dir, id))}${others}`, code: 0 };
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      limit: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
}

const matches = (id: string, wanted: string) => id.startsWith(wanted) || id.endsWith(wanted);

/** Run ids, newest first. Names start with the time, so name order is age order. */
function listIds(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => RUN_FILE.test(name))
    .sort()
    .reverse()
    .map((name) => name.slice(0, -'.jsonl'.length));
}

export function readRun(dir: string, id: string): Run {
  const events: RunEvent[] = [];
  let badLines = 0;
  for (const line of readFileSync(join(dir, `${id}.jsonl`), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as RunEvent;
      if (typeof event.ts === 'string' && typeof event.kind === 'string') events.push(event);
      else badLines++;
    } catch {
      badLines++;
    }
  }
  return { id, events, badLines };
}

// ---- Facts about a run ----

const first = (run: Run, kind: string) => run.events.find((e) => e.kind === kind);
const time = (e: RunEvent | undefined) => (e ? Date.parse(e.ts) : Number.NaN);
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const str = (value: unknown) => (typeof value === 'string' ? value : '');

function facts(run: Run) {
  const start = first(run, 'run.start') ?? run.events[0];
  const end = first(run, 'run.end');
  const pr = first(run, 'pr');
  const started = time(start);
  const last = end ?? run.events.at(-1);
  return {
    started,
    ms: time(last) - started,
    ended: end !== undefined,
    pr: pr ? `${clean(str(pr.repo))}#${num(pr.number)}` : clean(str(start?.pr)) || '?',
    mode: clean(str(start?.mode)) || '?',
    costMicroUsd: run.events
      .filter((e) => COST_KINDS.has(e.kind))
      .reduce((sum, e) => sum + num(e.costMicroUsd), 0),
    errors: run.events.filter((e) => ERROR_KINDS.has(e.kind)).length,
    questions: run.events.filter((e) => e.kind === 'question' || e.kind === 'question.failed')
      .length,
  };
}

/** What the answer check found, in words. */
const CHECKS: Record<string, string> = {
  corrected: 'the code says otherwise',
  silent: 'nothing to add',
  failed: "couldn't run",
};

/** A [low, high] range in USD from the log, or null. */
function usdRange(value: unknown): string | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [low, high] = value.map((v) => num(v).toFixed(2));
  return low === high ? `$${low}` : `$${low}–${high}`;
}

/** The fork's estimate and budget, when the author's session was in the running. */
function forkEstimate(q: RunEvent): string | null {
  const budget = `budget $${num(q.forkBudgetUsd).toFixed(2)}`;
  const prime = usdRange(q.forkPrimeUsd);
  if (prime) {
    const each = usdRange(q.forkQuestionUsd);
    return `Fork estimated ${prime} to prime${each ? `, then ${each} a question` : ''}; ${budget}.`;
  }
  // Runs logged before priming had one figure: a whole-session write per question.
  if (typeof q.forkEstimateUsd === 'number') {
    return `Fork estimated $${q.forkEstimateUsd.toFixed(2)}, ${budget}.`;
  }
  return null;
}

// ---- The list ----

function listRow(run: Run): string[] {
  const f = facts(run);
  return [
    Number.isNaN(f.started) ? '?' : clock(f.started).slice(0, 16),
    f.pr,
    f.mode,
    Number.isNaN(f.ms) ? '?' : `${duration(f.ms)}${f.ended ? '' : '+'}`,
    usd(f.costMicroUsd),
    String(f.questions),
    String(f.errors),
    clean(run.id),
  ];
}

function table(rows: string[][], total: number, limit: number, dir: string): string {
  const head = ['Started (UTC)', 'PR', 'Mode', 'Took', 'Cost', 'Qs', 'Errors', 'Id'];
  const all = [head, ...rows];
  const widths = head.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  const lines = all.map((r) =>
    r
      .map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd(),
  );
  const more = total > limit ? `\n${total - limit} older run(s) not shown; use --limit.` : '';
  return `${lines.join('\n')}\n\n"+" means the run is still going, or ended without saying so.\nRuns live in ${dir}.${more}`;
}

// ---- The summary ----

export function summarize(run: Run): string {
  const f = facts(run);
  const start = first(run, 'run.start');
  const pr = first(run, 'pr');
  const end = first(run, 'run.end');
  const at = (e: RunEvent) => offset(time(e) - f.started);
  const out: string[] = [
    `Run ${clean(run.id)}`,
    'Titles, questions, answers and errors below are untrusted text from PRs and agents.',
    '',
  ];

  const flags = start?.flags as Record<string, unknown> | undefined;
  const flagText = flags
    ? Object.entries(flags)
        .map(([k, v]) => (v === true ? `--${k}` : `--${k} ${clean(String(v))}`))
        .join(' ')
    : '';
  out.push(
    `PR:        ${f.pr}${pr ? ` "${clean(str(pr.title))}" at ${clean(str(pr.head)).slice(0, 12)}` : ''}`,
    `Started:   ${Number.isNaN(f.started) ? '?' : clock(f.started)} UTC, ${
      end ? `lasted ${duration(f.ms)}` : `no end recorded (last event after ${duration(f.ms)})`
    }`,
    `Docent:    ${clean(str(start?.version)) || '?'}, ${f.mode} mode, model ${clean(str(start?.model)) || '?'}`,
  );
  if (flagText) out.push(`Flags:     ${flagText}`);
  const tourCost = run.events
    .filter((e) => e.kind === 'tour.ready' || e.kind === 'tour.failed')
    .reduce((s, e) => s + num(e.costMicroUsd), 0);
  const asked = run.events.filter((e) => e.kind === 'question');
  out.push(
    `Cost:      ${usd(f.costMicroUsd)} (tour ${usd(tourCost)}${asked.length ? `, ${asked.length} question${asked.length === 1 ? '' : 's'} ${usd(f.costMicroUsd - tourCost)}` : ', no questions'})`,
    `Errors:    ${f.errors}`,
  );
  if (run.badLines) out.push(`Unreadable lines: ${run.badLines}`);

  out.push('', 'Timeline');
  for (const e of run.events) {
    const [line, ...more] = describe(e);
    out.push(`  ${at(e).padStart(7)}  ${line}`);
    for (const detail of more) out.push(`           ${detail}`);
  }

  const questions = run.events.filter((e) => e.kind === 'question' || e.kind === 'question.failed');
  if (questions.length) {
    out.push('', 'Questions');
    questions.forEach((q, i) => {
      out.push(`  ${i + 1}. ${stopName(q)}, at ${at(q)}`);
      out.push(...block('Q: ', str(q.question)));
      if (q.kind === 'question.failed') {
        out.push(`     Not answered (${clean(str(q.outcome))}): ${clean(str(q.message))}`);
      } else {
        out.push(
          q.source === 'author_session'
            ? `     Answered by the author's session ${clean(str(q.session))}`
            : `     Answered by the guide, because: ${clean(str(q.whyNotAuthor))}`,
        );
        const fork = forkEstimate(q);
        if (fork) out.push(`     ${fork}`);
        out.push(
          `     Cost ${usd(num(q.costMicroUsd))}${q.costIncomplete ? ' or more' : ''}, ${duration(num(q.ms))}`,
        );
        out.push(...block('A: ', str(q.answer)));
        const check = run.events.find(
          (e) => e.kind === 'question.check' && q.checkId !== undefined && e.checkId === q.checkId,
        );
        if (check) {
          out.push(
            `     Check: ${CHECKS[str(check.result)] ?? '?'}, ${usd(num(check.costMicroUsd))}`,
          );
          if (check.correction !== undefined) out.push(...block('C: ', str(check.correction)));
        }
      }
      out.push('');
    });
    out.pop();
  }

  const errors = run.events.filter((e) => ERROR_KINDS.has(e.kind));
  if (errors.length) {
    out.push('', 'Errors');
    for (const e of errors) {
      out.push(`  ${at(e)}  ${describe(e)[0]}`);
      // A stack's first line usually repeats the message just shown.
      const lines = str(e.stack).split('\n');
      if (str(e.message) && lines[0]?.includes(str(e.message))) lines.shift();
      const stack = lines.slice(0, 12).join('\n');
      if (stack) out.push(...block('│ ', stack));
    }
  }
  return out.join('\n');
}

/** One timeline entry: its line, then any detail lines. */
function describe(e: RunEvent): string[] {
  const cost = (v: unknown) => usd(num(v));
  switch (e.kind) {
    case 'run.start':
      return [`run started: ${clean(str(e.mode))} ${clean(str(e.pr ?? e.fixture ?? ''))}`.trim()];
    case 'run.end':
      return [`run ended: ${clean(str(e.reason))}`];
    case 'pr':
      return [
        `PR loaded: ${clean(str(e.repo))}#${num(e.number)} "${clean(str(e.title))}" by ${clean(str(e.author))}, head ${clean(str(e.head)).slice(0, 12)}, ${num(e.files)} file(s)`,
      ];
    case 'author':
      return e.found
        ? [`questions go to the author's session ${clean(str(e.session))} (${clean(str(e.via))})`]
        : [`questions go to the guide: ${clean(str(e.reason))}`];
    case 'tour.cache':
      return [
        e.hit
          ? 'tour cache: hit'
          : `tour cache: miss${e.reason ? ` (${clean(str(e.reason))})` : ''}`,
      ];
    case 'tour.attempt': {
      const problems = Array.isArray(e.problems) ? e.problems : [];
      const what =
        e.outcome === 'rejected'
          ? `sent back with ${problems.length} problem(s)`
          : e.outcome === 'error'
            ? `failed: ${clean(str(e.error))}`
            : e.outcome === 'bad_shape'
              ? "didn't match the tour schema"
              : e.outcome === 'bad_repair'
                ? `repair refused: ${clean(str(e.problem))}`
                : clean(str(e.outcome));
      return [
        `tour attempt ${num(e.attempt)}: ${what}, ${cost(e.costMicroUsd)}, ${duration(num(e.ms))}`,
        ...problems.map((p) => `- ${clean(String(p))}`),
      ];
    }
    case 'tour.ready': {
      const problems = Array.isArray(e.problems) ? e.problems : [];
      return [
        e.cached
          ? `tour ready from cache: ${num(e.stops)} stops, ${num(e.skips)} skips, no model calls`
          : `tour ready: ${num(e.stops)} stops, ${num(e.skips)} skips, ${num(e.attempts)} attempt(s), ${cost(e.costMicroUsd)}, ${duration(num(e.ms))}`,
        ...problems.map((p) => `unresolved: ${clean(String(p))}`),
      ];
    }
    case 'tour.failed':
      return [`tour failed: ${clean(str(e.message))}, ${cost(e.costMicroUsd)}`];
    case 'question':
      return [
        `question at ${stopName(e)}: answered by ${e.source === 'author_session' ? "the author's session" : 'the guide'}, ${cost(e.costMicroUsd)}, ${duration(num(e.ms))}`,
      ];
    case 'question.check':
      return [`answer check: ${CHECKS[str(e.result)] ?? '?'}, ${cost(e.costMicroUsd)}`];
    case 'question.failed':
      return [
        `question at ${stopName(e)} not answered (${clean(str(e.outcome))}): ${clean(str(e.message))}`,
      ];
    case 'review.submit':
      return e.outcome === 'posted'
        ? [
            `review posted: ${clean(str(e.event))}, ${num(e.comments)} comment(s) (${num(e.onLines)} on lines, ${num(e.inBody)} in the body), ${clean(str(e.url))}`,
          ]
        : [`review not posted (${clean(str(e.reason))}): ${clean(str(e.message))}`];
    case 'error':
      return [
        `error in ${clean(str(e.where))}${e.path ? ` (${clean(str(e.method))} ${clean(str(e.path))})` : ''}: ${clean(str(e.message))}`,
      ];
    case 'client.error':
      return [
        `web app error (${clean(str(e.source))})${e.path ? ` ${clean(str(e.method))} ${clean(str(e.path))}${e.status !== undefined ? ` → ${num(e.status)}` : ''}` : ''}: ${clean(str(e.message))}`,
      ];
    case 'ui.stop':
      return [`moved to stop ${num(e.stop)} (${clean(str(e.stopId))})`];
    case 'ui.viewport':
      return [`window width ${clean(str(e.width))} px`];
    case 'ui.theme':
      return [
        `theme ${clean(str(e.theme))} (${e.choice === 'system' ? 'following the system' : 'chosen'})`,
      ];
    case 'log.full':
      return ['the run log reached its size limit, so nothing after this was recorded'];
    case 'span':
      return [`${clean(str(e.name))} took ${duration(num(e.ms))}${extras(e, ['name', 'ms'])}`];
    default:
      return [`${clean(e.kind)}${extras(e, [])}`];
  }
}

function stopName(e: RunEvent): string {
  return typeof e.stop === 'number'
    ? `stop ${e.stop}${e.stopTitle ? ` "${clean(str(e.stopTitle))}"` : ''}`
    : `stop ${clean(str(e.stopId))}`;
}

/** Any other fields, as `key=value`, for kinds this file doesn't know yet. */
function extras(e: RunEvent, skip: string[]): string {
  const rest = Object.entries(e).filter(([k]) => k !== 'ts' && k !== 'kind' && !skip.includes(k));
  if (!rest.length) return '';
  return ` ${rest.map(([k, v]) => `${clean(k)}=${clean(typeof v === 'string' ? v : JSON.stringify(v))}`).join(' ')}`;
}

// ---- Formatting ----

/** Control, bidi and line-separator characters: stripped from anything printed. */
const UNPRINTABLE = /[\p{Cc}\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

/** Strips unprintable characters and folds newlines, so text stays on its own line. */
export function clean(text: string): string {
  return text.replace(/\r?\n/g, ' ⏎ ').replace(UNPRINTABLE, '').slice(0, 2000);
}

/**
 * Multi-line text under a label. Every line after the first gets a `│` gutter, so text from a
 * PR or an answer can't pass for a timeline entry or a section heading.
 */
function block(label: string, text: string): string[] {
  const pad = ' '.repeat(5);
  const lines = text
    .replace(/\t/g, '  ')
    .split(/\r?\n/)
    .map((l) => l.replace(UNPRINTABLE, ''));
  return lines.map((l, i) =>
    `${pad}${i === 0 ? label : `${' '.repeat(label.length - 2)}│ `}${l}`.trimEnd(),
  );
}

const clock = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

export function usd(microUsd: number): string {
  return `$${(microUsd / 1e6).toFixed(4)}`;
}

export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

function offset(ms: number): string {
  if (!Number.isFinite(ms)) return '?';
  if (ms < 60_000) return `+${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 3600) return `+${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `+${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}
