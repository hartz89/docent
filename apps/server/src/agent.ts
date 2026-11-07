// The boundary to the model. Everything Docent asks an agent goes through an AgentRunner, so tests
// can swap in a scripted runner and never make a model call.
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { CostRecord, Job } from '@docent/core';

export type AgentRequest = {
  job: Job;
  prompt: string;
  /** The checkout the agent may read. It can't write anywhere. */
  cwd: string;
  model: string;
  /** JSON Schema for structured output. Leave out for a plain-text answer. */
  schema?: Record<string, unknown>;
  /** Continue an earlier session, as the checker loop does when it sends back problems. */
  resume?: string;
  /** Called with short descriptions of what the agent is doing, like "Reading src/cors.ts". */
  onActivity?: (activity: string) => void;
  signal?: AbortSignal;
};

export type AgentReply = {
  sessionId: string;
  text: string;
  /** The parsed structured output, when a schema was given. */
  structured: unknown;
  cost: CostRecord;
};

export type AgentRunner = (request: AgentRequest) => Promise<AgentReply>;

/** Tools are fixed for every call: changing the set breaks prompt caching (see the session spike). */
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];

/**
 * Runs Claude Code headlessly through the Agent SDK, read-only. The flags stack, because no single
 * one holds on its own (docs/research/2026-11-06-session-spike.md):
 * - only Read, Grep and Glob exist in the session;
 * - `dontAsk` denies anything not pre-approved, and `canUseTool` denies whatever would still ask;
 * - no MCP servers, and no filesystem settings, so the checkout's own `.claude/` hooks,
 *   permissions and CLAUDE.md never load. The code under review is data, not configuration.
 */
export const sdkRunner: AgentRunner = async (request) => {
  const started = Date.now();
  const abortController = new AbortController();
  request.signal?.addEventListener('abort', () => abortController.abort());

  let model = request.model;
  let result: { sessionId: string; text: string; structured: unknown; usage: Usage } | undefined;
  let failure: string | undefined;

  for await (const message of query({
    prompt: request.prompt,
    options: {
      cwd: request.cwd,
      model: request.model,
      tools: READ_ONLY_TOOLS,
      permissionMode: 'dontAsk',
      canUseTool: async (toolName) => ({
        behavior: 'deny',
        message: `${toolName} is not available: this session is read-only.`,
      }),
      strictMcpConfig: true,
      mcpServers: {},
      settingSources: [],
      maxTurns: 60,
      maxBudgetUsd: 2,
      abortController,
      ...(request.resume ? { resume: request.resume } : {}),
      ...(request.schema
        ? { outputFormat: { type: 'json_schema' as const, schema: request.schema } }
        : {}),
    },
  })) {
    if (message.type === 'assistant' && message.parent_tool_use_id === null) {
      model = message.message.model || model;
      for (const block of message.message.content) {
        if (block.type === 'tool_use') {
          request.onActivity?.(describeTool(block.name, block.input, request.cwd));
        }
      }
    } else if (message.type === 'result') {
      if (message.subtype === 'success' && !message.is_error) {
        result = {
          sessionId: message.session_id,
          text: message.result,
          structured: message.structured_output,
          usage: message.usage,
        };
      } else {
        const errors = 'errors' in message ? message.errors.join('; ') : '';
        failure = `${message.subtype}${errors ? `: ${errors}` : ''}`;
      }
    }
  }

  if (!result) throw new Error(`The agent stopped without an answer (${failure ?? 'no result'})`);
  const { usage, ...answer } = result;
  return { ...answer, cost: costRecord(request.job, model, usage, Date.now() - started) };
};

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
  return { job, model, tokens, costMicroUsd: Math.round(usd * 1e6), latencyMs };
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
