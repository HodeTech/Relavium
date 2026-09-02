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

import {
  MEDIA_BILLED_MODALITIES,
  mediaModalityOf,
  type AbortSignalLike,
  type Agent,
  type ContentPart,
  type ErrorCode,
  type FsScopeTier,
  type MediaBilledModality,
  type MediaCostEstimate,
  type MediaSurface,
  type OutputModality,
  type ReasoningEffort,
  unwiredEffectJournal,
  openDeadline,
  type DeadlineScope,
  MEDIA_GEN_SUBMIT_TIMEOUT_MS,
} from '@relavium/shared';
import {
  LlmConfigError,
  LlmProviderError,
  ResponseFormatSchema,
  ToolDefSchema,
  cost,
  makeLlmError,
  type FallbackPlanEntry,
  type LlmMessage,
  type LlmProvider,
  type MediaGenRequest,
  type MediaGenResult,
  type MediaJobStatus,
  type MediaUnitsEntry,
  type MediaUnitsEstimate,
  type PricingOverlay,
  type ProviderId,
  type ResponseFormat,
  type ToolDef as LlmToolDef,
} from '@relavium/llm';

import { resolveTemplate } from '../interpolation/resolve.js';
import type { ResolverCapabilities, RunScope } from '../interpolation/scope.js';
import type { AgentPlanConfig } from '../run-plan.js';
import { authoredSystemPrompt, type AuthoredSystemPrompt } from './authored-system-prompt.js';
import { modelVisibleDescription } from '../tools/types.js';
import type { ToolDef, ToolDispatchContext, ToolRegistry } from '../tools/types.js';
import {
  AgentTurnError,
  DEFAULT_AGENT_TURN_LIMITS,
  codeForLlmError,
  runAgentTurn,
  type AgentTurnLimits,
  type AgentTurnResult,
  type ChainCapabilities,
  type PreEgressHook,
} from './agent-turn.js';
import { BudgetExceededError, BudgetPauseError, type BudgetAdmission } from './budget-governor.js';
import { effortToSend, gateReasoningEffort } from './reasoning-effort.js';
import type {
  EffortGateResult,
  ReasoningCapCheck,
  ResolveEffortTiers,
} from './reasoning-effort.js';
import type {
  MediaJobSubmission,
  NodeExecContext,
  NodeExecutor,
  NodeOutcome,
} from './node-executor.js';

type AgentNode = AgentPlanConfig['node'];

/**
 * An async media submission crosses from the runner to the engine as the exact `MediaJobSubmission` object. Keep
 * its admission out of the persisted seam object: a lease is process-local bookkeeping, never checkpoint data or
 * an adapter-visible type. The engine consumes it once when it parks the job; resume reconstructs a fresh lease
 * from durable model/modality/units instead.
 */
const mediaJobAdmissions = new WeakMap<MediaJobSubmission, BudgetAdmission>();

function retainMediaJobAdmission(
  job: MediaJobSubmission,
  admission: BudgetAdmission | undefined,
): void {
  if (admission !== undefined) mediaJobAdmissions.set(job, admission);
}

/** Consume the process-local budget admission attached to a freshly submitted async media job, if any. */
export function takeMediaJobAdmission(job: MediaJobSubmission): BudgetAdmission | undefined {
  const admission = mediaJobAdmissions.get(job);
  if (admission !== undefined) mediaJobAdmissions.delete(job);
  return admission;
}

/**
 * The AgentRunner's injected dependencies — **platform capabilities only**. The genuinely-new one is
 * `resolveProvider`; `keyFor` / `sleep` / `now` / `onAuthError` are forwarded into the per-node
 * `FallbackChain` (the existing seam — not re-declared as a parallel credential surface). The
 * `CostTracker` and `onAttempt`→event are the turn core's, never the host's (ADR-0038).
 */
export interface AgentRunnerDeps {
  /** Resolve an authored provider id to its concrete adapter instance; `undefined` ⇒ a host-wiring gap. */
  readonly resolveProvider: (providerId: ProviderId) => LlmProvider | undefined;
  /**
   * Resolve a canonical model id to its `media_surface` (1.AG Section C, ADR-0045 §1) — the inline-vs-generative
   * routing discriminator, projected from `model_catalog.media_surface`. `'generative'` routes the agent node to
   * the separate-endpoint `generateMedia`; `'chat'` (the default, and the value when this dep is absent or returns
   * `undefined`) uses the normal turn. The engine is platform-pure (no DB), so the host injects this catalog
   * lookup; the production catalog wiring is host-side (1.AH), like the other 1.AF/1.AG host-wiring obligations.
   */
  readonly resolveMediaSurface?: (model: string) => MediaSurface | undefined;
  /**
   * WHICH reasoning tiers a model accepts ([ADR-0071](../../../../docs/decisions/0071-models-dev-as-the-model-metadata-source.md) §6)
   * — the host-injected per-model catalog projection, mirroring {@link AgentRunnerDeps.resolveMediaSurface}. The
   * engine is platform-pure (no catalog, no DB), so the host injects it.
   *
   * It replaced a boolean, and the upgrade is the point: *"does this model reason"* is not the question the wire
   * asks. `gpt-5.4-pro` reasons and rejects `low`. Absent / `undefined` / an empty set ⇒ the field is withheld —
   * safe, and never a guess.
   */
  readonly resolveEffortTiers?: ResolveEffortTiers;
  /**
   * Does a budget-shaped model withhold the accepted tier because this node's `max_tokens` leaves no room for its
   * minimum thinking budget (review M6)? Host-injected (reads the catalog's budget range); absent ⇒ unchecked, and
   * a tight `max_tokens` drops thinking silently, as before. Surfaces as a `capped` verdict through onEffortWithheld.
   */
  readonly withheldByCap?: ReasoningCapCheck;
  /**
   * Called when an authored `reasoning_effort` is WITHHELD — the tier the agent asked for is not one the bound
   * model takes ([ADR-0071](../../../../docs/decisions/0071-models-dev-as-the-model-metadata-source.md) §6).
   *
   * Withholding is right; withholding **silently** is not, and that is the trade this gate would otherwise make.
   * It replaced a loud provider 400 with a turn that runs, drops the field, and bills at the provider's default
   * tier — so an author who wrote `reasoning_effort: max` on a model whose ladder stops at `high` would have no
   * way to learn that the knob they set does nothing. The engine cannot print, so the host is handed the gate's
   * own verdict (which carries what the model WOULD accept) and decides where it goes.
   */
  readonly onEffortWithheld?: (result: EffortGateResult, model: string) => void;
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
  /**
   * Host media-egress resolver (1.AF/D8) — turns a durable `handle` media source into the in-flight source
   * a provider needs, before egress (backed by `MediaStore.resolveForEgress`). Forwarded into the chain so
   * the adapter only ever sees a resolved source; absent on a text-only host (a handle is then sent as-is).
   */
  readonly resolveForEgress?: ChainCapabilities['resolveForEgress'];
  /**
   * ADR-0082 §6's per-attempt deadline primitives. **Both or neither** — a chain given only one keeps the
   * pre-ADR-0082 unbounded behaviour, and an unbounded wait on a provider that ignores its abort signal is
   * the hang the deadline exists to remove. Host-supplied for the same reason `sleep` is: the engine is
   * platform-free and has no ambient `AbortController` or `setTimeout`.
   */
  readonly newAbortController?: ChainCapabilities['newAbortController'];
  readonly setTimer?: ChainCapabilities['setTimer'];
  /** Override the per-attempt deadline (default 120s). Must be finite and positive. */
  readonly attemptTimeoutMs?: ChainCapabilities['attemptTimeoutMs'];

  /** Host capability for the `read_file` interpolation filter in a prompt (delegated workspace sandbox). */
  readonly resolverCapabilities?: ResolverCapabilities;
  /** The filesystem scope tier for tool dispatch (default `'sandboxed'` — the safe tier). */
  readonly fsScope?: FsScopeTier;
  /** Loop bounds (default {@link DEFAULT_AGENT_TURN_LIMITS}). */
  readonly limits?: AgentTurnLimits;
  /** Pre-egress budget hook (default no-op; 1.AC fills it). */
  readonly preEgress?: PreEgressHook;
  /** The user-pricing overlay (2.5.G S10, ADR-0065 §2) — host-injected into the turn's realized cost tracker so a
   *  workflow run's user-priced model is folded into cost governance. Absent ⇒ static-only. */
  readonly resolvePrice?: PricingOverlay;
  /**
   * Per-modality media-output **unit-count** default (1.AF/D17, ADR-0044 §3) — the host-resolved
   * `[defaults].media_cost_estimate`. Used to build the per-turn media-unit estimate from a node's
   * `output_modalities` when the turn declares no volume, so the budget governor can price a media-output
   * turn pre-egress. Absent ⇒ a conservative built-in default ({@link DEFAULT_MEDIA_UNIT_ESTIMATE}).
   */
  readonly mediaCostEstimate?: MediaCostEstimate;
}

/**
 * The conservative built-in per-modality media-output unit count used when neither the turn nor
 * `[defaults].media_cost_estimate` declares a volume (1.AF/D17). A *count* (image), or *seconds*
 * (audio/video) — the analogue of {@link DEFAULT_AGENT_TURN_LIMITS}. Deliberately small but non-zero so a
 * model that *does* price media output is still gated; a host tunes it via config.
 */
export const DEFAULT_MEDIA_UNIT_ESTIMATE: Readonly<Record<MediaBilledModality, number>> = {
  image: 1, // one image
  audio: 60, // sixty audio-seconds
  video: 10, // ten video-seconds
};

/**
 * Build the per-turn media-unit estimate (1.AF/D17) from a node's `output_modalities` + the host's
 * `media_cost_estimate` defaults: one {@link MediaUnitsEstimate} per **billed** output modality
 * (`image`/`audio`/`video`; `text` and the never-output `document` are excluded). The per-modality count
 * is the config default, else the built-in {@link DEFAULT_MEDIA_UNIT_ESTIMATE}. Empty when the node
 * requests no billed media output (a text-only turn ⇒ no media addend).
 */
export function buildMediaUnitsEstimate(
  outputModalities: readonly OutputModality[] | undefined,
  config: MediaCostEstimate | undefined,
): MediaUnitsEstimate[] {
  if (outputModalities === undefined) {
    return [];
  }
  const estimate: MediaUnitsEstimate[] = [];
  for (const modality of outputModalities) {
    if (!isBilledModality(modality)) {
      continue; // `text` (and `document`, never an output) are not media-billed
    }
    estimate.push({ modality, units: config?.[modality] ?? DEFAULT_MEDIA_UNIT_ESTIMATE[modality] });
  }
  return estimate;
}

/** The billed media modalities as a string-keyed set — preserves the const-array's literal types (no cast). */
const BILLED_MODALITIES: ReadonlySet<string> = new Set(MEDIA_BILLED_MODALITIES);

/** Type guard: is an output modality a BILLED media modality (image/audio/video)? Narrows without a cast. */
function isBilledModality(modality: OutputModality): modality is MediaBilledModality {
  return BILLED_MODALITIES.has(modality);
}

/**
 * Build the single dispatching {@link NodeExecutor}. Inject it as `WorkflowEngineDeps.executor`. An
 * `agent` vertex runs the AgentRunner; every other engine type is a loud typed `failed` until 1.P.
 */
export function createAgentNodeExecutor(deps: AgentRunnerDeps): NodeExecutor {
  return {
    execute: (ctx) => executeNode(ctx, deps),
    // The engine owns the async media-job poll loop (1.AG Section D), but provider + credential resolution
    // lives here (the AgentRunnerDeps), so the engine delegates the actual poll back through the executor.
    pollMediaJob: (job, signal) => pollMediaJobThroughDeps(deps, job, signal),
  };
}

/**
 * Re-resolve the provider + credential for an async media-job poll (1.AG Section D, ADR-0045 §3) and call the
 * adapter's `pollMediaJob`. The two resolution faults this owns — a missing adapter / unimplemented
 * `pollMediaJob` (host-wiring gap) and a credential failure — become a **secret-free `failed` `MediaJobStatus`**
 * the engine settles `node:failed` from (never the original credential error — rule 6). A throw from the
 * adapter's OWN `pollMediaJob` (a transient transport fault, or the abort rejection when the run is cancelled)
 * PROPAGATES — the engine's poll-loop `try/catch` handles it: an abort / terminal / cleared job returns
 * silently, a live fault settles a retryable `node:failed`.
 */
async function pollMediaJobThroughDeps(
  deps: AgentRunnerDeps,
  job: MediaJobSubmission,
  signal: AbortSignalLike,
): Promise<MediaJobStatus> {
  const provider = deps.resolveProvider(job.provider);
  if (provider === undefined || provider.pollMediaJob === undefined) {
    return {
      state: 'failed',
      error: makeLlmError({
        provider: job.provider,
        kind: 'unknown',
        message: `provider '${job.provider}' implements no pollMediaJob (host-wiring gap)`,
      }),
    };
  }
  let key: string;
  try {
    key = await deps.keyFor(job.provider);
  } catch {
    return {
      state: 'failed',
      error: makeLlmError({
        provider: job.provider,
        kind: 'auth',
        message: `credential resolution failed for provider ${job.provider}`,
      }),
    };
  }
  // **Re-check the caller AFTER credential resolution, BEFORE the seam call** — the same window the chain's
  // two arms had. `keyFor` is I/O, so a cancel landing inside it was invisible here and the poll went out
  // anyway. A cancelled run must not produce provider traffic.
  if (signal?.aborted === true) {
    return {
      state: 'failed',
      error: makeLlmError({
        provider: job.provider,
        kind: 'cancelled',
        message: `media job poll cancelled for provider ${job.provider}`,
      }),
    };
  }
  return provider.pollMediaJob(job.jobId, key, signal);
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

  // Inline-vs-generative routing (1.AG Section C, ADR-0045 §1): a resolved model whose `media_surface` is
  // 'generative' dispatches through the separate-endpoint `generateMedia` (one provider, no chain failover —
  // §6). A 'chat' model (the default, and the value when the host wires no surface lookup) takes the normal
  // turn below. The surface is the host-injected catalog projection (`deps.resolveMediaSurface`).
  // NOTE: `buildPlanEntries` above resolved the FULL fallback chain before this fork, so a `'generative'` node
  // whose (unused, per §6) `fallback_chain` names an unwired provider fails fast at the plan-build above rather
  // than here — intentional: a declared-but-unresolvable fallback is a workflow misconfig regardless of which
  // surface the primary uses. The generative dispatch then consumes only `primary` (plan.entries[0]).
  const primary = plan.entries[0];
  if (
    primary !== undefined &&
    (deps.resolveMediaSurface?.(primary.model) ?? 'chat') === 'generative'
  ) {
    return executeGenerativeMedia(ctx, node, primary, prompt.text, deps);
  }

  const messages = assembleMessages(agent, node, prompt.text);
  const llmTools = buildLlmTools(deps.tools, grantedToolIds);
  const outputSchema = node.output_schema ?? agent.output_schema;
  const responseFormat = lowerOutputSchema(outputSchema);

  const dispatchContext: Omit<ToolDispatchContext, 'signal'> = {
    // The journal, and the run-path correlation only the run loop can supply — the same reasoning that puts
    // the money ledger here (ADR-0076): `ctx.attemptNumber` is the NODE-RETRY attempt (ADR-0040), which the
    // turn has never carried and which the correlation needs for its audit arm.
    effects: ctx.effects ?? unwiredEffectJournal(),
    effectSlot: 0, // per-CALL; `dispatchToolCalls` overrides it with the tool call's ordinal
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
      system: messages.system,
      messages: messages.messages,
      ...(llmTools.length > 0 ? { tools: llmTools } : {}),
      planEntries: plan.entries,
      chainCapabilities: chainCapabilities(deps),
      ...(responseFormat === undefined ? {} : { responseFormat }),
      ...resolveGenKnobs(agent, node, deps),
      nodeId: node.id,
      emit: ctx.emit,
      // ADR-0036's producer-await, forwarded verbatim (`CR-30`) — the turn's chunk loop is what awaits it.
      ...(ctx.whenReady === undefined ? {} : { whenReady: ctx.whenReady }),
      signal: ctx.signal,
      registry: deps.registry,
      dispatchContext,
      limits: deps.limits ?? DEFAULT_AGENT_TURN_LIMITS,
      ...(preEgress === undefined ? {} : { preEgress }),
      // Straight from the ctx, with no `deps` fallback — the ledger belongs to a RUN and only the run loop can
      // supply it. A host wiring a runner directly gets no ledger, which is correct: there is no run to
      // record against (ADR-0076 / ADR-0077).
      ...(ctx.money === undefined ? {} : { money: ctx.money }),
      ...(deps.resolvePrice === undefined ? {} : { resolvePrice: deps.resolvePrice }), // user-pricing overlay (S10)
      // Media cost governance (1.AF/D17): forward the node's requested output modalities + a per-modality
      // unit estimate so the budget governor prices a media-output turn pre-egress. Both omitted for a
      // text-only node (no `output_modalities`), so a text turn pays no media-estimate work.
      ...(node.output_modalities === undefined
        ? {}
        : {
            outputModalities: node.output_modalities,
            mediaUnitsEstimate: buildMediaUnitsEstimate(
              node.output_modalities,
              deps.mediaCostEstimate,
            ),
          }),
    });
  } catch (err) {
    return turnOutcomeForError(err);
  }

  return buildChatTurnOutcome(node, result, outputSchema !== undefined);
}

/**
 * Build the node outcome from a completed chat turn (1.O / 1.AG Section B). Order: a turn that produced media
 * parts surfaces them as `{ text, media }` so the engine de-inlines the in-flight base64 to `media://` handles
 * at #emitDurable (the I3 boundary) — this PRECEDES output_schema (a media turn is not JSON-validated). A turn
 * that requested media but produced NONE fails `validation` (ADR-0046's produced-vs-requested check — the
 * FallbackChain pre-skip is a declared-capability gate that cannot catch a model returning text anyway). Else,
 * `output_schema` (when set) is enforced NODE-SIDE (the seam's responseFormat is a request hint only; an
 * adapter never validates, and DeepSeek degrades to bare json_object — ADR-0038/D8); a non-JSON result fails
 * `validation`. A plain text turn returns its text verbatim.
 */
function buildChatTurnOutcome(
  node: AgentNode,
  result: AgentTurnResult,
  hasOutputSchema: boolean,
): NodeOutcome {
  const tokensUsed = {
    input: result.usage.input,
    output: result.usage.output,
    model: result.model,
  };
  const mediaParts = result.content.filter(
    (part): part is Extract<ContentPart, { type: 'media' }> => part.type === 'media',
  );
  if (mediaParts.length > 0) {
    return { kind: 'completed', output: { text: result.text, media: mediaParts }, tokensUsed };
  }
  if (node.output_modalities?.some((modality) => modality !== 'text')) {
    return failed(
      'validation',
      `agent node '${node.id}': output_modalities requested media output but the model returned none`,
      false,
    );
  }
  if (!hasOutputSchema) {
    return { kind: 'completed', output: result.text, tokensUsed };
  }
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

/**
 * Take the pre-egress budget admission for a generative-media call, or the outcome that refuses it.
 *
 * Extracted from `executeGenerativeMedia` so that function stays inside its cognitive-complexity budget: the
 * try/catch and its two typed refusals are a cohesive unit — `BudgetExceededError` is a clean node failure,
 * `BudgetPauseError` becomes a gate, and anything else re-throws to the engine as internal.
 */
async function acquireGenerativeAdmission(
  preEgress: NodeExecContext['preEgress'],
  req: { readonly model: string; readonly modality: MediaBilledModality; readonly units: number },
): Promise<
  | { kind: 'admitted'; admission: BudgetAdmission | undefined }
  | { kind: 'refused'; outcome: NodeOutcome }
> {
  if (preEgress === undefined) {
    return { kind: 'admitted', admission: undefined };
  }
  try {
    // The port may resolve `void` (a host that governs nothing); normalise it to `undefined` here so the
    // caller has one shape to reason about.
    const admission =
      (await preEgress({
        model: req.model,
        maxTokens: 0,
        outputModalities: [req.modality],
        mediaUnitsEstimate: [{ modality: req.modality, units: req.units }],
      })) ?? undefined;
    return { kind: 'admitted', admission };
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      return { kind: 'refused', outcome: failed('budget_exceeded', err.message, false) };
    }
    // BudgetPauseError → paused; anything else re-throws → engine internal.
    return { kind: 'refused', outcome: turnOutcomeForError(err) };
  }
}

/**
 * Dispatch a `media_surface: 'generative'` agent node through the seam's `generateMedia` (1.AG Section C,
 * [ADR-0045](../../../../docs/decisions/0045-async-media-job-loop-poll-checkpoint-resume-cancel.md) §1/§5/§6):
 * SYNC one-round-trip generation (gpt-image-1, Imagen, OpenAI TTS) resolving `{ media }`. ONE provider, NO
 * cross-provider failover (a generative call is provider-bound — §6). The pre-egress budget gate runs first
 * (the authored volume estimate, gate-only — never folded into cumulative); the in-flight media becomes the
 * `{ text:'', media:[part] }` node output the engine de-inlines to a handle at #emitDurable (the I3 boundary,
 * reusing 1.AF); exactly ONE realized `cost:updated` is emitted (§5). A `jobId` (async LRO) is Section D.
 */
async function executeGenerativeMedia(
  ctx: NodeExecContext,
  node: AgentNode,
  primary: FallbackPlanEntry,
  prompt: string,
  deps: AgentRunnerDeps,
): Promise<NodeOutcome> {
  const modality = singleBilledModality(node.output_modalities, node.id);
  if (!modality.ok) return failed('validation', modality.message, false);

  // The seam's `MediaGenRequest.prompt` is `nonEmptyString` — a generative call needs a prompt (unlike the
  // chat path, which tolerates an empty prompt by sending no user message). Reject an empty resolved prompt as
  // a clean upstream validation failure here, before the gate/egress — never let it surface as a provider
  // bad_request (the node's `prompt_template` is optional, so this is reachable).
  if (prompt.length === 0) {
    return failed(
      'validation',
      `agent node '${node.id}': a media_surface 'generative' model requires a non-empty prompt`,
      false,
    );
  }

  const provider = primary.provider;
  if (provider.generateMedia === undefined) {
    // The catalog flagged the model 'generative' but its provider implements no generateMedia — a host-wiring
    // gap (internal), distinct from an authoring error. Never a raw throw (the engine would flatten it).
    return failed(
      'internal',
      `agent node '${node.id}': model '${primary.model}' is media_surface 'generative' but provider '${provider.id}' implements no generateMedia (host-wiring gap)`,
      false,
    );
  }

  // The authored output volume → the per-modality unit count (count for image; duration_seconds for
  // audio/video, × count when both are authored — ADR-0045 §5). The SAME number drives the pre-egress estimate
  // (gate only) and the realized fold (§5).
  const units = generativeUnits(modality.modality, node);

  // Pre-egress budget gate (1.AC): the authored media volume, NEVER added to cumulative (gate only). A
  // BudgetExceededError → budget_exceeded; a BudgetPauseError → paused (the human-gate seam) — this mirrors
  // the chat path's awaitPreEgress exactly so a generative call is gated identically. `maxTokens: 0` pins the
  // TOKEN estimate to zero — a generative call emits no tokens, so once generative pricing rows land the gate
  // must not add a spurious token addend on top of the media estimate. `outputModalities` is the validated
  // single modality (singleBilledModality), so the budget governor's media addend resolves the same rate.
  const gated = await acquireGenerativeAdmission(ctx.preEgress ?? deps.preEgress, {
    model: primary.model,
    modality: modality.modality,
    units,
  });
  if (gated.kind === 'refused') {
    return gated.outcome;
  }
  let admission = gated.admission;
  let egressStarted = false;
  try {
    // A cancel landing inside the (async) budget check costs no egress: re-check before engaging the provider.
    if (ctx.signal.aborted) {
      return failed(
        'cancelled',
        `agent node '${node.id}': run cancelled before media generation`,
        false,
      );
    }

    const req: MediaGenRequest = {
      model: primary.model,
      prompt,
      modality: modality.modality,
      ...(node.count === undefined ? {} : { count: node.count }),
      ...(node.duration_seconds === undefined ? {} : { durationSeconds: node.duration_seconds }),
      signal: ctx.signal,
    };

    let key: string;
    try {
      key = await deps.keyFor(provider.id);
    } catch {
      // A host credential-resolution failure must NEVER surface its (possibly secret-bearing) message — replace
      // it with a fixed, secret-free `provider_auth` failure, exactly as the FallbackChain's `#resolveKey` does
      // on the chat path (rule 6). The original is dropped, not carried as a cause a sink could serialize.
      return failed(
        'provider_auth',
        `agent node '${node.id}': credential resolution failed for provider ${provider.id}`,
        false,
      );
    }

    // A key lookup can be asynchronous. If the run was cancelled while it was resolving, do not hand the now-stale
    // credential to generateMedia: this is still proven pre-egress, so the `finally` below releases its admission.
    if (ctx.signal.aborted) {
      return failed(
        'cancelled',
        `agent node '${node.id}': run cancelled before media generation`,
        false,
      );
    }

    let result: MediaGenResult;
    // **The submission gets the same hard race a chain attempt gets (`CR-21b`).** ADR-0082 §10 named this
    // gap rather than absorbing it: this call is not a poll, so ADR-0045's job deadline does not cover it,
    // and it is not a `FallbackChain` attempt, so §6's per-attempt deadline does not either. It was awaited
    // unbounded, which is the exact "the vendor SDK default becomes our liveness semantics" that ADR-0082
    // exists to remove — and `security-review.md` forbids outright ("a hung provider must not pin a worker
    // open").
    //
    // No seam amendment was needed: `MediaGenRequest.signal` already exists and `ctx.signal` was already
    // passed. The gap was only that nothing raced the await, and a signal is a request rather than a
    // guarantee. The scope's merged signal REPLACES `ctx.signal` on the request so a well-behaved adapter
    // aborts on either cause; the race is what covers one that ignores both.
    //
    // The bound is `MEDIA_GEN_SUBMIT_TIMEOUT_MS`, which is its OWN number rather than the chain's. Borrowing
    // `DEFAULT_ATTEMPT_TIMEOUT_MS` was the first attempt and the packaging refused it: ADR-0085 §9 keeps that
    // constant inside `@relavium/llm` deliberately, so reaching for it would widen that package's public
    // surface to let the engine bound a media call — and would couple two budgets answering different
    // questions. Equal today, independent by construction; the reasoning lives with the constant.
    const deadline = openGenerativeDeadline(deps, ctx.signal);
    try {
      // From this call onward the provider may have accepted/billed the generation even if its SDK throws or omits
      // a terminal payload. Preserve the bounded reservation in those uncertain paths; only credential resolution
      // above is proven pre-egress and may release it.
      egressStarted = true;
      const submitted = await submitGenerativeMedia(provider, req, key, deadline, node.id);
      if (submitted.kind === 'refused') {
        admission?.settleAtReservedEstimate({ nodeId: node.id });
        return submitted.outcome;
      }
      result = submitted.result;
    } catch (err) {
      admission?.settleAtReservedEstimate({ nodeId: node.id });
      return mapGenerateMediaError(err);
    } finally {
      deadline?.dispose();
    }

    // A cancel that landed WHILE generateMedia was in-flight (a non-cooperative adapter that ignored the signal,
    // or one that resolved just as the run cancelled) must win: skip BOTH the async park / sync media outcome AND
    // the stray cost:updated below — mirroring the post-turn abort re-check the inline/stream chat paths run.
    // (#onOutcome drops a post-cancel completed anyway; returning `cancelled` here also suppresses the cost emit.)
    if (ctx.signal.aborted) {
      admission?.settleAtReservedEstimate({ nodeId: node.id });
      return failed(
        'cancelled',
        `agent node '${node.id}': run cancelled during media generation`,
        false,
      );
    }

    const outcome = buildGenerativeOutcome(ctx, node, primary, modality.modality, units, result, {
      resolvePrice: deps.resolvePrice,
      onRealizedCost: (realizedMicrocents: number) => admission?.settle(realizedMicrocents),
    });
    if (outcome.kind === 'media_job') {
      retainMediaJobAdmission(outcome.job, admission);
      admission = undefined; // ownership moved to the engine-owned parked-job lifecycle
    } else if (outcome.kind !== 'completed' && egressStarted) {
      // A malformed/mismatched provider result is still evidence that the provider processed a request. No exact
      // charge is trustworthy, so retain the bounded estimate instead of treating an internal validation failure as
      // a free call.
      admission?.settleAtReservedEstimate({ nodeId: node.id });
    }
    return outcome;
  } finally {
    // A synchronous completion settles actual cost before its event; a known pre-egress credential/cancel failure
    // releases. Async ownership was transferred above. All ambiguous post-egress paths settled conservatively.
    admission?.release();
  }
}

/**
 * Map a `generateMedia` throw through the SAME taxonomy as the chat path: an `LlmProviderError` →
 * `codeForLlmError` (content-policy → `content_filter`, cancel → `cancelled`, …); an `LlmConfigError` (e.g.
 * `UnsupportedCapabilityError` for a non-image modality / DeepSeek) → `validation` with its secret-free
 * message (never let the engine catch-all flatten it to opaque `internal`); anything else → `turnOutcomeForError`.
 */
function mapGenerateMediaError(err: unknown): NodeOutcome {
  if (err instanceof LlmProviderError) {
    return failed(codeForLlmError(err.llmError), err.llmError.message, err.llmError.retryable);
  }
  if (err instanceof LlmConfigError) {
    return failed('validation', err.message, false);
  }
  return turnOutcomeForError(err);
}

/**
 * Validate a resolved `generateMedia` result against the seam contract and build the node outcome. The
 * adapter result is NOT re-parsed at this boundary, so the `MediaGenResult` exactly-one-of refine is enforced
 * explicitly: BOTH present would let the async `jobId` branch silently DISCARD `media`, NEITHER would leave no
 * output — both are a misbehaving/hand-built adapter result (internal), not an authoring error. An async
 * `jobId` → the engine's media-job handoff (Section D); a sync `media` part → the de-inlined `{ text:'', media }`
 * output plus the lone realized `cost:updated` (ADR-0045 §5).
 */
function buildGenerativeOutcome(
  ctx: NodeExecContext,
  node: AgentNode,
  primary: FallbackPlanEntry,
  modality: MediaBilledModality,
  units: number,
  result: MediaGenResult,
  /** The money seam, grouped: the user-pricing overlay and the realized-cost sink always travel together. */
  costing: {
    readonly resolvePrice: PricingOverlay | undefined;
    readonly onRealizedCost: (costMicrocents: number) => void;
  },
): NodeOutcome {
  const { resolvePrice, onRealizedCost } = costing;
  if (result.jobId !== undefined && result.media !== undefined) {
    return failed(
      'internal',
      `agent node '${node.id}': generateMedia returned BOTH media and jobId (exactly one required)`,
      false,
    );
  }
  if (result.jobId !== undefined) {
    // ASYNC LRO (Sora/Veo, 1.AG Section D, ADR-0045): the provider accepted a minute-scale job and returned an
    // opaque jobId. Hand it to the ENGINE (poll/checkpoint/resume/cancel) — `units` is the authored volume for
    // the lone realized cost addend the engine emits at `done` (ADR-0045 §5), NOT emitted here.
    return {
      kind: 'media_job',
      job: {
        jobId: result.jobId,
        provider: primary.provider.id,
        model: primary.model,
        modality,
        units,
      },
    };
  }
  if (result.media === undefined) {
    return failed(
      'internal',
      `agent node '${node.id}': generateMedia resolved neither media nor jobId`,
      false,
    );
  }
  // Defense-in-depth: the produced media's modality must match what the node requested (and was budgeted for) —
  // a misbehaving adapter returning an audio part for an image request is a validation failure, not a silent
  // mis-billed handle. mediaModalityOf derives the modality from the bare MIME.
  if (mediaModalityOf(result.media.mimeType) !== modality) {
    return failed(
      'validation',
      `agent node '${node.id}': generative model returned ${result.media.mimeType} but the node requested '${modality}'`,
      false,
    );
  }
  // Exactly ONE realized cost:updated (ADR-0045 §5) — derived from the request volume × the per-model media
  // rate (best-effort: an unknown/unrated model degrades to 0, H4). The engine folds it into the run cumulative.
  const realized = realizedMediaCost(primary.model, modality, units, resolvePrice);
  // Settle before emitting to the engine: if a synchronous event sink faults after provider success, the admission
  // cannot be released as though the charged generation never happened.
  onRealizedCost(realized.costMicrocents);
  ctx.emit({
    type: 'cost:updated',
    nodeId: node.id,
    model: primary.model,
    inputTokens: 0,
    outputTokens: 0,
    costMicrocents: realized.costMicrocents,
    cumulativeCostMicrocents: 0, // placeholder — the engine overwrites with the authoritative run-wide total
    // Only ever `false`, never `true` — mirroring the chain's `#emitFolded`, where the flag's absence is the
    // ordinary case and its presence is the warning (ADR-0070 §6). A `0` here with real produced units and no
    // flag would be indistinguishable from a genuinely free generation, which is the ambiguity `CR-55` names.
    ...(realized.priced ? {} : { priced: false }),
  });
  // The pure-media node output ({ text:'', media:[part] }) de-inlines at #emitDurable exactly like the inline
  // path. `MediaGenResult.raw` is provider-internal and is never part of the media part (strip-on-sink, §7).
  return {
    kind: 'completed',
    output: { text: '', media: [result.media] },
    tokensUsed: { input: 0, output: 0, model: primary.model },
  };
}

/**
 * Derive the SINGLE billed output modality a generative node produces. A generative model emits pure media,
 * so `output_modalities` must declare exactly one of `image`/`audio`/`video` — no text, no second modality.
 */
function singleBilledModality(
  outputModalities: readonly OutputModality[] | undefined,
  nodeId: string,
): { ok: true; modality: MediaBilledModality } | { ok: false; message: string } {
  const all = outputModalities ?? [];
  const billed = all.filter(isBilledModality);
  const [only] = billed;
  if (only === undefined || billed.length !== 1 || all.length !== 1) {
    return {
      ok: false,
      message: `agent node '${nodeId}': a media_surface 'generative' model requires output_modalities to declare exactly one media modality (image | audio | video), with no text`,
    };
  }
  return { ok: true, modality: only };
}

/**
 * The authored generation volume for a modality: `count` (image) or `duration_seconds` (audio/video). For an
 * audio/video generator that takes BOTH (N clips of D seconds each), the volume is `count × duration_seconds`
 * (ADR-0045 §5 — "count × durationSeconds for a generator that takes both"); a `duration`-only node multiplies
 * by an implicit `count` of 1, so it is unchanged. Each missing field falls back to the conservative built-in
 * default ({@link DEFAULT_MEDIA_UNIT_ESTIMATE}).
 *
 * NOTE: unlike the chat path's {@link buildMediaUnitsEstimate} (which reads `[defaults].media_cost_estimate`),
 * the generative path uses the AUTHOR-DECLARED volume (`count`/`duration_seconds`) directly — the realized fold
 * must reflect the actual requested volume, and the same number gates the pre-egress estimate (no host default).
 */
export function generativeUnits(modality: MediaBilledModality, node: AgentNode): number {
  if (modality === 'image') {
    return node.count ?? DEFAULT_MEDIA_UNIT_ESTIMATE.image;
  }
  const duration = node.duration_seconds ?? DEFAULT_MEDIA_UNIT_ESTIMATE[modality];
  return duration * (node.count ?? 1);
}

/**
 * Best-effort realized media cost for a generative call (ADR-0045 §5): the request volume × the per-model
 * media rate, via the shared `cost()` fold (token counts are 0).
 *
 * **It reports whether it could price the call, and that is the point**
 * ([ADR-0089](../../../../docs/decisions/0089-media-correctness-four-boundaries.md) §4). This path does NOT
 * go through a `FallbackChain` attempt record, so the `priced: false` signal the chain emits for an unpriced
 * model never reaches it — and a media generation is the call class most likely to be unpriced, which made
 * the one path `CR-55` is about the one path unable to say so. It still degrades to 0 rather than failing (H4
 * — a successful, already-paid generation must never become a failed node); what is new is that the caller is
 * told the 0 is a gap, not a charge.
 */
export function realizedMediaCost(
  model: string,
  modality: MediaBilledModality,
  units: number,
  resolvePrice?: PricingOverlay,
): { readonly costMicrocents: number; readonly priced: boolean } {
  const mediaUnits: MediaUnitsEntry[] = [
    { modality, direction: 'output', units, unit: modality === 'image' ? 'count' : 'second' },
  ];
  try {
    const priced = cost(model, { inputTokens: 0, outputTokens: 0, mediaUnits }, resolvePrice);
    return {
      costMicrocents: priced.microcents,
      priced: priced.unpricedModalities.length === 0,
    };
  } catch {
    // An unknown model — OR any pricing-layer fault. Both mean the same thing to a reader of the event: this
    // figure is not the charge. (FallbackChain #emitSuccess swallows a pricing throw the same way, and marks
    // its attempt `priced: false` for it.)
    return { costMicrocents: 0, priced: false };
  }
}

/** Build the ordered fallback plan: primary (node-over-agent model) + each authored fallback entry. */
/**
 * The primary chain entry's attempt budget on a workflow node with NO authored `retry:` block — the only case
 * where the chain is the sole retry, because the engine's above-chain loop needs an authored budget to run.
 * Mirrors `SESSION_PRIMARY_MAX_ATTEMPTS` in `agent-session.ts`; ADR-0040 carries the dated amendment.
 */
const UNAUTHORED_PRIMARY_MAX_ATTEMPTS = 2;

function buildPlanEntries(
  agent: Agent,
  node: AgentNode,
  deps: AgentRunnerDeps,
): { ok: true; entries: FallbackPlanEntry[] } | { ok: false; code: ErrorCode; message: string } {
  const primary = deps.resolveProvider(agent.provider);
  if (primary === undefined) {
    return { ok: false, code: 'internal', message: `no provider wired for '${agent.provider}'` };
  }
  // The primary entry does NOT consume `node.retry`: ADR-0040 (amending ADR-0038) makes `node.retry` the
  // engine's ABOVE-chain node-retry budget (applied around the whole chain), not the primary provider's
  // within-chain same-model retry. A within-chain primary retry, if ever wanted, is a future primary
  // `max_attempts` field (ADR-0040 A.2), not `retry`.
  //
  // But ONE attempt only when there IS an above-chain budget. `#shouldRetry` returns false for
  // `retry === undefined`, and `RetrySchema.max` has no default — so a node with no authored `retry:` block
  // has no retry above the chain at all, and at a chain budget of 1 the chain's own guard (`attempt < budget`)
  // is false too, so nothing retries and even the backoff is unreachable. That was invisible until #276,
  // because the vendor SDKs' internal retry was quietly absorbing transient 429/5xx inside the adapter.
  // So: 2 when unauthored, 1 when authored — never both, which would MULTIPLY the author's budget (an
  // authored `retry.max: 3` would become up to 6 real calls), exactly what ADR-0040 exists to prevent.
  //
  // "Authored" is `node.retry ?? agent.retry`, matching `Engine#retryConfig` EXACTLY (ADR-0040 A.8). Checking
  // only `node.retry` looked right and was wrong: an AGENT-level `retry:` also gives the engine a budget, so
  // that reading double-counted it. Two e2e tests caught it, which is what they are for.
  const aboveChainBudgetExists = (node.retry ?? agent.retry) !== undefined;
  const entries: FallbackPlanEntry[] = [
    {
      provider: primary,
      model: node.model ?? agent.model,
      maxAttempts: aboveChainBudgetExists ? 1 : UNAUTHORED_PRIMARY_MAX_ATTEMPTS,
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

/**
 * System = authored text ONLY, built by the one constructor that can produce the branded type (ADR-0081 §1).
 * The prompt → user.
 */
function assembleMessages(
  agent: Agent,
  node: AgentNode,
  userText: string,
): { system: AuthoredSystemPrompt; messages: LlmMessage[] } {
  const messages: LlmMessage[] =
    userText.length > 0 ? [{ role: 'user', content: [{ type: 'text', text: userText }] }] : [];
  return { system: authoredSystemPrompt({ kind: 'agent', agent, node }), messages };
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
    // The model-visible description carries a provenance line for a server-supplied tool (ADR-0088 §7.2).
    const description = modelVisibleDescription(def);
    const parsed = ToolDefSchema.safeParse({
      name: def.id,
      ...(description.length > 0 ? { description } : {}),
      parameters: def.llmVisibleParams,
    });
    if (!parsed.success) {
      // A registered tool carries an invalid LLM-visible schema — a host-wiring bug, not a model failure.
      // Classify it (rather than let a raw ZodError escape) — parity with AgentSession.buildLlmTools.
      throw new AgentTurnError(
        'internal',
        `granted tool '${def.id}' has an invalid LLM schema`,
        false,
      );
    }
    out.push(parsed.data);
  }
  return out;
}

/** Node-over-agent generation knobs (the node override wins; ADR-0038). */
function resolveGenKnobs(
  agent: Agent,
  node: AgentNode,
  deps: AgentRunnerDeps,
): { temperature?: number; maxTokens?: number; reasoningEffort?: ReasoningEffort } {
  const temperature = node.temperature ?? agent.temperature;
  const maxTokens = node.max_tokens ?? agent.max_tokens;
  // ADR-0066/0071: send the tier ONLY when the model is on record as ACCEPTING it — not merely as reasoning.
  // `gpt-5.4-pro` reasons and rejects `low`; a boolean capability said `true` and let that straight through.
  // A rejected tier is WITHHELD, never promoted to a neighbour (that would change behaviour and raise spend
  // silently). The per-fallback-entry re-gate lives in the chain, so a failover to a different-capability model
  // never carries a field it does not take.
  const gate = gateReasoningEffort(
    agent.reasoning_effort,
    agent.model,
    deps.resolveEffortTiers,
    deps.withheldByCap !== undefined && maxTokens !== undefined
      ? { maxTokens, withheldByCap: deps.withheldByCap }
      : undefined,
  );
  // …and TELL the host when it withheld. The gate turned a loud 400 into a quiet no-op, and a quiet no-op on a
  // knob the author deliberately set is the worse of the two: the run succeeds, the field is gone, and the bill
  // lands at the provider's default tier with nothing in the output to explain why. `capped` — a budget model whose
  // tier this node's `max_tokens` withholds (review M6) — is the same silent no-op and rides the same channel.
  if (gate.kind === 'rejected' || gate.kind === 'uncontrollable' || gate.kind === 'capped') {
    deps.onEffortWithheld?.(gate, agent.model);
  }
  const reasoningEffort = effortToSend(gate);
  return {
    ...(temperature === undefined ? {} : { temperature }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  };
}

/**
 * The bounded `generateMedia` submission (`CR-21b`) — the seam call and its race, lifted out of
 * `executeGenerativeMedia` so that function's budget/egress bookkeeping reads as one story again.
 *
 * The scope's merged signal REPLACES `ctx.signal` on the request: `openDeadline` merges the caller's abort
 * with the deadline's, so a well-behaved adapter stops on either cause, and the race covers one that
 * honours neither.
 */
async function submitGenerativeMedia(
  provider: NonNullable<FallbackPlanEntry['provider']>,
  req: MediaGenRequest,
  key: string,
  deadline: DeadlineScope | undefined,
  nodeId: string,
): Promise<{ kind: 'ok'; result: MediaGenResult } | { kind: 'refused'; outcome: NodeOutcome }> {
  if (provider.generateMedia === undefined) {
    throw new Error('generateMedia is absent — the caller checks this before reaching here');
  }
  const call = provider.generateMedia(
    deadline === undefined ? req : { ...req, signal: deadline.signal },
    key,
  );
  if (deadline === undefined) {
    return { kind: 'ok', result: await call };
  }
  const raced = await deadline.race(call);
  if (raced.outcome !== 'deadline') {
    return { kind: 'ok', result: raced.value };
  }
  // `classify()` owns the label: a caller cancel that beat the timer stays `cancelled`, the same cancel-wins
  // precedence ADR-0036 gives the run and ADR-0082 §7 gives an attempt.
  return {
    kind: 'refused',
    outcome:
      deadline.classify() === 'caller'
        ? failed(
            'cancelled',
            `agent node '${nodeId}': run cancelled during media generation`,
            false,
          )
        : failed(
            'provider_unavailable',
            `agent node '${nodeId}': the provider did not respond within the ${String(MEDIA_GEN_SUBMIT_TIMEOUT_MS)}ms media-submission deadline`,
            true,
          ),
  };
}

/**
 * Open a deadline for the generative submission, or `undefined` when the host wired no timer port — the same
 * both-or-neither shape `FallbackChain#openDeadline` uses (ADR-0082 §6): a chain given only one primitive
 * keeps the old unbounded behaviour rather than pretending to a guarantee it cannot make.
 */
function openGenerativeDeadline(
  deps: AgentRunnerDeps,
  callerSignal: AbortSignalLike,
): DeadlineScope | undefined {
  const newController = deps.newAbortController;
  const setTimer = deps.setTimer;
  if (newController === undefined || setTimer === undefined) return undefined;
  // **`callerSignal` is REQUIRED here, not optional, and omitting it shipped a regression.** The scope's
  // merged signal REPLACES `ctx.signal` on the request, so the merge is the only thing still connecting a
  // run cancel to the adapter. Opened without it, three things broke at once: a well-behaved adapter never
  // saw the cancel (it held a controller only the 120 s timer ever aborts), `race()` had no caller waker so
  // the node waited out the full bound after a Ctrl-C, and `classify()` could never return `'caller'` —
  // making the `cancelled` arm at the call site dead code that reported a cancel as a retryable
  // `provider_unavailable`.
  //
  // That is `PR83-03`'s defect one call site over, and `deadline.ts`'s own `callerCancelled` docblock
  // records the measurement from the first time: "120 seconds of a cancel that looks ignored". Both siblings
  // pass one — `FallbackChain#openDeadline` its `req.signal`, the engine's `#openPollDeadline` its
  // `#abort.signal` — so this is the parameter, not a parameter.
  return openDeadline(MEDIA_GEN_SUBMIT_TIMEOUT_MS, newController, setTimer, callerSignal);
}

/** Forward only the platform-level chain capabilities the host supplies. */
function chainCapabilities(deps: AgentRunnerDeps): ChainCapabilities {
  return {
    keyFor: deps.keyFor,
    sleep: deps.sleep,
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.onAuthError === undefined ? {} : { onAuthError: deps.onAuthError }),
    ...(deps.resolveForEgress === undefined ? {} : { resolveForEgress: deps.resolveForEgress }),
    ...(deps.newAbortController === undefined
      ? {}
      : { newAbortController: deps.newAbortController }),
    ...(deps.setTimer === undefined ? {} : { setTimer: deps.setTimer }),
    ...(deps.attemptTimeoutMs === undefined ? {} : { attemptTimeoutMs: deps.attemptTimeoutMs }),
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
