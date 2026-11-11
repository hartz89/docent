// Harness benchmark: does a harness change make agents better or worse at real repo work?
// Runs a few small repo tasks under two harnesses (the base ref and the branch ref), each in a
// throwaway copy of the repo, grades them mechanically, and prints a comparison table.
//
// Costs real money, so it is not part of pnpm verify. Sonnet by default, and spend is capped.
// Run: pnpm bench:harness [--model sonnet] [--max-usd 3] [--runs 1] [--base origin/main]
//                         [--head HEAD] [--only task-id,task-id]
// Only committed files are copied: commit before you run it.
// Design: docs/process/harness-evals.md

import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { measureFootprint } from './check-context-footprint.ts';

const root = join(import.meta.dirname, '..');

/**
 * Claude Code stops a session at the end of the turn that crosses its budget, so a session can
 * overspend by one turn. Each session's budget leaves this much of the cap for that last turn.
 */
const LAST_TURN_RESERVE_USD = 0.25;

/** A session that runs longer than this is stopped and fails. */
const SESSION_TIMEOUT_MS = 10 * 60_000;

type Task = {
  id: string;
  prompt: string;
  /** Write tasks get edit tools and a sandboxed Bash. Read tasks get Read, Grep and Glob only. */
  writes: boolean;
  /** Returns what went wrong. An empty list is a pass. */
  grade: (copy: string, answer: string) => string[];
};

export const tasks: Task[] = [
  {
    id: 'find-core-boundary',
    writes: false,
    prompt:
      'Which file in this repo defines the check that stops packages/core from importing ' +
      'frameworks or Node modules? Reply with only its path, relative to the repo root.',
    grade: (_copy, answer) => (/\bbiome\.json\b/.test(answer) ? [] : ['did not name biome.json']),
  },
  {
    id: 'find-pairing-check',
    writes: false,
    prompt:
      'Which script checks that every folder with an AGENTS.md also has a CLAUDE.md? ' +
      'Reply with only its path, relative to the repo root.',
    grade: (_copy, answer) =>
      answer.includes('scripts/check-agents-md.ts')
        ? []
        : ['did not name scripts/check-agents-md.ts'],
  },
  {
    id: 'pr-tier',
    writes: false,
    prompt:
      'A pull request changes only one file: docs/research/2026-11-10-notes.md. Which risk tier ' +
      'is it under this repo\'s rules? Reply with only the tier, like "tier 1".',
    grade: (_copy, answer) => (/^\W*(tier\s*)?0\b/i.test(answer) ? [] : ['did not answer tier 0']),
  },
  {
    id: 'pnpm-exec',
    writes: false,
    prompt:
      'You want to print the version of the TypeScript compiler this repo has installed. Reply ' +
      "with only the shell command you would run. Don't run it.",
    grade: (_copy, answer) =>
      /^\W*pnpm exec tsc (-v|--version)\b/.test(answer) ? [] : ['did not use "pnpm exec tsc"'],
  },
  {
    id: 'agent-notes',
    writes: true,
    prompt:
      'Add agent notes for the scripts/ folder. They should say one thing: scripts run directly ' +
      "with node, with no build step. Follow this repo's rules for agent notes. Don't commit.",
    grade: (copy) => {
      const failures: string[] = [];
      const notes = join(copy, 'scripts/AGENTS.md');
      if (!existsSync(notes) || !/node/i.test(readFileSync(notes, 'utf8'))) {
        failures.push('scripts/AGENTS.md is missing or never mentions node');
      }
      const claude = join(copy, 'scripts/CLAUDE.md');
      if (!existsSync(claude) || readFileSync(claude, 'utf8').trim() !== '@AGENTS.md') {
        failures.push('scripts/CLAUDE.md is missing or is not exactly "@AGENTS.md"');
      }
      if (run('node', ['scripts/check-agents-md.ts'], copy).status !== 0) {
        failures.push('check-agents-md fails');
      }
      return [...failures, ...unexpectedChanges(copy, ['scripts/AGENTS.md', 'scripts/CLAUDE.md'])];
    },
  },
  {
    id: 'add-clamp',
    writes: true,
    prompt:
      'Add a function to packages/core: clamp(value: number, min: number, max: number): number, ' +
      'in a new file packages/core/src/clamp.ts, exported from that file. It limits value to the ' +
      'range from min to max. Add tests in packages/core/src/clamp.test.ts. You are done when ' +
      "pnpm verify passes. Don't commit.",
    grade: (copy) => {
      const failures = unexpectedChanges(copy, ['packages/core/']);
      if (!existsSync(join(copy, 'packages/core/src/clamp.test.ts'))) {
        return [...failures, 'packages/core/src/clamp.test.ts is missing'];
      }
      if (run('pnpm', ['verify'], copy).status !== 0) failures.push('pnpm verify fails');
      // The tests must catch a broken clamp, not just pass.
      writeFileSync(
        join(copy, 'packages/core/src/clamp.ts'),
        'export function clamp(value: number, _min: number, _max: number): number {\n  return value;\n}\n',
      );
      const mutant = run(
        'pnpm',
        ['exec', 'vitest', 'run', '--project', 'core', 'clamp.test.ts'],
        copy,
      );
      if (mutant.status === 0) failures.push('the tests still pass with a clamp that does nothing');
      return failures;
    },
  },
];

function run(cmd: string, args: string[], cwd: string, input?: Buffer): SpawnSyncReturns<Buffer> {
  return spawnSync(cmd, args, { cwd, input, maxBuffer: 512 * 1024 * 1024, timeout: 300_000 });
}

function mustRun(cmd: string, args: string[], cwd: string, input?: Buffer): Buffer {
  const result = run(cmd, args, cwd, input);
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd}:\n${result.stderr}`);
  }
  return result.stdout;
}

/** Changed or new files in the copy that don't start with one of the allowed prefixes. */
function unexpectedChanges(copy: string, allowed: string[]): string[] {
  const status = mustRun('git', ['status', '--porcelain', '--untracked-files=all'], copy);
  const changed = status
    .toString()
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.slice(3));
  const extra = changed.filter((file) => !allowed.some((prefix) => file.startsWith(prefix)));
  return extra.length === 0 ? [] : [`changed files outside the task: ${extra.join(', ')}`];
}

/**
 * A throwaway copy of the repo at `ref`: the committed files only, in a fresh git repo of its
 * own with one commit and no remote. It shares nothing with this checkout's .git, so nothing
 * done in it can reach this repo's branches, stash or GitHub.
 */
export function makeCopy(ref: string, install: boolean): string {
  const copy = mkdtempSync(join(tmpdir(), 'docent-bench-'));
  mustRun('tar', ['-x', '-C', copy], copy, mustRun('git', ['archive', ref], root));
  mustRun('git', ['init', '-q', '-b', 'bench'], copy);
  mustRun('git', ['add', '-A'], copy);
  const who = ['-c', 'user.name=bench', '-c', 'user.email=bench@localhost'];
  mustRun('git', [...who, 'commit', '-q', '--no-verify', '-m', ref], copy);
  if (install) mustRun('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], copy);
  return copy;
}

type SessionResult = {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  total_cost_usd?: number;
  num_turns?: number;
  usage?: Record<string, number>;
};

type Outcome = {
  task: string;
  harness: string;
  failures: string[];
  costUsd: number;
  tokens: number;
  turns: number;
  seconds: number;
};

/** Runs one task in a fresh copy. `budgetUsd` caps this session's spend. */
function runTask(
  task: Task,
  harness: string,
  ref: string,
  model: string,
  budgetUsd: number,
): Outcome {
  const copy = makeCopy(ref, task.writes);
  try {
    // The prompt goes right after -p: --tools and --disallowedTools would swallow a trailing one.
    const args = ['-p', task.prompt, '--model', model, '--output-format', 'json'];
    args.push('--max-budget-usd', budgetUsd.toFixed(2), '--no-session-persistence');
    // Project settings only, so the copy's own .claude/settings.json is part of the harness,
    // and this machine's user settings are not.
    args.push(
      '--setting-sources',
      'project',
      '--strict-mcp-config',
      '--permission-mode',
      'dontAsk',
    );
    if (task.writes) {
      // Bash runs in Claude Code's sandbox: writes only inside the copy, and no network.
      const sandbox = { sandbox: { enabled: true, autoAllowBashIfSandboxed: true } };
      args.push('--settings', JSON.stringify(sandbox), '--tools', 'Read,Grep,Glob,Edit,Write,Bash');
      args.push('--allowedTools', 'Edit(./**)', 'Write(./**)');
      args.push(
        '--disallowedTools',
        'Bash(git push:*)',
        'Bash(gh:*)',
        'Bash(node scripts/as-agent.ts:*)',
      );
    } else {
      args.push('--tools', 'Read,Grep,Glob');
    }
    const started = Date.now();
    const session = spawnSync('claude', args, {
      cwd: copy,
      encoding: 'utf8',
      timeout: SESSION_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    const seconds = (Date.now() - started) / 1000;
    let parsed: SessionResult | undefined;
    try {
      parsed = JSON.parse(session.stdout) as SessionResult;
    } catch {
      parsed = undefined;
    }
    const base = { task: task.id, harness, seconds };
    if (parsed?.total_cost_usd === undefined) {
      // No result to read the cost from. Count the whole budget as spent, so the cap holds.
      const why = session.error ? String(session.error) : `exit ${session.status}`;
      const failures = [`session failed (${why})`];
      return { ...base, failures, costUsd: budgetUsd, tokens: 0, turns: 0 };
    }
    const usage = parsed.usage ?? {};
    const tokens =
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.output_tokens ?? 0);
    // A session cut short (by its budget, say) fails, whatever state it left the copy in.
    const failures = parsed.is_error ? [`session ended early (${parsed.subtype})`] : [];
    failures.push(...task.grade(copy, (parsed.result ?? '').trim()));
    const turns = parsed.num_turns ?? 0;
    return { ...base, failures, costUsd: parsed.total_cost_usd, tokens, turns };
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

function summarize(outcomes: Outcome[]): string {
  const n = outcomes.length;
  if (n === 0) return '| – | – | – | – | – |';
  const passed = outcomes.filter((o) => o.failures.length === 0).length;
  const mean = (pick: (o: Outcome) => number) => outcomes.reduce((s, o) => s + pick(o), 0) / n;
  return [
    `${passed}/${n}`,
    `$${mean((o) => o.costUsd).toFixed(3)}`,
    `${Math.round(mean((o) => o.tokens) / 1000)}k`,
    mean((o) => o.turns).toFixed(1),
    `${Math.round(mean((o) => o.seconds))}s`,
  ]
    .map((cell) => `| ${cell} `)
    .join('')
    .concat('|');
}

function main(): number {
  const { values } = parseArgs({
    options: {
      model: { type: 'string', default: 'sonnet' },
      'max-usd': { type: 'string', default: '3' },
      runs: { type: 'string', default: '1' },
      base: { type: 'string', default: 'origin/main' },
      head: { type: 'string', default: 'HEAD' },
      only: { type: 'string' },
    },
  });
  const maxUsd = Number(values['max-usd']);
  const runs = Number(values.runs);
  if (!(maxUsd > 0) || !Number.isInteger(runs) || runs < 1) {
    console.error('--max-usd must be a positive number and --runs a positive whole number');
    return 2;
  }
  const only = values.only?.split(',');
  const selected = only ? tasks.filter((t) => only.includes(t.id)) : tasks;
  if (selected.length === 0) {
    console.error(`no tasks match --only. Tasks: ${tasks.map((t) => t.id).join(', ')}`);
    return 2;
  }
  const harnesses = [
    { name: 'base', ref: values.base },
    { name: 'branch', ref: values.head },
  ];
  // Resolve refs once, so both arms of every task see the same commits.
  for (const h of harnesses)
    h.ref = mustRun('git', ['rev-parse', '--verify', `${h.ref}^{commit}`], root)
      .toString()
      .trim();

  const outcomes: Outcome[] = [];
  const skipped: string[] = [];
  let spent = 0;
  let order = 0;
  for (let i = 0; i < runs; i++) {
    for (const task of selected) {
      // Alternate which harness goes first, so neither always gets a warm prompt cache.
      const pair = order++ % 2 === 0 ? harnesses : [...harnesses].reverse();
      for (const h of pair) {
        const budget = maxUsd - spent - LAST_TURN_RESERVE_USD;
        if (budget < 0.05) {
          skipped.push(`${task.id} (${h.name})`);
          continue;
        }
        const outcome = runTask(task, h.name, h.ref, values.model, budget);
        spent += outcome.costUsd;
        outcomes.push(outcome);
        const status =
          outcome.failures.length === 0 ? 'pass' : `FAIL: ${outcome.failures.join('; ')}`;
        console.error(`${task.id} (${h.name}) $${outcome.costUsd.toFixed(3)} ${status}`);
      }
    }
  }

  const footprint = (ref: string) => {
    const copy = makeCopy(ref, false);
    try {
      return measureFootprint(copy).total;
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  };
  const [base, branch] = harnesses as [
    { name: string; ref: string },
    { name: string; ref: string },
  ];
  console.log(
    `Model ${values.model}, ${runs} run(s) per task. Base ${base.ref.slice(0, 7)} ` +
      `(resident context ${footprint(base.ref)} tokens), branch ${branch.ref.slice(0, 7)} ` +
      `(${footprint(branch.ref)} tokens). Spent $${spent.toFixed(2)} of $${maxUsd.toFixed(2)}.\n`,
  );
  console.log('| Task | Harness | Pass | Cost | Tokens | Turns | Time |');
  console.log('| --- | --- | --- | --- | --- | --- | --- |');
  for (const task of selected) {
    for (const h of harnesses) {
      const mine = outcomes.filter((o) => o.task === task.id && o.harness === h.name);
      console.log(`| ${task.id} | ${h.name} ${summarize(mine)}`);
    }
  }
  for (const h of harnesses) {
    console.log(`| **all** | ${h.name} ${summarize(outcomes.filter((o) => o.harness === h.name))}`);
  }
  console.log('\nCost, tokens, turns and time are means per run.');
  const failed = outcomes.filter((o) => o.failures.length > 0);
  for (const o of failed) console.log(`- ${o.task} (${o.harness}): ${o.failures.join('; ')}`);
  if (skipped.length > 0) console.log(`- Skipped, budget spent: ${skipped.join(', ')}`);
  return 0;
}

if (import.meta.main) process.exitCode = main();
