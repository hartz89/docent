// Live proof that agent instructions load. Runs one real, read-only headless Claude Code
// session from the repo root and checks two things:
//   (a) Claude Code loaded the root AGENTS.md at start, and each package's AGENTS.md
//       when the agent read a file there. An InstructionsLoaded hook logs every load.
//   (b) The content reached the model: it answers questions only those files answer.
// Costs a few cents, so it is not part of pnpm verify. Run: pnpm check:context
// Background: docs/research/2026-11-06-context-loading.md

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

/** One question per package, answerable only from that package's AGENTS.md. */
const packages = [
  {
    dir: 'apps/server',
    file: 'src/app.ts',
    question: "what status does Hono's bearerAuth return for a malformed Authorization header?",
    expected: /\b400\b/,
  },
  {
    dir: 'apps/web',
    file: 'src/main.tsx',
    question: 'what should you do for a new screen before building production UI?',
    expected: /explor/i,
  },
  {
    dir: 'e2e',
    file: 'health.spec.ts',
    question: 'which Playwright config option must you not switch to for starting the server?',
    expected: /webServer/,
  },
];

const prompt = [
  'Answer three questions. Use only the Read tool, on exactly the three files named below.',
  'Do not open any AGENTS.md or CLAUDE.md file, and do not search. Answer from the agent',
  'notes already in your context.',
  '',
  ...packages.map(
    (p, i) =>
      `${i + 1}. Read ${p.dir}/${p.file}. According to this package's agent notes, ${p.question}`,
  ),
  '',
  'Reply with exactly three lines and nothing else:',
  ...packages.map((p) => `${p.dir}: <short answer>`),
].join('\n');

type HookInput = {
  file_path: string;
  load_reason: string;
  parent_file_path?: string;
  trigger_file_path?: string;
  transcript_path: string;
};

type Result = {
  result: string;
  is_error: boolean;
  total_cost_usd: number;
  num_turns: number;
  duration_ms: number;
  usage: {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
  };
};

type Row = { check: string; ok: boolean; detail: string };

function readLog(path: string): HookInput[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as HookInput);
}

/** The hook runs asynchronously, so give late entries a moment to land. */
async function waitForLog(path: string, want: number): Promise<HookInput[]> {
  for (let i = 0; i < 20; i++) {
    const entries = readLog(path);
    if (entries.length >= want) return entries;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return readLog(path);
}

/**
 * Reads the session transcript, an internal format. Returns how often each instruction
 * file's contents were attached (to spot a double load, including a native AGENTS.md load
 * the hook can't see), and the tool calls the agent made.
 */
function readTranscript(path: string) {
  const attached = new Map<string, number>();
  const toolCalls: { name: string; input: string }[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const entry = JSON.parse(line) as {
      type?: string;
      message?: { content?: { type: string; name?: string; input?: unknown }[] | string };
    };
    if (entry.type === 'attachment') {
      for (const match of line.matchAll(/Contents of (\/[^\s"\\]+?\.md)/g)) {
        const file = match[1] ?? '';
        attached.set(file, (attached.get(file) ?? 0) + 1);
      }
    }
    if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
      for (const block of entry.message.content) {
        if (block.type === 'tool_use') {
          toolCalls.push({ name: block.name ?? '', input: JSON.stringify(block.input) });
        }
      }
    }
  }
  return { attached, toolCalls };
}

async function main(): Promise<number> {
  const tmp = mkdtempSync(join(tmpdir(), 'docent-context-'));
  try {
    const log = join(tmp, 'instructions-loaded.jsonl');
    const settings = join(tmp, 'settings.json');
    // Each hook input arrives as JSON on stdin; append it as one line.
    const command = `cat >> '${log}' && echo >> '${log}'`;
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: { InstructionsLoaded: [{ hooks: [{ type: 'command', command }] }] },
      }),
    );

    // The prompt goes right after -p: --tools is variadic and would swallow a trailing prompt.
    const run = spawnSync(
      'claude',
      [
        '-p',
        prompt,
        '--settings',
        settings,
        '--tools',
        'Read,Grep,Glob',
        '--permission-mode',
        'dontAsk',
        '--strict-mcp-config',
        '--model',
        'haiku',
        '--output-format',
        'json',
      ],
      { cwd: root, encoding: 'utf8', timeout: 300_000 },
    );
    if (run.status !== 0) {
      console.error(`claude -p failed (exit ${run.status}):\n${run.stderr}${run.stdout}`);
      return 1;
    }
    const result = JSON.parse(run.stdout) as Result;
    const expectedLoads = 2 + 2 * packages.length;
    const loads = await waitForLog(log, expectedLoads);

    const rows: Row[] = [];
    const abs = (path: string) => join(root, path);
    const loaded = (file: string, reason: string, parent?: string) =>
      loads.some(
        (e) =>
          e.file_path === abs(file) &&
          e.load_reason === reason &&
          (parent === undefined || e.parent_file_path === abs(parent)),
      );

    rows.push({
      check: 'root CLAUDE.md at start',
      ok: loaded('CLAUDE.md', 'session_start'),
      detail: 'session_start',
    });
    rows.push({
      check: 'root AGENTS.md at start',
      ok: loaded('AGENTS.md', 'include', 'CLAUDE.md'),
      detail: 'include, from CLAUDE.md',
    });
    for (const p of packages) {
      const ok =
        loaded(`${p.dir}/CLAUDE.md`, 'nested_traversal') &&
        loaded(`${p.dir}/AGENTS.md`, 'include', `${p.dir}/CLAUDE.md`);
      rows.push({
        check: `${p.dir}/AGENTS.md on read`,
        ok,
        detail: 'CLAUDE.md nested_traversal, AGENTS.md include',
      });
    }

    const perFile = new Map<string, number>();
    for (const e of loads) perFile.set(e.file_path, (perFile.get(e.file_path) ?? 0) + 1);
    const hookTwice = [...perFile].filter(([, n]) => n > 1).map(([f]) => f);
    rows.push({
      check: 'no file loads twice (hook)',
      ok: hookTwice.length === 0,
      detail: hookTwice.length === 0 ? `${loads.length} loads` : hookTwice.join(', '),
    });

    const transcriptPath = loads[0]?.transcript_path;
    const transcript =
      transcriptPath && existsSync(transcriptPath) ? readTranscript(transcriptPath) : undefined;
    if (transcript && transcript.attached.size > 0) {
      const twice = [...transcript.attached].filter(([, n]) => n > 1).map(([f]) => f);
      rows.push({
        check: 'no file loads twice (transcript)',
        ok: twice.length === 0,
        detail:
          twice.length === 0
            ? 'catches native AGENTS.md loads too'
            : twice.map((f) => f.replace(`${root}/`, '')).join(', '),
      });
    } else {
      console.warn('warning: could not read instruction attachments from the transcript');
    }

    const peeked = (transcript?.toolCalls ?? []).filter(
      (c) => c.name !== 'Read' || /AGENTS\.md|CLAUDE\.md/.test(c.input),
    );
    rows.push({
      check: 'answers came from context',
      ok: transcript !== undefined && peeked.length === 0,
      detail:
        transcript === undefined
          ? 'transcript unreadable'
          : peeked.length === 0
            ? `${transcript.toolCalls.length} Read calls, none on instruction files`
            : peeked.map((c) => `${c.name} ${c.input}`).join('; '),
    });

    for (const p of packages) {
      const line = result.result.split('\n').find((l) => l.trim().startsWith(`${p.dir}:`)) ?? '';
      const answer = line.slice(line.indexOf(':') + 1).trim();
      rows.push({
        check: `${p.dir} answer`,
        ok: !result.is_error && p.expected.test(answer),
        detail: answer || '(no answer)',
      });
    }

    printTable(rows);
    const u = result.usage;
    console.log(
      `\ncost $${result.total_cost_usd.toFixed(4)} · ${result.num_turns} turns · ${(result.duration_ms / 1000).toFixed(1)}s · ` +
        `tokens: ${u.input_tokens} in, ${u.cache_creation_input_tokens} cache write, ${u.cache_read_input_tokens} cache read, ${u.output_tokens} out`,
    );
    const failed = rows.filter((r) => !r.ok).length;
    if (failed > 0) {
      console.log(`\n${failed} check(s) failed. Hook log:`);
      for (const e of loads) {
        console.log(`  ${e.load_reason.padEnd(16)} ${e.file_path.replace(`${root}/`, '')}`);
      }
      return 1;
    }
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function printTable(rows: Row[]) {
  const width = Math.max(...rows.map((r) => r.check.length));
  for (const r of rows) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.check.padEnd(width)}  ${r.detail}`);
  }
}

process.exitCode = await main();
