/**
 * The **AgentRunner** (1.O) — the single dispatching {@link NodeExecutor} the run loop holds. It
 * switches on the vertex's engine type: an `agent` vertex runs the {@link runAgentTurn | turn core}
 * wrapped for the workflow run path; every non-agent type returns a **loud, typed `failed`** stub
 * until the 1.P handlers land (never a silent default). It owns the run-path concerns the
 * correlation-agnostic turn core deliberately excludes: resolving the agent + its provider plan,
 * assembling the message list (authored `system` ONLY; the resolved `prompt_template`, which may draw
 * on untrusted `run.outputs` / `read_file`, into a `user` position — never `system`), narrowing the
 * tool grant, lowering `output_schema` and validating the response against it node-side, and mapping
 * a classified {@link AgentTurnError} to a `NodeOutcome.failed`.
 *
 * The host injects only **platform capabilities** ([ADR-0038](../../../../docs/decisions/0038-agentrunner-llm-call-boundary.md)):
 * `resolveProvider` (provider-id → concrete adapter, so core never imports an adapter), the shared
 * `ToolRegistry` + its tool defs, and the chain's `keyFor` / `sleep` / `now` / `onAuthError`. The
 * credential is threaded opaquely and never stored / logged / inspected by core.
 */

import type { Agent, ErrorCode, FsScopeTier } from '@relavium/shared';
import {
  ResponseFormatSchema,
  ToolDefSchema,
  type FallbackPlanEntry,
  type LlmMessage,
  type LlmProvider,
  type ProviderId,
  type ResponseFormat,
  type ToolDef as LlmToolDef,
} from '@relavium/llm';

import { resolveTemplate } from '../interpolation/resolve.js';
import type { ResolverCapabilities, RunScope } from '../interpolation/scope.js';
import type { AgentPlanConfig } from '../run-plan.js';
import type { ToolDef, ToolDispatchContext, ToolRegistry } from '../tools/types.js';
import {
  AgentTurnError,
  DEFAULT_AGENT_TURN_LIMITS,
  runAgentTurn,
  type AgentTurnLimits,
  type AgentTurnResult,
  type ChainCapabilities,
  type PreEgressHook,
} from './agent-turn.js';
import { BudgetPauseError } from './budget-governor.js';
import type { NodeExecContext, NodeExecutor, NodeOutcome } from './node-executor.js';

type AgentNode = AgentPlanConfig['node'];

/**
 * The AgentRunner's injected dependencies — **platform capabilities only**. The genuinely-new one is
 * `resolveProvider`; `keyFor` / `sleep` / `now` / `onAuthError` are forwarded into the per-node
 * `FallbackChain` (the existing seam — not re-declared as a parallel credential surface). The
 * `CostTracker` and `onAttempt`→event are the turn core's, never the host's (ADR-0038).
 */
export interface AgentRunnerDeps {
  /** Resolve an authored provider id to its concrete adapter instance; `undefined` ⇒ a host-wiring gap. */
  readonly resolveProvider: (providerId: ProviderId) => LlmProvider | undefined;
  /** The shared tool registry (1.T) the agent dispatches through (ADR-0037). */
  readonly registry: ToolRegistry;
  /** The registry's tool defs — the source of the LLM-visible schema + descriptions for granted tools. */
  readonly tools: readonly ToolDef[];
  /** Host credential resolver — forwarded into the chain; never logged / stored / inspected by core. */
  readonly keyFor: ChainCapabilities['keyFor'];
  /** Host delay primitive (the engine has no ambient `setTimeout`). */
  readonly sleep: ChainCapabilities['sleep'];
  /** Optional injectable clock for the chain's cooldown bookkeeping. */
  readonly now?: ChainCapabilities['now'];
  /** Optional single out-of-band credential refresh (host-owned). */
  readonly onAuthError?: ChainCapabilities['onAuthError'];
  /** Host capability for the `read_file` interpolation filter in a prompt (delegated workspace sandbox). */
  readonly resolverCapabilities?: ResolverCapabilities;
  /** The filesystem scope tier for tool dispatch (default `'sandboxed'` — the safe tier). */
  readonly fsScope?: FsScopeTier;
  /** Loop bounds (default {@link DEFAULT_AGENT_TURN_LIMITS}). */
  readonly limits?: AgentTurnLimits;
  /** Pre-egress budget hook (default no-op; 1.AC fills it). */
  readonly preEgress?: PreEgressHook;
}

/**
 * Build the single dispatching {@link NodeExecutor}. Inject it as `WorkflowEngineDeps.executor`. An
 * `agent` vertex runs the AgentRunner; every other engine type is a loud typed `failed` until 1.P.
 */
export function createAgentNodeExecutor(deps: AgentRunnerDeps): NodeExecutor {
  return { execute: (ctx) => executeNode(ctx, deps) };
}

// The agent arm's local `failed` factory — the parallel of the canonical one in
// node-handlers/scope.ts; keep the two in lockstep if the NodeFailure shape ever changes.
function failed(code: ErrorCode, message: string, retryable: boolean): NodeOutcome {
  return { kind: 'failed', error: { code, message, retryable } };
}

/**
 * Map a thrown turn error to a node outcome: a classified {@link AgentTurnError} → `failed`; a 1.AC
 * pre-egress {@link BudgetPauseError} → `paused` (reusing the human-gate seam). Anything else re-throws —
 * the engine's catch-all maps it to a single `internal` failure.
 */
function turnOutcomeForError(err: unknown): NodeOutcome {
  if (err instanceof AgentTurnError) return failed(err.code, err.message, err.retryable);
  if (err instanceof BudgetPauseError) return { kind: 'paused', gate: err.toGateRequest() };
  throw err;
}

async function executeNode(ctx: NodeExecContext, deps: AgentRunnerDeps): Promise<NodeOutcome> {
  if (ctx.vertex.type !== 'agent') {
    // Loud, typed stub — the 1.P node-type handlers fill these; never a silent default.
    return failed('internal', `no executor for node type '${ctx.vertex.type}' yet (1.P)`, false);
  }
  const config = ctx.vertex.config;
  if (config.kind !== 'agent') {
    return failed(
      'internal',
      `agent vertex '${ctx.vertex.id}' carries a '${config.kind}' config`,
      false,
    );
  }
  return executeAgent(ctx, config, deps);
}

async function executeAgent(
  ctx: NodeExecContext,
  config: AgentPlanConfig,
  deps: AgentRunnerDeps,
): Promise<NodeOutcome> {
  const node = config.node;
  const agent = config.resolvedAgent;
  if (agent === undefined) {
    // An authoring/config error (the ref did not resolve) — `validation`, distinct from a provider
    // wiring gap (`internal`). Never a raw throw (the engine would flatten it to `internal`).
    return failed(
      'validation',
      `agent node '${node.id}': agent_ref '${node.agent_ref}' did not resolve to an agent`,
      false,
    );
  }

  const plan = buildPlanEntries(agent, node, deps);
  if (!plan.ok) return failed(plan.code, plan.message, false);

  const grant = resolveGrant(agent.tools, node.tools);
  if (!grant.ok) return failed('validation', grant.message, false);
  const grantedToolIds = new Set(grant.ids);

  const prompt =
    node.prompt_template === undefined
      ? { ok: true as const, text: '' }
      : await resolvePrompt(node.prompt_template, ctx, deps);
  if (!prompt.ok) return failed('validation', prompt.message, false);

  const messages = assembleMessages(agent, node, prompt.text);
  const llmTools = buildLlmTools(deps.tools, grantedToolIds);
  const outputSchema = node.output_schema ?? agent.output_schema;
  const responseFormat = lowerOutputSchema(outputSchema);

  const dispatchContext: Omit<ToolDispatchContext, 'signal'> = {
    nodeId: node.id,
    grantedToolIds,
    config: {}, // an agent-invoked tool carries no per-tool config block in v1.0
    toolPolicy: ctx.toolPolicy,
    fsScope: deps.fsScope ?? 'sandboxed',
    gateApproved: false, // an agent loop provides no human gate — git_commit stays denied
  };

  // The per-dispatch `ctx.preEgress` (the engine's budget governor, 1.AC) takes precedence; `deps.preEgress`
  // is the fallback for a host that wires a runner directly. Reading ctx here lets the dispatcher build the
  // runner ONCE (no per-call rebuild) and keeps the engine's H3 one-shot bypass (ctx.preEgress=undefined) working.
  const preEgress = ctx.preEgress ?? deps.preEgress;
  let result: AgentTurnResult;
  try {
    result = await runAgentTurn({
      ...(messages.system === undefined ? {} : { system: messages.system }),
      messages: messages.messages,
      ...(llmTools.length > 0 ? { tools: llmTools } : {}),
      planEntries: plan.entries,
      chainCapabilities: chainCapabilities(deps),
      ...(responseFormat === undefined ? {} : { responseFormat }),
      ...resolveGenKnobs(agent, node),
      nodeId: node.id,
      emit: ctx.emit,
      signal: ctx.signal,
      registry: deps.registry,
      dispatchContext,
      limits: deps.limits ?? DEFAULT_AGENT_TURN_LIMITS,
      ...(preEgress === undefined ? {} : { preEgress }),
    });
  } catch (err) {
    return turnOutcomeForError(err);
  }

  const tokensUsed = {
    input: result.usage.input,
    output: result.usage.output,
    model: result.model,
  };

  // output_schema enforcement is NODE-SIDE (the seam's responseFormat is a request hint only; an
  // adapter never validates the response, and DeepSeek degrades to bare json_object — ADR-0038/D8).
  if (outputSchema !== undefined) {
    const parsed = tryParseJson(result.text);
    if (parsed === PARSE_FAILED) {
      return failed(
        'validation',
        `agent node '${node.id}': output_schema is set but the model output was not valid JSON`,
        false,
      );
    }
    return { kind: 'completed', output: parsed, tokensUsed };
  }
  return { kind: 'completed', output: result.text, tokensUsed };
}

/** Build the ordered fallback plan: primary (node-over-agent model) + each authored fallback entry. */
function buildPlanEntries(
  agent: Agent,
  node: AgentNode,
  deps: AgentRunnerDeps,
): { ok: true; entries: FallbackPlanEntry[] } | { ok: false; code: ErrorCode; message: string } {
  const primary = deps.resolveProvider(agent.provider);
  if (primary === undefined) {
    return { ok: false, code: 'internal', message: `no provider wired for '${agent.provider}'` };
  }
  // The primary entry does NOT consume `node.retry` any more: ADR-0040 (amending ADR-0038) makes
  // `node.retry` the engine's ABOVE-chain node-retry budget (applied around the whole chain), not the
  // primary provider's within-chain same-model retry. The primary defaults to a single attempt + the
  // chain's own default backoff; a within-chain primary retry, if ever wanted, is a future primary
  // `max_attempts` field (ADR-0040 A.2), not `retry`.
  const entries: FallbackPlanEntry[] = [
    {
      provider: primary,
      model: node.model ?? agent.model,
      maxAttempts: 1,
    },
  ];
  for (const entry of agent.fallback_chain ?? []) {
    const provider = deps.resolveProvider(entry.provider);
    if (provider === undefined) {
      return {
        ok: false,
        code: 'internal',
        message: `no provider wired for fallback '${entry.provider}'`,
      };
    }
    entries.push({ provider, model: entry.model, maxAttempts: entry.max_attempts });
  }
  return { ok: true, entries };
}

/** Resolve the node's tool grant: `node.tools` NARROWS `agent.tools` and may never widen it (ADR-0029). */
function resolveGrant(
  agentTools: readonly string[] | undefined,
  nodeTools: readonly string[] | undefined,
): { ok: true; ids: readonly string[] } | { ok: false; message: string } {
  const agentSet = agentTools ?? [];
  if (nodeTools === undefined) return { ok: true, ids: agentSet };
  const widening = nodeTools.filter((t) => !agentSet.includes(t));
  if (widening.length > 0) {
    return {
      ok: false,
      message: `node tools [${widening.join(', ')}] are not granted to the agent (a node narrows, never widens)`,
    };
  }
  return { ok: true, ids: nodeTools };
}

/** System = authored text ONLY (agent.system_prompt + node.system_prompt_append). The prompt → user. */
function assembleMessages(
  agent: Agent,
  node: AgentNode,
  userText: string,
): { system: string | undefined; messages: LlmMessage[] } {
  const append = node.system_prompt_append;
  const system =
    append === undefined || append.length === 0
      ? agent.system_prompt
      : `${agent.system_prompt}\n\n${append}`;
  const messages: LlmMessage[] =
    userText.length > 0 ? [{ role: 'user', content: [{ type: 'text', text: userText }] }] : [];
  return { system, messages };
}

/** Lower an `output_schema` to the request-side `responseFormat` hint (validation is node-side). */
function lowerOutputSchema(schema: unknown): ResponseFormat | undefined {
  if (schema === undefined) return undefined;
  // Validate-through (Zod types the opaque schema object as a JSON-Schema — no unsafe cast).
  return ResponseFormatSchema.parse({ type: 'json', schema });
}

/** The granted tools as LLM-visible defs, validated through the seam schema (no unsafe cast). */
function buildLlmTools(defs: readonly ToolDef[], granted: ReadonlySet<string>): LlmToolDef[] {
  const out: LlmToolDef[] = [];
  for (const def of defs) {
    if (!granted.has(def.id)) continue;
    out.push(
      ToolDefSchema.parse({
        name: def.id,
        ...(def.description.length > 0 ? { description: def.description } : {}),
        parameters: def.llmVisibleParams,
      }),
    );
  }
  return out;
}

/** Node-over-agent generation knobs (the node override wins; ADR-0038). */
function resolveGenKnobs(
  agent: Agent,
  node: AgentNode,
): { temperature?: number; maxTokens?: number } {
  const temperature = node.temperature ?? agent.temperature;
  const maxTokens = node.max_tokens ?? agent.max_tokens;
  return {
    ...(temperature === undefined ? {} : { temperature }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  };
}

/** Forward only the platform-level chain capabilities the host supplies. */
function chainCapabilities(deps: AgentRunnerDeps): ChainCapabilities {
  return {
    keyFor: deps.keyFor,
    sleep: deps.sleep,
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.onAuthError === undefined ? {} : { onAuthError: deps.onAuthError }),
  };
}

async function resolvePrompt(
  template: string,
  ctx: NodeExecContext,
  deps: AgentRunnerDeps,
): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  // The resolved prompt may draw on untrusted run.outputs / read_file — it lands in a USER message
  // (assembleMessages), never `system`. `ctx` is the resolved workflow-context namespace
  // (`NodeExecContext.ctx`), folded once at run start by the engine; a prompt resolves against
  // inputs + ctx + run.outputs.
  const scope: RunScope = {
    inputs: ctx.inputs,
    ctx: ctx.ctx,
    outputs: Object.fromEntries(ctx.runOutputs),
  };
  try {
    const text = await resolveTemplate(template, scope, deps.resolverCapabilities ?? {});
    return { ok: true, text };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'prompt interpolation failed',
    };
  }
}

const PARSE_FAILED = Symbol('parse-failed');

/**
 * Parse the model's output as JSON, tolerating a ```json … ``` markdown fence — models commonly wrap
 * structured output in one even under a `responseFormat` hint, and an unwrapped `JSON.parse` would
 * turn that into a spurious `validation` failure.
 */
function tryParseJson(text: string): unknown {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    // Drop the opening fence (``` optionally + a language tag, through the first newline) and the
    // closing fence — plain string ops, no regex (avoids any super-linear-backtracking surface).
    const newline = cleaned.indexOf('\n');
    cleaned = (newline === -1 ? cleaned.slice(3) : cleaned.slice(newline + 1)).trim();
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.slice(0, -3).trim();
    }
  }
  try {
    return JSON.parse(cleaned) as unknown;
  } catch {
    return PARSE_FAILED;
  }
}
