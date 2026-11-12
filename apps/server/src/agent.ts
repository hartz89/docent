// The boundary to the model. Everything Docent asks an agent goes through an AgentRunner, so tests
// can swap in a scripted runner and never make a model call.
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
    }
  | {
      /**
       * Fork someone else's session, the PR author's: the agent sees its whole history, and the
       * original transcript is never written to. The fork itself isn't saved either.
       */
      fork: string;
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
 * - `tools`: only Read, Grep and Glob exist in the session. No Bash, Edit, Write or Task.
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
 * leaves no copy of it behind.
 * `src/agent.test.ts` pins these options; `src/agent.live.test.ts` proves them against a hostile
 * checkout with a real session, and proves a fork leaves the author's transcript unchanged.
 */
export function readOnlyOptions(
  request: Pick<AgentRequest, 'cwd' | 'model' | 'schema' | 'resume' | 'fork' | 'maxBudgetUsd'>,
) {
  return {
    cwd: request.cwd,
    model: request.model,
    tools: READ_ONLY_TOOLS,
    permissionMode: 'dontAsk' as const,
    strictMcpConfig: true,
    mcpServers: {},
    settingSources: [],
    maxTurns: 60,
    maxBudgetUsd: request.maxBudgetUsd ?? 2,
    // Token-by-token events, so the tour can show each stop as soon as it's written and checked.
    // Output only: it changes nothing about what the session may do.
    includePartialMessages: true,
    ...(request.resume ? { resume: request.resume } : {}),
    ...(request.fork ? { resume: request.fork, forkSession: true, persistSession: false } : {}),
    ...(request.schema
      ? { outputFormat: { type: 'json_schema' as const, schema: request.schema } }
      : {}),
  };
}

/** Runs Claude Code headlessly through the Agent SDK, read-only (see `readOnlyOptions`). */
export const sdkRunner: AgentRunner = async (request) => {
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
    return costRecord(request.job, model, usage, Date.now() - started);
  };

  try {
    for await (const message of query({
      prompt: request.prompt,
      options: { ...readOnlyOptions(request), abortController },
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
          if (block.type === 'tool_use') {
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
  const cost = costRecord(request.job, model, ended.usage, Date.now() - started);
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
};

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

/** USD per million tokens, list prices as of 2026-10. */
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

/**
 * Prices one turn's usage (K1, K2). Not from `total_cost_usd`, which includes the parent session's
 * cost on forks and resumes (see the session spike). Not from assistant frames either: their
 * `usage` is a snapshot from the start of streaming, with output tokens near zero.
 * Cache writes cost 1.25x input for 5-minute entries and 2x for 1-hour ones.
 */
export function costRecord(job: Job, model: string, usage: Usage, latencyMs: number): CostRecord {
  const tokens = {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens,
    cacheWrite: usage.cache_creation_input_tokens,
  };
  const oneHour = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const price = priceFor(model);
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

/**
 * What a fork's first call costs, before it runs: it writes the parent's whole context to the
 * prompt cache. Priced as a 1-hour cache write (2x input), which is what Claude Code uses on a
 * subscription by default (the SDK's `promptCacheTtl`: "1 hour on a Claude subscription"). The
 * PR #17 live run agrees: 196k written tokens at 2x account for its $1.63. On an API key writes
 * are 5-minute (1.25x), so this overestimates there, which is the safe direction.
 * Null for a model with no known price.
 */
export function forkCostEstimateUsd(model: string, contextTokens: number): number | null {
  const price = priceFor(model);
  return price ? (contextTokens * price.input * 2) / 1e6 : null;
}

/** Longest matching id prefix, so `claude-opus-5-5-…` doesn't price as `claude-opus-5`. */
function priceFor(model: string) {
  const key = Object.keys(PRICES)
    .filter((id) => model.startsWith(id))
    .sort((a, b) => b.length - a.length)[0];
  return key ? PRICES[key] : undefined;
}

function describeTool(name: string, input: unknown, cwd: string): string {
  const args = (input ?? {}) as Record<string, unknown>;
  const target = String(args.file_path ?? args.pattern ?? args.path ?? '').replace(`${cwd}/`, '');
  const verb = name === 'Read' ? 'Reading' : name === 'Grep' ? 'Searching for' : 'Looking for';
  return target ? `${verb} ${target}` : verb;
}
