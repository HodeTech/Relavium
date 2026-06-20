/**
 * The **agent turn core** (1.O) — a correlation-key-agnostic driver for one agent's LLM turn(s):
 * assemble → call the seam → fold the stream into `agent:*` events → run the tool-call loop →
 * return the settled content. It is deliberately **independent of the run vs session correlation
 * key** ([ADR-0024](../../../../docs/decisions/0024-agent-first-entry-point-agentsession.md)/0025/0026):
 * it takes `messages` + `tools` + the per-execution fallback plan + `emit` + `signal` + `nodeId` +
 * the tool registry + `limits`, and emits **envelope-less** {@link NodeStreamEvent} bodies — so the
 * `AgentRunner` ({@link ./agent-runner.ts}) wraps it for the workflow run path and `AgentSession`
 * (1.V) reuses it unchanged for the chat path. Run-only concerns (`run.outputs` taint placement, the
 * run-correlated `agent:file_patch_proposed`, `output_schema` validation against `run.outputs`) live
 * in that adapter, never here.
 *
 * It owns the cost path ([ADR-0038](../../../../docs/decisions/0038-agentrunner-llm-call-boundary.md)):
 * it builds one {@link CostTracker} per turn and wires its own `onAttempt` to emit a `cost:updated`
 * per non-skipped attempt — the host never supplies a (shared) tracker. The reasoning `ContentPart`
 * of each assistant turn is carried back into the next request on a same-provider tool-loop
 * continuation ([ADR-0039](../../../../docs/decisions/0039-same-provider-reasoning-replay.md)); the
 * `FallbackChain` strips it on a cross-provider advance.
 *
 * NOTE (model attribution): `cost:updated` always carries the **accurate per-attempt** model (it is
 * emitted from the attempt record), and `agent:tool_call` is emitted *after* the stream settles (the
 * succeeding attempt record has already updated `activeModel`), so it is accurate too. Only
 * **`agent:token`** carries `activeModel` mid-stream — correct for the common (no-failover) and
 * same-model-retry cases, but a *cross-model pre-content failover* attributes the streamed tokens to
 * the prior model until the succeeding record updates it (a recorded edge — the accurate per-attempt
 * source is always `cost:updated`).
 */

import type {
  AbortSignalLike,
  ContentPart,
  ErrorCode,
  OutputModality,
  StopReason,
} from '@relavium/shared';
import {
  CostTracker,
  FallbackChain,
  LlmProviderError,
  type AttemptRecord,
  type FallbackChainOptions,
  type FallbackPlanEntry,
  type LlmError,
  type LlmMessage,
  type LlmRequest,
  type MediaUnitsEstimate,
  type ResponseFormat,
  type StreamChunk,
  type ToolDef as LlmToolDef,
} from '@relavium/llm';

import { ToolDispatchError } from '../tools/errors.js';
import type { ToolCallPart, ToolDispatchContext, ToolRegistry } from '../tools/types.js';
import { unwrapUntrusted } from '../tools/untrusted.js';
import { BudgetExceededError, BudgetPauseError } from './budget-governor.js';
import type { NodeStreamEvent } from './node-executor.js';

/**
 * Loop bounds for one agent turn. The authored hard cap + the `turn_limit` surfacing is the 1.V knob.
 *
 * The two bounds are **not multiplicative** — `maxToolTurns` is the worst-case **egress ceiling** (the
 * tool loop engages a provider at most `maxToolTurns + 1` times before the guard fails the turn with
 * `turn_limit`), while `maxToolCorrections` is a **monotonic sub-budget** *within* that loop: a
 * model-correctable tool error (`unknown_tool` / `invalid_args`) increments it and, once exceeded, ends
 * the turn EARLY with `tool_failed`. A genuine (non-correctable) tool round never resets it, so
 * corrections accumulate across interleaved genuine rounds. Net worst-case egress is `maxToolTurns + 1`
 * provider calls regardless of `maxToolCorrections` — the correction budget can only *shorten* a turn,
 * never extend its egress (so the DoS bound is the turn budget alone, not the product of the two).
 */
export interface AgentTurnLimits {
  /** Max tool-loop continuations before the run-default DoS guard fails the turn (`turn_limit`). */
  readonly maxToolTurns: number;
  /** Max model-correctable tool-error rounds (`unknown_tool` / `invalid_args`) before escalating. */
  readonly maxToolCorrections: number;
}

/** The run-default loop bounds (1.O). 1.V overrides these via the same `limits` param — no restructuring. */
export const DEFAULT_AGENT_TURN_LIMITS: AgentTurnLimits = {
  maxToolTurns: 16,
  maxToolCorrections: 3,
};

/**
 * The pre-egress budget hook ([ADR-0028](../../../../docs/decisions/0028-workflow-resource-governance.md),
 * widened by [ADR-0044](../../../../docs/decisions/0044-media-access-governance-read-media-save-to-cost.md)
 * §3 for the per-modality media cost) — called immediately before every seam call. In 1.O the default is a
 * no-op that always permits; 1.AC replaces it with the estimator and may throw an {@link AgentTurnError}
 * (`budget_exceeded`) to halt. `outputModalities` + `mediaUnitsEstimate` (1.AF/D17) are populated by the
 * AgentRunner from the node's `output_modalities` + the `[defaults].media_cost_estimate` unit counts so the
 * governor can fold a media cost estimate into the projected total; both absent ⇒ a text-only turn.
 */
export type PreEgressHook = (info: {
  readonly model: string;
  readonly maxTokens?: number;
  readonly outputModalities?: readonly OutputModality[];
  readonly mediaUnitsEstimate?: readonly MediaUnitsEstimate[];
}) => void | Promise<void>;

/** The chain capabilities the host supplies (the platform-level subset of {@link FallbackChainOptions}). */
export type ChainCapabilities = Pick<
  FallbackChainOptions,
  'keyFor' | 'sleep' | 'now' | 'onAuthError' | 'resolveForEgress'
>;

/** Everything one agent turn needs — no run/session correlation key, no `NodeExecContext`. */
export interface AgentTurnParams {
  /** Authored system text ONLY (agent `system_prompt` + node `system_prompt_append`) — never untrusted data. */
  readonly system?: string;
  /** The initial conversation. The core appends assistant + tool messages across the loop on a copy. */
  readonly messages: readonly LlmMessage[];
  /** LLM-visible tool defs for the request (already normalized + narrowed to the node's grant). */
  readonly tools?: readonly LlmToolDef[];
  /** The ordered fallback plan (primary + fallbacks), providers already resolved to instances. */
  readonly planEntries: readonly FallbackPlanEntry[];
  /** The host-supplied chain capabilities; the core adds its own `costTracker` + `onAttempt`. */
  readonly chainCapabilities: ChainCapabilities;
  /** Lowered from the node's `output_schema` (request-side hint; validation is node-side, in the adapter). */
  readonly responseFormat?: ResponseFormat;
  /** Per-turn generation knobs (node-over-agent precedence is resolved by the caller). */
  readonly temperature?: number;
  readonly maxTokens?: number;
  /** The id stamped on emitted events (a workflow vertex id on the run path; a synthetic id on a session). */
  readonly nodeId: string;
  /** Emit an envelope-less streaming event; the engine/bus attaches the correlation key + sequence. */
  readonly emit: (event: NodeStreamEvent) => void;
  /** Cooperative cancellation — threaded into every seam call (via the request) and tool dispatch. */
  readonly signal: AbortSignalLike;
  /** The shared tool registry (1.T) and the dispatch context for this node (the core adds `signal`). */
  readonly registry: ToolRegistry;
  readonly dispatchContext: Omit<ToolDispatchContext, 'signal'>;
  /** Loop bounds (default {@link DEFAULT_AGENT_TURN_LIMITS}). */
  readonly limits: AgentTurnLimits;
  /** Pre-egress budget hook (default no-op; 1.AC fills it). */
  readonly preEgress?: PreEgressHook;
  /**
   * The non-text output the node requested (1.AF/D17) — forwarded to {@link PreEgressHook} so the budget
   * governor knows this is a media-output turn. The AgentRunner lowers it from the node's `output_modalities`.
   */
  readonly outputModalities?: readonly OutputModality[];
  /**
   * The per-modality media-unit estimate (1.AF/D17) the governor prices into the projected pre-egress cost,
   * built by the AgentRunner from `output_modalities` + the `[defaults].media_cost_estimate` unit counts.
   */
  readonly mediaUnitsEstimate?: readonly MediaUnitsEstimate[];
}

/** What one settled agent turn produced. */
export interface AgentTurnResult {
  /** The final assistant content parts (text + any reasoning), in order. */
  readonly content: readonly ContentPart[];
  /** The concatenated assistant text — the node's primary output when there is no `output_schema`. */
  readonly text: string;
  /** Aggregate token usage summed across the turn's successful attempts. */
  readonly usage: { readonly input: number; readonly output: number };
  /** The committed model id (the last attempt that produced content). */
  readonly model: string;
  /** The final stop reason. */
  readonly stopReason: StopReason;
}

/**
 * A classified turn failure. Carries a closed {@link ErrorCode} + a user-safe, secret-free message;
 * the run-path adapter maps it to a `NodeOutcome.failed`. The internal correlation id rides the
 * event, never this message.
 */
export class AgentTurnError extends Error {
  override readonly name = 'AgentTurnError';
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** Map a classified `LlmError` (chain-exhausted) to the node `ErrorCode` taxonomy (never `error.message`). */
function codeForLlmError(error: LlmError): ErrorCode {
  switch (error.kind) {
    case 'auth':
      return 'provider_auth';
    case 'rate_limit':
      return 'provider_rate_limit';
    case 'overloaded':
    case 'timeout':
    case 'transport':
      return 'provider_unavailable';
    case 'cancelled':
      return 'cancelled';
    case 'content_filter':
      return 'content_filter'; // a provider content-policy block — its own fatal cause (1.AG/ADR-0045 §6), not `validation`
    case 'bad_request':
      return 'validation';
    case 'unknown':
      return 'internal';
  }
}

/** A tool throw the model can correct by seeing an `isError` tool result and trying again. */
function isModelCorrectable(err: ToolDispatchError): boolean {
  return err.code === 'unknown_tool' || err.code === 'invalid_args';
}

/** Map a non-correctable tool throw to the node `ErrorCode` (cancel wins; a denial is fatal). */
function codeForToolError(err: ToolDispatchError): { code: ErrorCode; retryable: boolean } {
  switch (err.code) {
    case 'cancelled':
      return { code: 'cancelled', retryable: false };
    case 'tool_denied':
      return { code: 'tool_denied', retryable: false };
    case 'capability_unavailable':
      return { code: 'internal', retryable: false };
    case 'execution_failed':
      return { code: 'tool_failed', retryable: true };
    default:
      // unknown_tool / invalid_args reach here only after the correction budget is spent.
      return { code: 'tool_failed', retryable: false };
  }
}

/** Accumulator for one assistant turn's streamed parts (text + tool calls + reasoning), by delta id. */
interface TurnAccumulator {
  text: string;
  readonly toolArgs: Map<string, { name: string; json: string }>;
  readonly toolOrder: string[];
  readonly reasoning: Map<string, { text: string; signature?: string; redacted?: boolean }>;
  readonly reasoningOrder: string[];
}

function newAccumulator(): TurnAccumulator {
  return { text: '', toolArgs: new Map(), toolOrder: [], reasoning: new Map(), reasoningOrder: [] };
}

/** Parse accumulated tool-call argument JSON; a malformed/empty delta yields `{}` (the dispatcher validates). */
function parseToolArgs(json: string): unknown {
  if (json.length === 0) return {};
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return {};
  }
}

/** Fold the accumulator into ordered assistant content parts (reasoning, then text, then tool calls). */
function accumulatorToContent(acc: TurnAccumulator): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const id of acc.reasoningOrder) {
    const r = acc.reasoning.get(id);
    if (r === undefined) continue;
    parts.push({
      type: 'reasoning',
      text: r.text,
      ...(r.signature === undefined ? {} : { signature: r.signature }),
      ...(r.redacted === undefined ? {} : { redacted: r.redacted }),
    });
  }
  if (acc.text.length > 0) parts.push({ type: 'text', text: acc.text });
  for (const id of acc.toolOrder) {
    const call = acc.toolArgs.get(id);
    if (call === undefined) continue;
    parts.push({ type: 'tool_call', id, name: call.name, args: parseToolArgs(call.json) });
  }
  return parts;
}

/** The concatenated text of the assistant content parts. */
function textOf(content: readonly ContentPart[]): string {
  return content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

function throwIfAborted(signal: AbortSignalLike): void {
  if (signal.aborted) throw new AgentTurnError('cancelled', 'the run was cancelled', false);
}

/** Build the per-iteration `LlmRequest` from the current message list + the turn's static fields. */
function buildRequest(messages: readonly LlmMessage[], params: AgentTurnParams): LlmRequest {
  return {
    model: params.planEntries[0]?.model ?? '',
    ...(params.system === undefined ? {} : { system: params.system }),
    messages: [...messages],
    // A media-output turn is single-shot/terminal (1.AG/ADR-0046): it runs one `generate()` with no tool
    // loop, so offering tools is meaningless and would invite an unrunnable `tool_use` stop. Omit them — a
    // text turn (the only other `buildRequest` caller, via `streamOneTurn`) keeps its tool grant.
    ...(params.tools === undefined || requestsMediaOutput(params)
      ? {}
      : { tools: [...params.tools] }),
    ...(params.responseFormat === undefined ? {} : { responseFormat: params.responseFormat }),
    ...(params.temperature === undefined ? {} : { temperature: params.temperature }),
    ...(params.maxTokens === undefined ? {} : { maxTokens: params.maxTokens }),
    // Lower the node's requested non-text output onto the request (1.AF/D15) so the FallbackChain
    // per-attempt capability pre-skip (requestSupportReason → outputCombinationReason) can skip a model
    // that cannot emit the combination — the runtime backstop the load-check defers to (ADR-0044 §2). Without
    // this the request carries no outputModalities and an incapable model would silently return text.
    ...(params.outputModalities === undefined
      ? {}
      : { outputModalities: [...params.outputModalities] }),
    signal: params.signal,
  };
}

/**
 * Consume one streamed attempt: emit `agent:token` per text delta, accumulate text / tool-call /
 * reasoning parts, and resolve with the assistant content + stop reason. A terminal `error` chunk
 * (the chain exhausted) becomes a classified {@link AgentTurnError}.
 */
async function streamOneTurn(
  chain: FallbackChain,
  messages: readonly LlmMessage[],
  params: AgentTurnParams,
  getModel: () => string,
): Promise<{ content: ContentPart[]; stopReason: StopReason }> {
  const acc = newAccumulator();
  let stopReason: StopReason = 'stop';
  for await (const chunk of chain.stream(buildRequest(messages, params))) {
    foldChunk(chunk, acc, params, getModel);
    if (chunk.type === 'error') {
      throwMappedChainError(chunk.error);
    }
    if (chunk.type === 'stop') stopReason = chunk.stopReason;
  }
  return { content: accumulatorToContent(acc), stopReason };
}

/**
 * Run one **inline media-out** turn via the chain's existing non-streaming `generate()` (1.AG/[ADR-0046]):
 * a `media_surface: 'chat'` model emitting media IN the turn (Gemini `responseModalities`, OpenAI inline
 * audio). The settled `LlmResult.content` carries in-flight base64 `media` parts; the engine de-inlines
 * them to `media://` handles at `node:completed.output` (the 1.AF `#emitDurable` choke point). It is
 * **terminal/single-shot** — no token streaming, no further tool round (the tool loop is built around
 * `stream()`). Errors map identically to the streamed path: `generate()` throws an `LlmProviderError`
 * whose `.llmError.cause` preserves a budget/turn error symmetrically with `stream()`'s error chunk.
 */
async function generateOneTurn(
  chain: FallbackChain,
  messages: readonly LlmMessage[],
  params: AgentTurnParams,
): Promise<{ content: ContentPart[]; stopReason: StopReason }> {
  try {
    const result = await chain.generate(buildRequest(messages, params));
    return { content: result.content, stopReason: result.stopReason };
  } catch (err) {
    if (err instanceof LlmProviderError) {
      throwMappedChainError(err.llmError);
    }
    throw err;
  }
}

/** Map a chain failure — a streamed `error` chunk or a thrown `generate()` error — into the turn taxonomy. */
function throwMappedChainError(error: LlmError): never {
  // A pre-egress budget hook may throw its own AgentTurnError or Budget*Error; preserve it rather than
  // remapping the wrapped LlmError to a generic internal code.
  if (error.cause instanceof AgentTurnError) {
    throw error.cause;
  }
  if (error.cause instanceof BudgetExceededError) {
    throw new AgentTurnError('budget_exceeded', error.cause.message, false);
  }
  if (error.cause instanceof BudgetPauseError) {
    throw error.cause;
  }
  throw new AgentTurnError(codeForLlmError(error), error.message, error.retryable);
}

/**
 * True when the node authored a non-text output modality — the inline media-out routing signal (1.AG).
 *
 * NOTE (Section C): ADR-0046 §1's full condition is `media_surface: 'chat'` **and** a non-text
 * `output_modalities`. In Section B every media-capable model is `surface: 'chat'`, so this conjunct is
 * vacuously true and omitted. When the generative dispatch lands (Section C, ADR-0045), this guard must
 * additionally require the resolved model's `media_surface === 'chat'` — a `'generative'` model routes to
 * `generateMedia`, not to the inline `generate()` path here.
 */
function requestsMediaOutput(params: AgentTurnParams): boolean {
  return params.outputModalities?.some((m) => m !== 'text') ?? false;
}

/** Fold a single stream chunk into the accumulator, emitting `agent:token` for visible text deltas. */
function foldChunk(
  chunk: StreamChunk,
  acc: TurnAccumulator,
  params: AgentTurnParams,
  getModel: () => string,
): void {
  if (chunk.type === 'text_delta') {
    acc.text += chunk.text;
    params.emit({
      type: 'agent:token',
      nodeId: params.nodeId,
      token: chunk.text,
      model: getModel(),
    });
    return;
  }
  foldToolCallChunk(chunk, acc);
  foldReasoningChunk(chunk, acc);
  // tool_call_end / stop / error / media_* / tool_result are no-ops in both sub-folders.
}

/** Accumulate a `tool_call_*` delta into the in-progress tool call (by id), preserving emission order. */
function foldToolCallChunk(chunk: StreamChunk, acc: TurnAccumulator): void {
  if (chunk.type === 'tool_call_start') {
    if (!acc.toolArgs.has(chunk.id)) {
      acc.toolArgs.set(chunk.id, { name: chunk.name, json: '' });
      acc.toolOrder.push(chunk.id);
    }
    return;
  }
  if (chunk.type === 'tool_call_delta') {
    const call = acc.toolArgs.get(chunk.id);
    if (call !== undefined) call.json += chunk.argsJsonDelta;
  }
}

/** Accumulate a `reasoning_*` delta; `reasoning_end` carries the optional signature / redacted flag. */
function foldReasoningChunk(chunk: StreamChunk, acc: TurnAccumulator): void {
  if (chunk.type === 'reasoning_start') {
    if (!acc.reasoning.has(chunk.id)) {
      acc.reasoning.set(chunk.id, { text: '' });
      acc.reasoningOrder.push(chunk.id);
    }
    return;
  }
  if (chunk.type === 'reasoning_delta') {
    const r = acc.reasoning.get(chunk.id);
    if (r !== undefined) r.text += chunk.text;
    return;
  }
  if (chunk.type === 'reasoning_end') {
    const r = acc.reasoning.get(chunk.id);
    if (r !== undefined) {
      if (chunk.signature !== undefined) r.signature = chunk.signature;
      if (chunk.redacted !== undefined) r.redacted = chunk.redacted;
    }
  }
}

/**
 * Dispatch each tool call of a tool-use turn through the registry, emitting `agent:tool_call` /
 * `agent:tool_result` and returning the `role:'tool'` result messages. A model-correctable throw
 * (`unknown_tool` / `invalid_args`) is converted to an `isError` tool result fed back for the model
 * to self-correct (the caller bounds how many such rounds); any other throw is a classified
 * {@link AgentTurnError} (cancel wins; a denial is fatal).
 */
async function dispatchToolCalls(
  toolCalls: readonly ToolCallPart[],
  params: AgentTurnParams,
  getModel: () => string,
  attemptNumber: number,
): Promise<{ messages: LlmMessage[]; correctable: boolean }> {
  const results: LlmMessage[] = [];
  let correctable = false;
  for (const call of toolCalls) {
    throwIfAborted(params.signal);
    try {
      const outcome = await params.registry.dispatch(call, {
        ...params.dispatchContext,
        signal: params.signal,
      });
      // Emit AFTER dispatch: the registry's `events.call.toolInput` is the SANITIZED payload
      // (config-only + secret-tainted keys stripped — registry `sanitizeInput`), never the raw model
      // args, so the event contract that `agent:tool_call.toolInput` carries no secrets holds.
      params.emit({
        type: 'agent:tool_call',
        nodeId: params.nodeId,
        model: getModel(),
        toolId: outcome.events.call.toolId,
        toolInput: outcome.events.call.toolInput,
        attemptNumber,
      });
      const part = unwrapUntrusted(outcome.toolResult);
      results.push({ role: 'tool', content: [part] });
      params.emit({
        type: 'agent:tool_result',
        nodeId: params.nodeId,
        toolId: outcome.events.result.toolId,
        success: outcome.events.result.success,
        outputSummary: outcome.events.result.outputSummary,
        attemptNumber,
      });
    } catch (err) {
      // No registry outcome ⇒ no sanitized payload (resolve / grant / policy / args rejected before
      // dispatch). Announce the attempted call with a REDACTED (empty) input — never the raw model
      // args — then classify.
      params.emit({
        type: 'agent:tool_call',
        nodeId: params.nodeId,
        model: getModel(),
        toolId: call.name,
        toolInput: {},
        attemptNumber,
      });
      if (err instanceof ToolDispatchError && isModelCorrectable(err)) {
        correctable = true;
        results.push({
          role: 'tool',
          content: [
            { type: 'tool_result', toolCallId: call.id, result: err.message, isError: true },
          ],
        });
        params.emit({
          type: 'agent:tool_result',
          nodeId: params.nodeId,
          toolId: call.name,
          success: false,
          outputSummary: err.message,
          attemptNumber,
        });
        continue;
      }
      const { code, retryable } =
        err instanceof ToolDispatchError
          ? codeForToolError(err)
          : { code: 'internal' as const, retryable: false };
      const message = err instanceof Error ? err.message : 'tool dispatch failed';
      throw new AgentTurnError(code, message, retryable);
    }
  }
  return { messages: results, correctable };
}

/**
 * Await the pre-egress budget hook before a provider call, mapping a budget-cap failure to the closed turn
 * error taxonomy: a {@link BudgetExceededError} (`on_exceed: fail`) → `AgentTurnError('budget_exceeded')`;
 * a {@link BudgetPauseError} (`pause_for_approval`) and any other error propagate as-is (the run path maps
 * the pause to a `paused` node outcome). Extracted from the turn loop to keep its complexity in budget.
 */
async function awaitPreEgress(params: AgentTurnParams, activeModel: string): Promise<void> {
  try {
    await params.preEgress?.({
      model: activeModel,
      ...(params.maxTokens === undefined ? {} : { maxTokens: params.maxTokens }),
      ...(params.outputModalities === undefined
        ? {}
        : { outputModalities: params.outputModalities }),
      ...(params.mediaUnitsEstimate === undefined
        ? {}
        : { mediaUnitsEstimate: params.mediaUnitsEstimate }),
    });
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      throw new AgentTurnError('budget_exceeded', err.message, false);
    }
    throw err;
  }
}

/**
 * Append a tool-use assistant turn, dispatch its tool calls, append the results to `messages`, and return
 * the updated correction count. Throws a classified {@link AgentTurnError} on a protocol anomaly (a
 * `tool_use` stop with no tool call) or once the model-correction budget is exhausted. Extracted from the
 * turn loop to keep {@link runAgentTurn} within its cognitive-complexity budget.
 */
async function dispatchToolUseTurn(
  turnContent: ContentPart[],
  messages: LlmMessage[],
  params: AgentTurnParams,
  activeModel: () => string,
  nonSkippedAttempts: number,
  corrections: number,
): Promise<number> {
  // Append the assistant turn (incl. reasoning — carried for the same-provider replay, ADR-0039).
  messages.push({ role: 'assistant', content: turnContent });
  const toolCalls = turnContent.filter((p): p is ToolCallPart => p.type === 'tool_call');
  if (toolCalls.length === 0) {
    // A `tool_use` stop with no tool-call parts is a provider protocol anomaly — re-looping would burn up
    // to `maxToolTurns` paid egress calls with no progress, so fail loudly instead.
    throw new AgentTurnError(
      'provider_unavailable',
      'the model signalled a tool_use stop but produced no tool call',
      false,
    );
  }
  // A reached `tool_use` stop always followed a successful (non-skipped) attempt, so `nonSkippedAttempts >= 1`.
  const dispatched = await dispatchToolCalls(toolCalls, params, activeModel, nonSkippedAttempts);
  let next = corrections;
  if (dispatched.correctable) {
    next += 1;
    if (next > params.limits.maxToolCorrections) {
      throw new AgentTurnError(
        'tool_failed',
        `agent exceeded the ${params.limits.maxToolCorrections}-round tool-correction budget`,
        false,
      );
    }
  }
  messages.push(...dispatched.messages);
  return next;
}

/**
 * Drive one agent turn end to end. Resolves with the settled {@link AgentTurnResult}, or throws an
 * {@link AgentTurnError} classified to the closed `ErrorCode` taxonomy (the caller maps it to a node
 * failure). Never throws a raw error for a classified condition.
 */
export async function runAgentTurn(params: AgentTurnParams): Promise<AgentTurnResult> {
  const primaryModel = params.planEntries[0]?.model;
  if (primaryModel === undefined) {
    throw new AgentTurnError('internal', 'agent turn has no fallback-plan entries', false);
  }

  // The cost path is the core's, not the host's: one tracker per turn, one cost:updated per
  // non-skipped attempt (attemptNumber counts non-skipped records, not the positional index).
  const costTracker = new CostTracker();
  let activeModel = primaryModel;
  let nonSkippedAttempts = 0;
  let totalInput = 0;
  let totalOutput = 0;

  const onAttempt = (record: AttemptRecord): void => {
    // A SKIPPED entry (cooldown / capability) was not invoked — it must not become `activeModel`, or
    // the next entry's streamed tokens would be mis-attributed to a provider that never ran.
    if (record.outcome === 'skipped') return;
    activeModel = record.model;
    nonSkippedAttempts += 1;
    if (record.usage === undefined) return;
    totalInput += record.usage.inputTokens;
    totalOutput += record.usage.outputTokens;
    // The chain already folded this attempt's usage into our `costTracker` and put the per-attempt
    // figure on `record.cost`; read it rather than re-recording (which would double the total).
    params.emit({
      type: 'cost:updated',
      nodeId: params.nodeId,
      model: record.model,
      inputTokens: record.usage.inputTokens,
      outputTokens: record.usage.outputTokens,
      costMicrocents: record.cost?.costMicrocents ?? 0,
      // Placeholder — the engine owns the run-wide running total and overwrites this authoritatively.
      cumulativeCostMicrocents: 0,
      attemptNumber: nonSkippedAttempts,
    });
  };

  const preEgress = params.preEgress;
  const chain = new FallbackChain([...params.planEntries], {
    ...params.chainCapabilities,
    costTracker,
    onAttempt,
    // The pre-egress budget hook runs before EVERY provider attempt, not just the first turn, so a failover
    // to a more expensive model is also gated (1.AC). The chain's PreAttemptHook only supplies `{ model,
    // maxTokens }`, so wrap the hook to also carry the turn-static media estimate (1.AF/D17) — otherwise the
    // failover-attempt budget check would silently drop the media addend (ADR-0044 §3).
    ...(preEgress === undefined
      ? {}
      : {
          preAttempt: (info: { readonly model: string; readonly maxTokens?: number }) =>
            preEgress({
              ...info,
              ...(params.outputModalities === undefined
                ? {}
                : { outputModalities: params.outputModalities }),
              ...(params.mediaUnitsEstimate === undefined
                ? {}
                : { mediaUnitsEstimate: params.mediaUnitsEstimate }),
            }),
        }),
  });

  const messages: LlmMessage[] = params.messages.map((m) => ({
    role: m.role,
    content: [...m.content],
  }));

  // Inline media-out (1.AG/[ADR-0046]): a node requesting a non-text output modality runs a single-shot
  // `generate()` (the chain's existing non-streaming path) — terminal, NO tool loop (a media turn is the
  // agent's final artifact and `generate()` is one round-trip). The two budget gates below mirror the text
  // path: `awaitPreEgress` (primary-model, zero-egress-on-cancel) then the chain's per-attempt `preAttempt`.
  if (requestsMediaOutput(params)) {
    await awaitPreEgress(params, activeModel);
    throwIfAborted(params.signal);
    const turn = await generateOneTurn(chain, messages, params);
    throwIfAborted(params.signal); // cancel-wins independent of adapter cooperation (mirrors the stream path)
    if (turn.stopReason === 'tool_use') {
      // A media-output turn is single-shot/terminal (ADR-0046): generate() is one round-trip with no tool
      // loop, and `buildRequest` offers it no tools. A `tool_use` stop is therefore a provider PROTOCOL
      // ANOMALY — the provider signalled a tool call we never offered and cannot run — so it maps to
      // `provider_unavailable`, exactly as the stream path's `tool_use`-stop-with-nothing-runnable guard does.
      throw new AgentTurnError(
        'provider_unavailable',
        'a media-output turn signalled a tool_use stop but cannot run a tool round (ADR-0046)',
        false,
      );
    }
    return {
      content: turn.content,
      text: textOf(turn.content),
      usage: { input: totalInput, output: totalOutput },
      model: activeModel,
      stopReason: turn.stopReason,
    };
  }

  let corrections = 0;

  for (let toolTurn = 0; ; toolTurn += 1) {
    throwIfAborted(params.signal);
    if (toolTurn > params.limits.maxToolTurns) {
      throw new AgentTurnError(
        'turn_limit',
        `agent exceeded the ${params.limits.maxToolTurns}-turn tool-call limit`,
        false,
      );
    }
    // Two distinct budget gates, by design — NOT a duplicate of the chain's per-attempt check:
    //  • This loop-top `awaitPreEgress` runs ONCE per tool turn against the PRIMARY model. It is the
    //    zero-egress-on-cancel guarantee — a cancel landing inside its async check is caught by the
    //    re-check below, before any provider is engaged.
    //  • `FallbackChain.preAttempt` then runs again per chain attempt against the ACTUAL (possibly
    //    failed-over) model, so a failover to a pricier model is still enforced. `streamOneTurn` maps a
    //    chain-path Budget*Error back into this taxonomy via `chunk.error.cause`.
    await awaitPreEgress(params, activeModel);
    // The preEgress hook is awaited (its budget check may be async), so the signal can fire during
    // that await. Re-check before engaging the provider so a cancel there costs no egress — symmetric
    // with the post-stream re-check below.
    throwIfAborted(params.signal);

    const turn = await streamOneTurn(chain, messages, params, () => activeModel);
    // Cancel-wins independent of adapter cooperation: if the signal fired mid-stream but a
    // non-signal-honoring adapter still settled cleanly, fail `cancelled` rather than return a
    // stray completed result (mirrors the registry's post-await re-check).
    throwIfAborted(params.signal);

    if (turn.stopReason !== 'tool_use') {
      return {
        content: turn.content,
        text: textOf(turn.content),
        usage: { input: totalInput, output: totalOutput },
        model: activeModel,
        stopReason: turn.stopReason,
      };
    }

    // A tool-use turn: append the assistant turn + dispatch its calls (extracted to keep this loop within
    // the cognitive-complexity budget). Returns the updated correction count; throws on a protocol anomaly
    // or an exhausted correction budget.
    corrections = await dispatchToolUseTurn(
      turn.content,
      messages,
      params,
      () => activeModel,
      nonSkippedAttempts,
      corrections,
    );
  }
}
