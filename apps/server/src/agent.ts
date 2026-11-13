// The boundary to the model. Everything Docent asks an agent goes through an AgentRunner, so tests
// can swap in a scripted runner and never make a model call.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, readdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { type CostRecord, type Job, type MicroUsd, microUsd } from '@docent/core';

export type AgentRequest = {
  job: Job;
  prompt: string;
  /** The checkout the agent may read. It can't write anywhere. */
  cwd: string;
  model: string;
  /** JSON Schema for structured output. Leave out for a plain-text answer. */
  schema?: Record<string, unknown>;
  /** Called with short descriptions of what the agent is doing, like "Reading src/cors.ts". */
  onActivity?: (activity: string) => void;
  signal?: AbortSignal;
  /** The most the session may spend. Default $2. */
  maxBudgetUsd?: number;
  /**
   * Called with the structured output written so far, each time more of it streams in. This is
   * raw model text, cut off mid-way: parse and check it before any of it reaches a reader.
   */
  onOutput?: (jsonSoFar: string) => void;
} & (
  | {
      /** Continue Docent's own earlier session, as the checker loop does with its problems. */
      resume?: string;
      fork?: never;
      keepIn?: never;
    }
  | {
      /**
       * Fork someone else's session, the PR author's: the agent sees its whole history, and the
       * original transcript is never written to. A session id, or the path of a transcript an
       * earlier fork kept (see `keepIn`). The fork itself isn't saved, unless `keepIn` says so.
       */
      fork: string;
      /**
       * Keep this fork's transcript as `<keepIn>/<sessionId>.jsonl`, so later forks can start
       * from it. Claude Code saves it under its projects folder; it's moved out as soon as the
       * fork ends, so neither Claude Code's resume list nor Docent's session search finds it.
       */
      keepIn?: string;
      resume?: never;
    }
);

export type AgentReply = {
  sessionId: string;
  text: string;
  /** The parsed structured output, when a schema was given. */
  structured: unknown;
  cost: CostRecord;
  /** Tools the session tried and was refused, as the SDK reports them. */
  denials: string[];
  /** Where the time went. Missing from recorded fixtures made before it existed. */
  timing?: ModelTiming;
};

/** Milliseconds from the call's start. Null when the call never got that far. */
export type ModelTiming = {
  /** The first streamed token of the first model call, after the agent process started. */
  firstTokenMs: number | null;
  /** When the model began writing the structured output, after reading the code. */
  outputStartMs: number | null;
  totalMs: number;
};

export type AgentRunner = (request: AgentRequest) => Promise<AgentReply>;

/** The agent stopped without an answer (max turns, max budget, an API error). Carries its cost. */
export class AgentError extends Error {
  readonly cost: CostRecord;
  constructor(message: string, cost: CostRecord) {
    super(message);
    this.cost = cost;
  }
}

/** Tools are fixed for every call: changing the set breaks prompt caching (see the session spike). */
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];

/**
 * The read-only session options. The flags stack, because no single one holds on its own
 * (docs/research/2026-11-06-session-spike.md):
 * - `tools`: only Read, Grep and Glob can run. No Bash, Edit, Write or Task. (A fork still sends
 *   the author's tool list to the model, to keep the prompt cache; Claude Code refuses any call
 *   to a tool outside this set: docs/research/2026-11-11-cheaper-questions.md.)
 * - `permissionMode: 'dontAsk'`: any call that would need approval (a read outside the cwd,
 *   say) is denied without asking. There is no `canUseTool`: under `dontAsk` it is never
 *   consulted, so it would only suggest a gate that isn't there. There is no `allowedTools`
 *   either; read-only tools inside the cwd need no approval.
 * - `strictMcpConfig` with no servers, and `settingSources: []`: the checkout's own `.claude/`
 *   settings, hooks, permissions, MCP config and CLAUDE.md never load. The code under review is
 *   data, not configuration.
 * A fork of the author's session gets exactly the same options. The author's own tools,
 * permissions and settings live in their settings files, not the transcript, so none of them
 * carry over. `forkSession` keeps the original transcript untouched, and `persistSession: false`
 * leaves no copy of it behind. The one fork Docent keeps (`keepIn`, the primer) is saved, gets one
 * turn, and is moved into a folder of its own, or deleted if it fails; the review deletes the
 * folder when it ends.
 * `src/agent.test.ts` pins these options; `src/agent.live.test.ts` proves them against a hostile
 * checkout with a real session, and proves a fork leaves the author's transcript unchanged.
 */
export function readOnlyOptions(
  request: Pick<
    AgentRequest,
    'cwd' | 'model' | 'schema' | 'resume' | 'fork' | 'keepIn' | 'maxBudgetUsd'
  >,
) {
  return {
    cwd: request.cwd,
    model: request.model,
    tools: READ_ONLY_TOOLS,
    permissionMode: 'dontAsk' as const,
    strictMcpConfig: true,
    mcpServers: {},
    settingSources: [],
    maxTurns: request.keepIn !== undefined ? 1 : 60,
    maxBudgetUsd: request.maxBudgetUsd ?? 2,
    // Token-by-token events, so the tour can show each stop as soon as it's written and checked.
    // Output only: it changes nothing about what the session may do.
    includePartialMessages: true,
    ...(request.resume ? { resume: request.resume } : {}),
    ...(request.fork
      ? { resume: request.fork, forkSession: true, persistSession: request.keepIn !== undefined }
      : {}),
    ...(request.schema
      ? { outputFormat: { type: 'json_schema' as const, schema: request.schema } }
      : {}),
  };
}

/**
 * Runs Claude Code headlessly through the Agent SDK, read-only (see `readOnlyOptions`). A kept
 * fork gets an id chosen here, before it starts, so its transcript leaves Claude Code's projects
 * folder whatever happens: moved into `keepIn` when the fork succeeds, deleted when it doesn't.
 * The id is never the forked session's, so the original can't be deleted.
 */
export const sdkRunner: AgentRunner = async (request) => {
  if (request.keepIn === undefined) return run(request);
  const id = randomUUID();
  try {
    const reply = await run(request, id);
    if (!(await keepTranscript(id, request.keepIn).catch(() => false))) {
      throw new AgentError("The fork's transcript couldn't be kept.", reply.cost);
    }
    if (reply.sessionId !== id) {
      throw new AgentError(`Claude Code didn't use the chosen session id ${id}.`, reply.cost);
    }
    return reply;
  } catch (error) {
    await discardTranscript(id).catch(() => undefined);
    // An aborted Claude Code may still be flushing its transcript as it exits.
    if (request.signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await discardTranscript(id).catch(() => undefined);
    }
    throw error;
  }
};

/** One SDK query; a fork kept by `sdkRunner` passes the id it chose. */
async function run(request: AgentRequest, keptId?: string): Promise<AgentReply> {
  // An abort listener never fires for a signal that's already aborted, so check first: an
  // expired deadline must never start a call with no time limit.
  request.signal?.throwIfAborted();
  const started = Date.now();
  const abortController = new AbortController();
  request.signal?.addEventListener('abort', () => abortController.abort());

  let model = request.model;
  let ended:
    | { ok: true; sessionId: string; text: string; structured: unknown; usage: Usage }
    | { ok: false; failure: string; usage: Usage }
    | undefined;
  let denials: string[] = [];
  let firstTokenMs: number | null = null;
  let outputStartMs: number | null = null;
  // The structured output streams in as the input of a StructuredOutput tool call. Its content
  // block index is per API message, so it resets with each message.
  let outputBlock: number | null = null;
  let output = '';
  // Each API call's usage as its assistant frames report it, for when no result message arrives.
  // Input and cache tokens are exact there; output tokens are undercounted (see `costRecord`).
  const calls = new Map<string, Usage>();
  const partialCost = () => {
    if (calls.size === 0) return null;
    const sum = (key: 'input_tokens' | 'output_tokens' | 'cache_read_input_tokens') =>
      [...calls.values()].reduce((total, u) => total + (u[key] ?? 0), 0);
    const usage: Usage = {
      input_tokens: sum('input_tokens'),
      output_tokens: sum('output_tokens'),
      cache_read_input_tokens: sum('cache_read_input_tokens'),
      cache_creation_input_tokens: [...calls.values()].reduce(
        (total, u) => total + (u.cache_creation_input_tokens ?? 0),
        0,
      ),
    };
    return costRecord(request.job, model, usage, Date.now() - started, largestPrompt());
  };
  /** The biggest single request's prompt, which sets a long-prompt price. */
  const largestPrompt = () =>
    calls.size === 0
      ? undefined
      : Math.max(
          ...[...calls.values()].map(
            (u) =>
              (u.input_tokens ?? 0) +
              (u.cache_read_input_tokens ?? 0) +
              (u.cache_creation_input_tokens ?? 0),
          ),
        );

  try {
    for await (const message of query({
      prompt: request.prompt,
      options: {
        ...readOnlyOptions(request),
        ...(keptId ? { sessionId: keptId } : {}),
        abortController,
      },
    })) {
      if (message.type === 'stream_event' && message.parent_tool_use_id === null) {
        const event = message.event;
        if (event.type === 'message_start') {
          outputBlock = null;
        } else if (event.type === 'content_block_start') {
          if (event.content_block.type === 'tool_use' && event.content_block.name === STRUCTURED) {
            outputStartMs ??= Date.now() - started;
            outputBlock = event.index;
            output = '';
          }
        } else if (event.type === 'content_block_delta') {
          firstTokenMs ??= Date.now() - started;
          if (event.index === outputBlock && event.delta.type === 'input_json_delta') {
            output += event.delta.partial_json;
            request.onOutput?.(output);
          }
        }
      } else if (message.type === 'assistant' && message.parent_tool_use_id === null) {
        model = message.message.model || model;
        if (message.message.id && message.message.usage) {
          calls.set(message.message.id, message.message.usage as Usage);
        }
        for (const block of message.message.content) {
          // Handing back the output isn't reading the code, so it isn't reported as activity.
          if (block.type === 'tool_use' && block.name !== STRUCTURED) {
            request.onActivity?.(describeTool(block.name, block.input, request.cwd));
          }
        }
      } else if (message.type === 'result') {
        denials = message.permission_denials.map((d) => d.tool_name);
        if (message.subtype === 'success' && !message.is_error) {
          ended = {
            ok: true,
            sessionId: message.session_id,
            text: message.result,
            structured: message.structured_output,
            usage: message.usage,
          };
        } else {
          // Error results (max turns, max budget) still spent tokens: record them too.
          const errors = 'errors' in message ? message.errors.join('; ') : '';
          ended = {
            ok: false,
            failure: `${message.subtype}${errors ? `: ${errors}` : ''}`,
            usage: message.usage,
          };
        }
      }
    }
  } catch (error) {
    // Thrown mid-stream (an abort, a crash): record what the calls so far cost, when known.
    const cost = partialCost();
    const reason = error instanceof Error ? error.message : String(error);
    if (cost) throw new AgentError(`The agent stopped without an answer (${reason})`, cost);
    throw error;
  }

  if (!ended) {
    const cost = partialCost();
    if (cost) throw new AgentError('The agent stopped without a result.', cost);
    throw new Error('The agent stopped without a result.');
  }
  const cost = costRecord(request.job, model, ended.usage, Date.now() - started, largestPrompt());
  if (!ended.ok)
    throw new AgentError(`The agent stopped without an answer (${ended.failure})`, cost);
  return {
    sessionId: ended.sessionId,
    text: ended.text,
    structured: ended.structured,
    cost,
    denials,
    timing: { firstTokenMs, outputStartMs, totalMs: Date.now() - started },
  };
}

/** The tool Claude Code uses to hand back output that matches `outputFormat`. */
const STRUCTURED = 'StructuredOutput';

/** The result message's usage: this turn's API calls only, even when resuming a session. */
type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } | null;
};

type Price = { input: number; output: number; cacheRead: number };

/**
 * USD per million tokens, list prices as of 2026-10. Haiku 5.5 charges 5x for a request whose
 * prompt is over 100k tokens, which every question forked from a long session is.
 */
const PRICES: Record<string, Price & { over100k?: Price }> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    over100k: { input: 0.5, output: 2.5, cacheRead: 0.05 },
  },
};

/**
 * Prices one turn's usage (K1, K2). Not from `total_cost_usd`, which includes the parent session's
 * cost on forks and resumes (see the session spike). Not from assistant frames either: their
 * `usage` is a snapshot from the start of streaming, with output tokens near zero.
 * Cache writes cost 1.25x input for 5-minute entries and 2x for 1-hour ones.
 * `promptTokens` is the largest single request's prompt, which picks a model's long-prompt
 * price. Left out, the turn's summed prompt stands in, which can only overprice.
 */
export function costRecord(
  job: Job,
  model: string,
  usage: Usage,
  latencyMs: number,
  promptTokens?: number,
): CostRecord {
  const tokens = {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens,
    cacheWrite: usage.cache_creation_input_tokens,
  };
  const oneHour = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const price = priceFor(
    model,
    promptTokens ?? tokens.input + tokens.cacheRead + tokens.cacheWrite,
  );
  const usd = price
    ? (tokens.input * price.input +
        tokens.output * price.output +
        tokens.cacheRead * price.cacheRead +
        (tokens.cacheWrite - oneHour) * price.input * 1.25 +
        oneHour * price.input * 2) /
      1e6
    : 0;
  const costMicroUsd = microUsd(Math.max(0, Math.round(usd * 1e6))) ?? (0 as MicroUsd);
  return { job, model, tokens, costMicroUsd, latencyMs };
}

/** A cost that can only be known roughly, in USD. */
export type UsdRange = { low: number; high: number };

/**
 * What asking a forked session costs, before anything runs. Questions fork a primed copy of the
 * session (see `Review`), so the costs come in two parts:
 * - `primeUsd`: priming, once per review, paid by the first question. It writes the session to
 *   the prompt cache, except Claude Code's own system prompt and tools, which every session
 *   shares and the cache already holds. Each call has its own spending cap, so this is what a
 *   budget check compares.
 * - `questionUsd`: each question, reading that cache, a few times over as it uses tools.
 */
export type ForkEstimate = { primeUsd: UsdRange; questionUsd: UsdRange };

/**
 * Calibrated on docs/research/2026-11-11-cheaper-questions.md. A 263k-token session wrote 233k
 * to prime, so about 30k were already cached; that also fits the 47k-token session's measured
 * $0.16. Writes are priced as 1-hour cache writes (2x input), what Claude Code uses on a
 * subscription; on an API key they are 1.25x, so this overestimates there, the safe direction.
 * Follow-ups read the whole session about 2 to 4.5 times: $0.03 on Haiku, $0.15–0.22 on Opus.
 */
const SHARED_PREFIX_TOKENS = 30_000;
const PRIME_SPREAD = { low: 0.95, high: 1.15 };
const QUESTION_READS = { low: 2, high: 4.5 };

/** What questions to a fork of a session this size will cost. Null for a model with no price. */
export function forkCostEstimate(model: string, contextTokens: number): ForkEstimate | null {
  const price = priceFor(model, contextTokens);
  if (!price) return null;
  const shared = Math.min(contextTokens, SHARED_PREFIX_TOKENS);
  const prime = ((contextTokens - shared) * price.input * 2 + shared * price.cacheRead) / 1e6;
  const read = (contextTokens * price.cacheRead) / 1e6;
  return {
    primeUsd: { low: prime * PRIME_SPREAD.low, high: prime * PRIME_SPREAD.high },
    questionUsd: { low: read * QUESTION_READS.low, high: read * QUESTION_READS.high },
  };
}

/** A range for people: "$2.20–2.50", or "$0.03" when both ends round the same. */
export function formatUsdRange({ low, high }: UsdRange): string {
  const [a, b] = [low.toFixed(2), high.toFixed(2)];
  return a === b ? `$${a}` : `$${a}–${b}`;
}

/** The midpoint, which a budget is checked against: the ends are a margin, not a forecast. */
export const midpoint = ({ low, high }: UsdRange) => (low + high) / 2;

const LONG_PROMPT_TOKENS = 100_000;

/** Longest matching id prefix, so `claude-opus-5-5-…` doesn't price as `claude-opus-5`. */
function priceFor(model: string, promptTokens: number): Price | undefined {
  const key = Object.keys(PRICES)
    .filter((id) => model.startsWith(id))
    .sort((a, b) => b.length - a.length)[0];
  const price = key ? PRICES[key] : undefined;
  return price && promptTokens > LONG_PROMPT_TOKENS && price.over100k ? price.over100k : price;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where Claude Code keeps session transcripts, one folder per working directory. */
export function claudeProjectsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
}

/** Claude Code's project folders. None for an id that isn't a UUID, so no path escapes them. */
async function projectFolders(sessionId: string): Promise<string[]> {
  if (!UUID.test(sessionId)) return [];
  const projects = claudeProjectsDir();
  const names = await readdir(projects).catch(() => []);
  return names.map((name) => join(projects, name));
}

/** The project folders holding a saved session's transcript. */
async function savedAt(sessionId: string): Promise<string[]> {
  return (await projectFolders(sessionId)).filter((dir) =>
    existsSync(join(dir, `${sessionId}.jsonl`)),
  );
}

/**
 * Moves a saved session's transcript out of Claude Code's projects folder into `into`. Its
 * folder of tool results, if any, is deleted. False if it isn't there; throws if the move fails,
 * leaving the caller to discard it.
 */
export async function keepTranscript(sessionId: string, into: string): Promise<boolean> {
  const [dir] = await savedAt(sessionId);
  if (!dir) return false;
  const from = join(dir, `${sessionId}.jsonl`);
  const to = join(into, `${sessionId}.jsonl`);
  // A rename can't cross volumes; a copy then a delete can.
  await rename(from, to).catch(async () => {
    await copyFile(from, to);
    await rm(from);
  });
  await rm(join(dir, sessionId), { recursive: true, force: true });
  return true;
}

/** Deletes a saved session's transcript, and its tool results, from Claude Code's projects. */
export async function discardTranscript(sessionId: string): Promise<void> {
  for (const dir of await projectFolders(sessionId)) {
    await rm(join(dir, `${sessionId}.jsonl`), { force: true });
    await rm(join(dir, sessionId), { recursive: true, force: true });
  }
}

function describeTool(name: string, input: unknown, cwd: string): string {
  const args = (input ?? {}) as Record<string, unknown>;
  const target = String(args.file_path ?? args.pattern ?? args.path ?? '').replace(`${cwd}/`, '');
  const verb = name === 'Read' ? 'Reading' : name === 'Grep' ? 'Searching for' : 'Looking for';
  return target ? `${verb} ${target}` : verb;
}
