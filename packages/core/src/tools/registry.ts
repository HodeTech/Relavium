/**
 * The engine-side `ToolRegistry` + dispatch (1.T). Pure: it owns tool POLICY + DISPATCH and performs
 * every side effect through the injected {@link ToolHost} (ADR-0037). The dispatch lifecycle's order is
 * security-load-bearing — the effective argument set is assembled and validated BEFORE the guardrail
 * checks, so a `tool` node (whose args come entirely from `input_mapping`, no model args) cannot bypass
 * the allowlist by being checked before its args exist. The canonical contract is
 * [tool-registry.md](../../../../docs/reference/shared-core/tool-registry.md).
 */

import {
  type DurableMediaPart,
  type EffectPrepareVerdict,
  type EffectTier,
  extractHttpsHost,
  isEffectConflictError,
  type ToolActionClass,
} from '@relavium/shared';

import {
  boundForModel,
  redactInlineMedia,
  redactSecretShapedText,
  redactSecretShapedValue,
} from './bounding.js';
import {
  ToolEffectNeedsAttentionError,
  ToolUnavailableError,
  ToolEffectConflictError,
  ToolArgsInvalidError,
  ToolCancelledError,
  ToolDeniedByUserError,
  ToolDispatchError,
  ToolExecutionError,
  ToolPolicyError,
  UnknownToolError,
} from './errors.js';
import { takeMediaAttachment } from './media-attachment.js';
import { markUntrusted } from './untrusted.js';
import {
  DEFAULT_TOOL_RESULT_LIMITS,
  type CreateToolRegistryOptions,
  type PolicyTarget,
  type ToolActionPreview,
  type ToolApprovalDecision,
  type ToolApprovalRequest,
  type ToolCallPart,
  type ToolDef,
  type ToolDispatchContext,
  type ToolDispatchOutcome,
  type ToolHost,
  type ToolId,
  type ToolResultPart,
} from './types.js';
import { journaledTier } from './effect-predicate.js';

/**
 * The "no replay happened" marker. A unique object, never `undefined`: `undefined` is a legitimate retained
 * result, and conflating the two would re-dispatch a genuinely-nothing-returning effect on every resume.
 */
const NOT_REPLAYED: unique symbol = Symbol('not-replayed');

/**
 * What a `committed` row retains, so a replay can RE-DELIVER the original outcome rather than re-derive it
 * ([effect-journal.md](../../../../docs/reference/shared-core/effect-journal.md) §4).
 *
 * `mapped` is present only when the node configured an `output_mapping`; without one it would be the full
 * unbounded result, which must never reach `history.db`.
 */
interface ReplayEnvelope {
  readonly value: unknown;
  readonly truncated: boolean;
  readonly summary: string;
  readonly mapped?: unknown;
  /** Whether an `output_mapping` was configured when the effect ran — a config change refuses the replay. */
  readonly hadMapping: boolean;
}

/**
 * The retained envelope AS IT IS STORED — a JSON-safe encoding, which the in-memory shape is not.
 *
 * **`hasValue` exists because `JSON.stringify` DELETES a property whose value is `undefined`.** This file
 * goes out of its way to treat `undefined` as a legitimate tool result — that is what `NOT_REPLAYED` is for
 * — and then handed the envelope to a store that dropped exactly that key. A review reproduced the
 * consequence against real SQLite: `{ value: undefined, truncated: false, summary: '', hadMapping: false }`
 * came back as `{ truncated, summary, hadMapping }`, the reader's `'value' in stored` guard failed, the
 * compatibility fallback treated the whole METADATA OBJECT as an old bare result, and the replayed tool
 * result was that object instead of `undefined`. First run and resumed run produced different values, only
 * after a crash, and only for a tool that returns nothing.
 *
 * `mapped` needs no parallel tag: `hadMapping` already records whether a mapping was CONFIGURED, so a
 * mapping that legitimately projects to `undefined` reads back as an absent `mapped` with `hadMapping: true`
 * — which is the right answer. That distinction was already deliberate here; this one was missed.
 */
interface StoredReplayEnvelope {
  /** The encoding version. Absent on rows written before this existed — see {@link asReplayEnvelope}. */
  readonly v: 1;
  /** Whether the tool produced a value at all. `false` means it returned `undefined`, deliberately. */
  readonly hasValue: boolean;
  readonly value?: unknown;
  readonly truncated: boolean;
  readonly summary: string;
  readonly mapped?: unknown;
  readonly hadMapping: boolean;
}

/** Encode for storage: everything JSON keeps, plus the presence bit JSON would otherwise destroy. */
function toStoredEnvelope(envelope: ReplayEnvelope): StoredReplayEnvelope {
  return {
    v: 1,
    hasValue: envelope.value !== undefined,
    ...(envelope.value === undefined ? {} : { value: envelope.value }),
    truncated: envelope.truncated,
    summary: envelope.summary,
    ...(envelope.mapped === undefined ? {} : { mapped: envelope.mapped }),
    hadMapping: envelope.hadMapping,
  };
}

/**
 * Read a retained result back as an envelope, across all three shapes a row can be in.
 *
 * A stored row crosses a persistence boundary, so it is validated structurally rather than cast, and each
 * fallback is conservative — an unrecognised shape becomes an untruncated value with an empty summary, never
 * a mapped projection it is not.
 *
 * The legacy-envelope arm keeps the pre-`v` ambiguity it inherited: a row written before the presence tag
 * whose value was `undefined` is genuinely indistinguishable from a bare stored value, because the byte that
 * would tell them apart was never written. New rows carry `v: 1` and are unambiguous.
 */
function asReplayEnvelope(stored: unknown): ReplayEnvelope {
  if (typeof stored === 'object' && stored !== null && 'v' in stored) {
    const versioned = stored as StoredReplayEnvelope;
    if (
      versioned.v === 1 &&
      typeof versioned.hasValue === 'boolean' &&
      typeof versioned.truncated === 'boolean' &&
      typeof versioned.summary === 'string' &&
      typeof versioned.hadMapping === 'boolean'
    ) {
      return {
        value: versioned.hasValue ? versioned.value : undefined,
        truncated: versioned.truncated,
        summary: versioned.summary,
        ...('mapped' in versioned ? { mapped: versioned.mapped } : {}),
        hadMapping: versioned.hadMapping,
      };
    }
    // A `v` this build does not know, or a malformed one: FAIL CLOSED to "cannot re-deliver". Treating an
    // unreadable versioned row as a bare value would replay its own metadata, which is the defect above.
    return { value: undefined, truncated: false, summary: '', hadMapping: false };
  }
  if (
    typeof stored === 'object' &&
    stored !== null &&
    'value' in stored &&
    'truncated' in stored &&
    'summary' in stored &&
    typeof (stored as { truncated: unknown }).truncated === 'boolean' &&
    typeof (stored as { summary: unknown }).summary === 'string'
  ) {
    const envelope = stored as ReplayEnvelope;
    // An older row has no `hadMapping`; infer it conservatively from whether a projection was retained.
    return typeof envelope.hadMapping === 'boolean'
      ? envelope
      : { ...envelope, hadMapping: 'mapped' in envelope };
  }
  return { value: stored, truncated: false, summary: '', hadMapping: false };
}

/** Build the engine-side tool registry. Performs no I/O and reads no ambient state (engine purity). */
export function createToolRegistry(options: CreateToolRegistryOptions): {
  dispatch(toolCall: ToolCallPart, ctx: ToolDispatchContext): Promise<ToolDispatchOutcome>;
  has(id: ToolId): boolean;
  list(): readonly ToolId[];
} {
  const tools = new Map<ToolId, ToolDef>();
  for (const def of options.tools) {
    if (tools.has(def.id)) {
      throw new Error(`duplicate tool id \`${def.id}\` registered`);
    }
    tools.set(def.id, def);
  }
  const host = options.host;

  return {
    has: (id) => tools.has(id),
    list: () => [...tools.keys()].sort((a, b) => a.localeCompare(b)),
    dispatch: (toolCall, ctx) => dispatch(tools, host, toolCall, ctx),
  };
}

/**
 * Settle a journal row without letting the settle's own failure replace the error that caused it.
 *
 * A settle that cannot be written leaves the row `prepared`, which a resumed run reads as unresolved and
 * refuses — the same conservative answer, reached by a different route. Swallowing here is therefore not a
 * silent catch: the fail-closed outcome is preserved by the row's state, and rethrowing would discard the
 * dispatch error that actually explains what happened.
 */
/**
 * Whether a dispatch throw proves the call never reached a target.
 *
 * Only a capability gap qualifies: `requireFs`/`requireProcess`/`requireEgress` throw synchronously inside
 * the dispatch arm before the host is touched, so the effect demonstrably did not happen. Everything else —
 * a network error, a timeout, an abort — is genuinely ambiguous and must be recorded as such.
 */
function neverLeftTheProcess(cause: unknown): boolean {
  return cause instanceof ToolUnavailableError;
}

/**
 * §7 step 8's SETTLE — after bounding, and deliberately so.
 *
 * ADR-0080 §7 said "immediately"; what ships settles once the BOUNDED value exists, for two reasons the spec
 * is being corrected to state. First, the gate's job is to RE-DELIVER the model-facing result, so the bounded
 * value is the one worth keeping — persisting the raw result would put unbounded `run_command` stdout into
 * `history.db` with no cap and no sweep. Second, the wider window costs nothing but interruptions: a crash
 * before this leaves the row `prepared`, which resume reads as unresolved and REFUSES. `prepared` is safe.
 *
 * **All four projections the outcome is built from, not just the bounded value.** A review proved why:
 * storing only `bounded.value` and re-deriving the rest on replay ran `output_mapping` over the TRUNCATION
 * PREVIEW. Same tool, same args, `output_mapping: { code: 'status' }` — the first dispatch put `200` into
 * workflow state and the replayed one put `undefined`, silently, and only when the result had exceeded the
 * bounding ceiling. §4 promises to RE-DELIVER what the original produced, so that is what is kept.
 */
async function settleCommitted(
  ctx: ToolDispatchContext,
  toolId: ToolId,
  bounded: { readonly value: unknown; readonly truncated: boolean; readonly summary: string },
  outputMapped: unknown,
): Promise<void> {
  const hadMapping = ctx.config.outputMapping !== undefined;
  try {
    // Encoded for storage on the way out (`toStoredEnvelope`), because the in-memory shape is not JSON-safe:
    // a `value` of `undefined` is a legitimate result here and a deleted property there.
    await ctx.effects.settle(
      ctx.effectSlot,
      toolId,
      'committed',
      toStoredEnvelope({
        value: bounded.value,
        truncated: bounded.truncated,
        summary: bounded.summary,
        // …the mapped projection ONLY when a mapping is configured. Without one, `outputMapped` IS the full
        // result, and persisting that would put unbounded `run_command` stdout into `history.db` — the very
        // thing settling after bounding exists to avoid. With one, the author chose an extract.
        ...(hadMapping ? { mapped: outputMapped } : {}),
        // Recorded rather than inferred from `'mapped' in envelope`: a mapping that legitimately projects to
        // `undefined` would otherwise be indistinguishable from no mapping at all.
        hadMapping,
      } satisfies ReplayEnvelope),
    );
  } catch (cause) {
    // **The one window where the effect PROVABLY happened and the record does not say so.** Spec §7 step 4:
    // the row stays `prepared`, the run stops, and it is never retried. Letting this fall into the generic
    // ladder made it `tool_failed` — indistinguishable from an ordinary tool bug, and on the chat surface it
    // routed to the "fix the target and resend" hint, the one instruction that could make a human repeat a
    // real external effect.
    throw new ToolEffectNeedsAttentionError(toolId, cause);
  }
}

/**
 * What a FAILED dispatch means for the journal row — the whole of §7 step 4, in one place.
 *
 * Three outcomes, and the distinctions are the point:
 *
 * - **Not journaled at all** (`tier === undefined`), or a REPLAY: nothing to record. The replay guard is not
 *   redundant even though only the dispatch is wrapped — a replay takes the other arm of the ternary and
 *   cannot throw here today, and this is what keeps that true if the arm ever grows. A replay's row is
 *   already terminal, and settling out of `committed` would lose the result the replay re-delivered.
 * - **A proven NON-dispatch**: a missing host capability throws synchronously inside the dispatch arm before
 *   the host is ever touched, so the effect demonstrably did not happen. `ambiguous` would claim we do not
 *   know what the target did, about a call that never reached one — but doing nothing left the row
 *   `prepared`, which the machine reads as UNRESOLVED: it blocked resume, was disclosed as an effect that
 *   may have landed, and was never swept. The claim is released instead, restoring the state that preceded
 *   the prepare a moment earlier.
 * - **Everything else** — a network error, a timeout, an abort — is genuinely ambiguous and recorded as such.
 *
 * Both writes are quiet: the dispatch error is the one that explains what happened, and a failed write
 * leaves the row `prepared`, which is the same conservative answer reached the long way.
 */
async function journalDispatchFailure(
  ctx: ToolDispatchContext,
  toolId: ToolId,
  tier: EffectTier | undefined,
  isFirstDispatch: boolean,
  cause: unknown,
): Promise<void> {
  if (tier === undefined || !isFirstDispatch) return;
  if (neverLeftTheProcess(cause)) {
    await discardQuietly(ctx, toolId);
    return;
  }

  await settleQuietly(ctx, toolId, 'ambiguous');
}

/**
 * Release a `prepared` claim for an effect that provably never left, swallowing a failure.
 *
 * Swallowing is not a silent catch here for the same reason it is not in {@link settleQuietly}: a release
 * that cannot be written leaves the row `prepared`, which a resumed run reads as unresolved and refuses —
 * the conservative outcome, reached by the longer route. Rethrowing would discard the dispatch error that
 * actually explains what happened.
 */
async function discardQuietly(ctx: ToolDispatchContext, toolId: ToolId): Promise<void> {
  try {
    await ctx.effects.discard(ctx.effectSlot, toolId);
  } catch {
    // Left `prepared`; resume treats it as unresolved, which is the safe reading.
  }
}

async function settleQuietly(
  ctx: ToolDispatchContext,
  toolId: ToolId,
  state: 'committed' | 'ambiguous',
): Promise<void> {
  try {
    await ctx.effects.settle(ctx.effectSlot, toolId, state);
  } catch {
    // Left `prepared`; resume treats it as unresolved, which is the honest reading.
  }
}

/**
 * §7 step 2's PREPARE — durable, and BEFORE the effect leaves the process.
 *
 * Everything above this in `dispatch` is a refusal that journals nothing; everything below it may have
 * reached a target. A `prepare` that cannot be written REFUSES the dispatch, which is the fail-closed
 * direction: no journal row means no way to tell a resumed run whether the effect happened.
 */
async function prepareEffect(
  def: ToolDef,
  tier: EffectTier,
  effective: Readonly<Record<string, unknown>>,
  ctx: ToolDispatchContext,
): Promise<EffectPrepareVerdict> {
  try {
    return await ctx.effects.prepare(
      ctx.effectSlot,
      def.id,
      tier,
      // **The SAME projection the event stream gets, and for the same reason.** Redacted here because only
      // the engine knows which args are secret-bearing; hashed in the port because only the host can (core
      // is platform-free). `sanitizeInput` is used rather than a key-name filter because a key-name filter
      // misses exactly what §11 names as the threat: a model-placed credential in an arbitrary position — an
      // `Authorization` header value, a token in a URL query — which `redactSecretShapedValue` scrubs BY
      // SHAPE. A digest is a permanent equality oracle, and a low-entropy secret is recoverable from one on
      // a `history.db` that may be unencrypted at rest.
      sanitizeInput(def, effective, ctx.secretArgKeys),
    );
  } catch (cause) {
    // A CONFLICT is a refusal, not a fault: another attempt already holds this identity, so the effect must
    // not be dispatched — and must not be retried either, because a retry re-collides, burns the whole node
    // budget and reports the wrong cause. Its siblings `AppendConflictError` and `LeaseFencedError` are
    // excluded from retry sets for the same reason.
    if (isEffectConflictError(cause)) throw new ToolEffectConflictError(def.id, cause);
    throw cause; // a store fault: the dispatch is refused, nothing reached a target
  }
}

/**
 * Step 1 — the tool this call names, if the node is allowed to use it.
 *
 * Three refusals, none of which has reached a target: a provider-executed call the engine never dispatches
 * at all (content.ts; ADR-0030/0029 — surfacing one here is a caller bug), an id no registry entry matches,
 * and an id the node was not granted. REGISTERED IS NOT AUTHORIZED, which is the whole reason the grant
 * check sits beside the lookup rather than anywhere later.
 */
function resolveGrantedTool(
  tools: ReadonlyMap<ToolId, ToolDef>,
  toolCall: ToolCallPart,
  ctx: ToolDispatchContext,
): ToolDef {
  if (toolCall.providerExecuted === true) {
    throw new ToolPolicyError(
      toolCall.name,
      'provider_executed',
      `tool \`${toolCall.name}\` is provider-executed and is not dispatched by the engine`,
    );
  }
  const def = tools.get(toolCall.name);
  if (def === undefined) throw new UnknownToolError(toolCall.name, [...tools.keys()]);
  if (!ctx.grantedToolIds.has(def.id)) {
    throw new ToolPolicyError(
      def.id,
      'not_granted',
      `tool \`${def.id}\` is not granted to node \`${ctx.nodeId}\``,
    );
  }
  return def;
}

/**
 * Steps 2-4 — the argument set this call will actually run with, admitted or refused.
 *
 * **The order is security-load-bearing and is the reason these three live together.** The effective set is
 * assembled (model args + `input_mapping` + config-only, config wins) and VALIDATED before the guardrail
 * check, so a `tool` node — whose args come entirely from `input_mapping`, with no model args at all —
 * cannot bypass the allowlist by being checked before its args exist. Secret-taint runs first within the
 * validation (ADR-0029(c)), and the policy target is resolved once here and reused by the approval step.
 *
 * Nothing here has reached a target: every exit is still a refusal that journals nothing.
 */
function admitArgs(
  def: ToolDef,
  toolCall: ToolCallPart,
  ctx: ToolDispatchContext,
): { effective: Readonly<Record<string, unknown>>; args: unknown; target: PolicyTarget } {
  const effective = assembleArgs(def, toolCall.args, ctx);
  assertNoTaintedArgs(def.id, effective, ctx.secretArgKeys);
  let args: unknown;
  try {
    args = def.parseArgs(effective);
  } catch (cause) {
    throw toArgsInvalid(def.id, cause);
  }
  const target = def.policyTarget?.(args) ?? {};
  enforcePolicy(def, target, ctx);
  return { effective, args, target };
}

async function dispatch(
  tools: ReadonlyMap<ToolId, ToolDef>,
  host: ToolHost,
  toolCall: ToolCallPart,
  ctx: ToolDispatchContext,
): Promise<ToolDispatchOutcome> {
  throwIfAborted(ctx, undefined);

  // 1. Resolve by exact id, then check the node grant (registered ≠ authorized).
  const def = resolveGrantedTool(tools, toolCall, ctx);

  // 2-4. Assemble, validate and policy-check the EFFECTIVE argument set.
  const { effective, args, target } = admitArgs(def, toolCall, ctx);

  // Whether THIS call must be journaled, decided once from the validated args (ADR-0080 §3). `undefined` ⇒
  // it mutates nothing external, or its duplicates are benign, and no row is written for it.
  const tier = journaledTier(def, args);
  // Set once the effect has demonstrably left this process. It is what makes every failure BELOW the
  // dispatch non-retryable: re-running a node whose effect may already have landed is the duplicate this
  // whole mechanism exists to prevent, and a post-effect mapping or bounding error is no less dangerous
  // than a dispatch error (ADR-0080 §7 step 5).
  let effectDispatched = false;
  // A sentinel rather than `undefined`, because `undefined` is a legitimate retained result: a tool whose
  // result was genuinely nothing would otherwise be re-dispatched on every resume — the duplicate again.
  let replayed: ReplayEnvelope | typeof NOT_REPLAYED = NOT_REPLAYED;

  // 4b-7. The per-tool approval gate + the single side effect + output_mapping (FULL result) + model-facing
  // bounding — all under one classification ladder so a spill-time (or prompt-time) abort surfaces as
  // `cancelled` (ADR-0036 precedence) and any other tail failure is a classified tool error, never a raw
  // escape. A `ToolDeniedByUserError` from 4b is a `ToolDispatchError` and passes through the ladder verbatim
  // — UNLESS the signal is concurrently aborted, in which case the `isAbort` check below takes precedence
  // (cancel-wins-all, ADR-0036) and the denial becomes `ToolCancelledError`.
  let outputMapped: unknown;
  let bounded: Awaited<ReturnType<typeof boundForModel>>;
  // Handle-only media the dispatch asks the turn loop to deliver on a synthesized `user` message
  // (`CR-50` / ADR-0089 §1). Declared at the outcome's scope, split off at the dispatch boundary below.
  let mediaAttachments: readonly DurableMediaPart[] = [];
  try {
    throwIfAborted(ctx, def.id);
    // 4b. Per-tool approval (ADR-0057 EA3): under the interactive-approval regime (chat), a governed-class
    //     dispatch REQUIRES a confirmAction decision before the side effect; the workflow author-trust path
    //     (no `ctx.approval`) skips it. A denial is a fatal `tool_denied`; an abort while prompting is cancelled.
    await confirmDispatch(def, target, ctx);
    // 4c. **PREPARE — durable, and BEFORE the effect leaves the process** (ADR-0080 §7 step 2). Everything
    //     above this line is a refusal that journals nothing; everything below it may have reached a target.
    //     A `prepare` that cannot be written refuses the dispatch, which is the fail-closed direction: no
    //     journal row means no way to tell a resumed run whether the effect happened.
    if (tier !== undefined) {
      const verdict = await prepareEffect(def, tier, effective, ctx);
      // **The flag flips HERE, before the call — not after a successful settle.** This is the line ADR-0080
      // §7 step 3 draws: past the prepare, the effect MAY have reached the target, so every failure below is
      // non-retryable. Setting it after the settle instead left a dispatch THROW — the canonical timed-out
      // POST — reported as `retryable: true`, which is the duplicate this whole mechanism exists to prevent.
      effectDispatched = true;
      if (verdict.outcome === 'replay') {
        // §4's ONE forward path for a resumed node: this exact effect (same identity, same args digest)
        // already committed with its result retained, so the stored result stands in for the call. The
        // dispatch is skipped entirely — re-running it is precisely the duplicate the journal prevents —
        // and no settle follows, because the row is already terminal.
        //
        // It still flows through mapping and bounding below: those are pure projections, and a replayed
        // result must reach the model in the same shape the original would have.
        replayed = asReplayEnvelope(verdict.result);
      }
    }
    let output: unknown;
    // Split the attachment off HERE, immediately at the dispatch boundary, so everything downstream —
    // `output_mapping`, bounding, the tool result, the spill — sees the ordinary descriptor value and never
    // the envelope. Only `read_media` produces one, and it declares no effect tier, so a replayed value can
    // never carry an attachment (the journal round-trips JSON, which has no symbol to round-trip).
    try {
      if (replayed === NOT_REPLAYED) {
        const dispatched = takeMediaAttachment(await def.dispatch(args, host, ctx));
        // **A journaled effect and a media attachment have no correct resume semantics, so the combination
        // is refused rather than commented against.** The journal round-trips JSON, which cannot carry the
        // envelope's symbol, so a replayed dispatch would restore the descriptor and deliver NO media — the
        // model reading "attached below" for something it never received, silently, with no error and no
        // event. `read_media` declares no tier today, but every discovered MCP tool is unconditionally tier
        // 3, so the next tool that answers with media is one `effect:` away from this. Loud here beats
        // silent on a resume nobody is watching.
        if (tier !== undefined && dispatched.media.length > 0) {
          throw new ToolExecutionError(
            def.id,
            `tool \`${def.id}\` returned a media attachment on a journaled dispatch — a replay cannot re-deliver it`,
            undefined,
            { recoverable: false, retryable: false },
          );
        }
        output = dispatched.value;
        mediaAttachments = dispatched.media;
      } else {
        output = replayed.value;
      }
    } catch (cause) {
      await journalDispatchFailure(ctx, def.id, tier, replayed === NOT_REPLAYED, cause);
      throw cause;
    }
    // Abort that lands AFTER the host resolved must still classify as cancelled, not a success.
    throwIfAborted(ctx, def.id);
    if (replayed === NOT_REPLAYED) {
      // 6. output_mapping runs on the FULL result → workflow state keeps the real value.
      outputMapped = applyOutputMapping(output, ctx.config.outputMapping);
      // 7. Bound the MODEL-FACING result (the full result is untouched above).
      bounded = await boundForModel(
        output,
        ctx.limits ?? DEFAULT_TOOL_RESULT_LIMITS,
        host,
        ctx.signal,
      );
    } else {
      // A REPLAY restores the recorded projections verbatim — it does not re-derive them. Re-deriving is
      // what produced the `output_mapping`-over-a-truncation-preview defect; and re-bounding a value that
      // is already bounded would summarize a summary.
      // **A config change between the crash and the resume is a refusal, not a silent divergence.** The
      // envelope records whether a mapping was configured when the effect ran. If the node's YAML was edited
      // in the crash window, the recorded projection is not what the CURRENT config asks for — replaying it
      // would put the stale answer into workflow state, which is the same failure class as replaying a
      // different call's result, reached from a different direction. A review reproduced both directions.
      if (replayed.hadMapping !== (ctx.config.outputMapping !== undefined)) {
        throw new ToolEffectConflictError(
          def.id,
          new Error(
            `the recorded effect was produced under a different \`output_mapping\` configuration than this node now declares`,
          ),
        );
      }
      outputMapped = 'mapped' in replayed ? replayed.mapped : replayed.value;
      bounded = {
        value: replayed.value,
        truncated: replayed.truncated,
        summary: replayed.summary,
      };
    }
    // 8. **SETTLE — after bounding, and deliberately so.** ADR-0080 §7 said "immediately"; what ships settles
    //    once the BOUNDED value exists, for two reasons the spec is being corrected to state. First, the
    //    gate's job is to RE-DELIVER the model-facing result, so the bounded value is the one worth keeping —
    //    persisting the raw result would put unbounded `run_command` stdout into `history.db` with no cap and
    //    no sweep. Second, the wider window costs nothing but interruptions: a crash before this leaves the
    //    row `prepared`, which resume reads as unresolved and REFUSES. `prepared` is the safe state.
    if (tier !== undefined && replayed === NOT_REPLAYED) {
      await settleCommitted(ctx, def.id, bounded, outputMapped);
    }
    // An abort that lands during bounding (its async fast path yields a microtask) must still classify
    // as cancelled, not a success — the symmetric guard to line 109 after the dispatch await.
    throwIfAborted(ctx, def.id);
  } catch (cause) {
    if (cause instanceof ToolCancelledError) {
      throw cause; // already classified (e.g. throwIfAborted) — never double-wrap
    }
    // Cancel-wins-all (ADR-0036 cancel precedence): once the run's signal is aborted, any failure on
    // this path closes the step as `cancelled`, even a typed ToolDispatchError (e.g. a capability gap).
    // The deterministic error re-surfaces on the next, non-cancelled run; a torn-down run stays cancelled.
    if (isAbort(cause, ctx)) {
      throw new ToolCancelledError(def.id, cause);
    }
    if (cause instanceof ToolDispatchError) {
      throw cause; // a typed error from dispatch (e.g. ToolUnavailableError) passes through
    }
    // Stamp whether the failure is safe to feed back to the model for a within-turn retry (ADR-0057): ONLY an
    // IDEMPOTENT tool — one `governedAction` does not classify as a side-effecting fs_write/process/egress/os
    // action (a read: read_file / list_directory / git_status / invoke_agent / read_media). A governed tool's
    // failure is non-idempotent (a half-run command, a POST that may have landed), so it is NOT recoverable.
    throw new ToolExecutionError(def.id, `tool \`${def.id}\` failed`, cause, {
      recoverable: governedAction(def, target) === undefined,
      // **Not node-retryable once the effect has left the process** (ADR-0080 §8, amending ADR-0037). This
      // covers more than a dispatch throw: a post-dispatch abort, an `output_mapping` error, a bounding or
      // spill failure — all happen AFTER the target acted, and classifying any of them as retryable would
      // have the node re-run and re-fire the effect. `recoverable` above is a different axis (within-turn
      // model recovery); this is the one that gates a fresh node dispatch.
      ...(effectDispatched ? { retryable: false } : {}),
    });
  }

  // 8. Brand the model-facing result untrusted + shape the sanitized event payloads.
  const toolResult: ToolResultPart = {
    type: 'tool_result',
    toolCallId: toolCall.id,
    result: bounded.value,
  };
  return {
    output: outputMapped,
    toolResult: markUntrusted(toolResult),
    mediaAttachments: markUntrusted(mediaAttachments),
    truncated: bounded.truncated,
    events: {
      call: { toolId: def.id, toolInput: sanitizeInput(def, effective, ctx.secretArgKeys) },
      result: { toolId: def.id, success: true, outputSummary: bounded.summary },
    },
  };
}

/* ------------------------------------------------------------------------------------------------ *
 * Step 2 — effective args. Precedence: model args (base) < input_mapping (author-wired) < config-only.
 * A config-only param's value comes ONLY from `ctx.config.parameters` — neither a model argument nor an
 * `input_mapping` value may supply one (ADR-0037: "a model argument can never override one", enforced by
 * the engine, not by convention). Prototype-polluting keys are dropped from every source.
 * ------------------------------------------------------------------------------------------------ */

/** Keys that would walk/poison the prototype chain — never a legitimate tool argument name. */
const UNSAFE_ARG_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function assembleArgs(
  def: ToolDef,
  modelArgs: unknown,
  ctx: ToolDispatchContext,
): Record<string, unknown> {
  const configOnly = new Set(def.configOnlyParams ?? []);
  const effective: Record<string, unknown> = {};
  // 1. Model-supplied args are the base — but a config-only key from the model is dropped (config is its
  //    only source) and a prototype-polluting key is never copied.
  copyArgs(effective, modelArgs, configOnly);
  // 2. Author-wired input_mapping — same exclusions, so a config-only value cannot enter via state either.
  copyArgs(effective, ctx.config.inputMapping, configOnly);
  // 3. Config-only params — the ONE source for these (config wins; absent ⇒ the tool's own default).
  const params = ctx.config.parameters;
  if (params !== undefined) {
    for (const key of configOnly) {
      if (UNSAFE_ARG_KEYS.has(key)) {
        continue;
      }
      if (Object.hasOwn(params, key)) {
        effective[key] = params[key];
      }
    }
  }
  return effective;
}

/** Copy own keys from `source` into `target`, skipping the `exclude` set and prototype-polluting names. */
function copyArgs(
  target: Record<string, unknown>,
  source: unknown,
  exclude: ReadonlySet<string>,
): void {
  if (!isRecord(source)) {
    return;
  }
  for (const key of Object.keys(source)) {
    if (UNSAFE_ARG_KEYS.has(key) || exclude.has(key)) {
      continue;
    }
    target[key] = source[key];
  }
}

/* ------------------------------------------------------------------------------------------------ *
 * Step 3 — secret taint (ADR-0029(c), re-applied on the effective set) + arg validation.
 * ------------------------------------------------------------------------------------------------ */

function assertNoTaintedArgs(
  toolId: ToolId,
  effective: Record<string, unknown>,
  secretArgKeys: ReadonlySet<string> | undefined,
): void {
  if (secretArgKeys === undefined || secretArgKeys.size === 0) {
    return;
  }
  const tainted = Object.keys(effective).filter((key) => secretArgKeys.has(key));
  if (tainted.length > 0) {
    const sorted = tainted.toSorted((a, b) => a.localeCompare(b));
    throw new ToolArgsInvalidError(
      toolId,
      sorted,
      `tool \`${toolId}\`: a secret-typed value cannot flow into tool arguments (${sorted.join(
        ', ',
      )}) — use a credential reference (ADR-0029)`,
    );
  }
}

function toArgsInvalid(toolId: ToolId, cause: unknown): ToolArgsInvalidError {
  const fields = zodIssuePaths(cause);
  const where = fields.length > 0 ? ` (${fields.join(', ')})` : '';
  return new ToolArgsInvalidError(
    toolId,
    fields,
    `tool \`${toolId}\`: invalid arguments${where}`,
    cause,
  );
}

/** Extract field paths from a ZodError-shaped cause — names only, never the received value. */
function zodIssuePaths(cause: unknown): readonly string[] {
  if (!isRecord(cause)) {
    return [];
  }
  const issues = cause['issues'];
  if (!Array.isArray(issues)) {
    return [];
  }
  const paths = new Set<string>();
  for (const issue of issues) {
    if (isRecord(issue)) {
      const path = issue['path'];
      if (Array.isArray(path)) {
        paths.add(path.map(String).join('.') || '(root)');
      }
    }
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

/* ------------------------------------------------------------------------------------------------ *
 * Step 4 — guardrail policy on the effective args.
 * ------------------------------------------------------------------------------------------------ */

function enforcePolicy(def: ToolDef, target: PolicyTarget, ctx: ToolDispatchContext): void {
  if (def.policy.requiresGateApproval && !ctx.gateApproved) {
    throw new ToolPolicyError(
      def.id,
      'gate_required',
      `tool \`${def.id}\` requires a human-gate approval in an automated workflow`,
    );
  }

  if (def.policy.spawnsProcess && target.command !== undefined) {
    if (!commandAllowed(target.command, ctx.toolPolicy)) {
      throw new ToolPolicyError(
        def.id,
        'command_not_allowed',
        `tool \`${def.id}\`: command not in the allowedCommands allowlist`,
      );
    }
  }

  if (def.policy.egress === 'http' && target.url !== undefined) {
    enforceHttpEgress(def.id, target.url, ctx);
  }
  // egress 'search' / 'mcp' reach a CONFIGURED provider/server (not an allowedDomains allowlist); the
  // SSRF range-block runs inside the host egress capability. No engine allowlist check here.
}

function commandAllowed(command: string, policy: import('@relavium/shared').ToolPolicy): boolean {
  const exact = policy.allowedCommands ?? [];
  if (exact.includes(command)) {
    return true; // exact match (ADR-0029(a)) — `git` never authorizes `git push --force`
  }
  for (const glob of policy.allowedCommandGlobs ?? []) {
    if (globMatch(glob, command)) {
      return true; // opt-in glob
    }
  }
  return false; // empty/absent ⇒ deny-all (symmetry with allowedDomains)
}

/* ------------------------------------------------------------------------------------------------ *
 * Step 4b — per-tool approval (ADR-0057 EA3). Fail-closed under an active interactive-approval regime;
 * a no-op on the workflow author-trust path (no `ctx.approval`) so the workflow path is unchanged.
 * ------------------------------------------------------------------------------------------------ */

async function confirmDispatch(
  def: ToolDef,
  target: PolicyTarget,
  ctx: ToolDispatchContext,
): Promise<void> {
  const approval = ctx.approval;
  if (approval === undefined) {
    return; // the workflow author-trust path — governed tools proceed under the enforcePolicy floor above
  }
  const action = governedAction(def, target);
  if (action === undefined) {
    return; // a read-only / pre-approved tool (fs read, git_status, invoke_agent) is never gated
  }
  // Fail-closed: an active approval regime with no confirm hook DENIES a governed dispatch — so a wiring bug
  // (the chat host wired a write arm but not the hook) can never let `ask` mode write. The floor is the hook,
  // not the advertise-filter.
  if (approval.confirm === undefined) {
    throw new ToolDeniedByUserError(
      def.id,
      'no_approval_hook',
      `tool \`${def.id}\` requires interactive approval, but no approval hook is wired`,
    );
  }
  throwIfAborted(ctx, def.id); // do not prompt for a turn that is already aborting

  const request: ToolApprovalRequest = {
    toolId: def.id,
    action,
    preview: previewFor(action, target),
    // The same field selection, UNSCRUBBED, for CLASSIFICATION only (see the field's own doc). In-process:
    // it never reaches the event, so `preview` stays the one thing crossing the observability boundary.
    unredactedPreview: rawPreviewFor(action, target),
  };
  // EA5: emit the observability event for EVERY governed dispatch that reaches this gate, just before the host
  // decides — a durable "a governed action was gated" trace on the session / `--json` stream (the session
  // stamps the envelope + nodeId), whether the host then prompts a human or auto-decides. Side-effect only — a
  // throwing or absent emitter must NOT change the fail-closed floor, so it is best-effort (swallow any fault;
  // a schema-invalid drift would throw inside the sink's parse and is dropped here rather than breaking the turn).
  try {
    approval.emitApprovalRequested?.(request);
  } catch {
    /* an observability emit must never break the approval decision */
  }

  let decision: ToolApprovalDecision;
  try {
    decision = await approval.confirm(request, ctx.signal);
  } catch (cause) {
    // An abort raised WHILE prompting is a cancellation (cancel precedence) — rethrow so the dispatch
    // ladder classifies it as `cancelled`, never a denial. Any OTHER throw is a fault in the consent layer
    // itself; the approval can't be obtained, so fail-closed: DENY (the side effect must not run on a broken
    // gate — never the retryable `tool_failed` a host-capability throw gets).
    if (isAbort(cause, ctx)) {
      throw cause;
    }
    throw new ToolDeniedByUserError(
      def.id,
      'approval_error',
      `tool \`${def.id}\` denied: the approval could not be obtained`,
    );
  }
  if (decision.outcome !== 'approve') {
    // `decision.reason` is a host-supplied, secret-free label (e.g. "writes are not allowed in ask mode").
    const why =
      decision.reason !== undefined && decision.reason.length > 0
        ? `: ${decision.reason}`
        : ' by the user';
    throw new ToolDeniedByUserError(def.id, 'user_rejected', `tool \`${def.id}\` denied${why}`);
  }
  // An abort that landed WHILE the prompt was pending — the hook approved anyway / ignored the signal —
  // must still cancel: the governed side effect must not run. Mirrors the post-dispatch guard in dispatch()
  // (cancel precedence). Without this, an `approve` that resolves after the signal aborted would proceed.
  throwIfAborted(ctx, def.id);
}

/**
 * Classify a dispatch's governed ACTION class — the authoritative confirmAction floor — or `undefined` for an
 * un-gated tool. A model-controlled `run_command` (a resolved `command` target) is `process`; the pre-approved
 * `git_status` (no command target) is NOT governed — matching `enforcePolicy`, which runs the command allowlist
 * only when a command target is present. An fs READ and `invoke_agent` are not governed
 * ([ADR-0041](../../../../docs/decisions/0041-external-action-governance-seam.md) §ActionClass); every egress
 * IS, even a read-only `web_search` (an exfiltration sink); and an `os` action (`read_clipboard` / `notify`)
 * IS — the clipboard is ambient, un-jailed OS state that routinely holds a freshly-copied secret (ADR-0057).
 * Exported (from this module, NOT the package index) so a drift-lock test can pin the exact engine-governed
 * set, distinct from the CLI advertise-filter's superset.
 */
export function governedAction(def: ToolDef, target: PolicyTarget): ToolActionClass | undefined {
  if (def.policy.fsWrite === true) {
    return 'fs_write';
  }
  if (def.policy.egress !== undefined) {
    return 'egress';
  }
  if (def.policy.spawnsProcess && target.command !== undefined) {
    return 'process';
  }
  if (def.policy.os === true) {
    return 'os';
  }
  return undefined;
}

/**
 * A secret-free preview for the approval prompt: the resolved path / command / host (never a full URL).
 *
 * "Secret-free" is **enforced**, not merely asserted: every field is scrubbed with the SAME
 * `redactSecretShapedText` detector `sanitizeInput()` applies to `toolInput` moments later in this dispatch
 * (ADR-0029(c) — the taint gate only covers KNOWN `secret`-typed args, so a model-placed credential in a
 * `run_command` arg or a `write_file` path would otherwise ride this preview verbatim onto the approval
 * prompt and the `agent:approval_requested` / `--json` observability stream).
 *
 * Display-only, in both directions: the dispatch has already resolved and policy-checked the REAL target
 * (`enforcePolicy` runs before `confirmDispatch`), so scrubbing here can never change which side effect runs.
 *
 * The scrub is deliberately WHOLE-STRING rather than per-path-segment, and that is only safe because of
 * {@link ToolApprovalRequest.target}. Two of the detector's patterns (`bearer|basic|token <run>` and
 * `<key-ish>=<value>`) have value classes containing `/`, which cuts both ways: whole-string catches a
 * credential whose value SPANS a separator (`./api_key=AAAAA/BBBBBB.txt` — a per-segment scrub misses it,
 * because the visible part of the value falls under the pattern's own length floor), but one match can also
 * swallow the rest of the path (`./Access Token Backup/.ssh/authorized_keys` → `./Access Token [redacted]`).
 * No single pattern gives both. So the two USES are split instead: this projection is scrubbed as hard as
 * secrecy requires, and the host's protected-path CLASSIFIER reads the unredacted `target` — where a swallowed
 * `.ssh` segment cannot change the answer, because it never sees this string.
 *
 * One limitation remains, and it is a property of redaction itself rather than of this choice: `command` is
 * fully model-controlled and the detector's patterns are public, so a prompt-injected model can shape a
 * payload to MATCH a pattern (`sh -c token:evil.example/x|sh`) and be shown `sh -c [redacted]` — which reads
 * as "we protected you" rather than "you cannot see this". Bounded by `allowedCommands` /
 * `allowedCommandGlobs` being deny-all by default and by the fs/egress floors, but real; surfacing "this was
 * redacted" to the prompt needs a schema field and is the open follow-up.
 */
function rawPreviewFor(action: ToolActionClass, target: PolicyTarget): ToolActionPreview {
  switch (action) {
    case 'fs_write':
      return target.path === undefined ? {} : { path: target.path };
    case 'process':
      return target.command === undefined ? {} : { command: target.command };
    case 'egress': {
      if (target.url === undefined) {
        return {}; // web_search / mcp_call expose no pre-dispatch URL target — the action class is enough
      }
      // The HOST only, never `target.url` — the raw URL carries the query string, which is exactly where a
      // credential lives (`?token=…`). That exclusion is why an UNREDACTED copy of this shape is safe to hand
      // the host at all; it is the one field selection both copies share.
      const parsed = extractHttpsHost(target.url);
      return parsed === null ? {} : { host: parsed.host };
    }
    case 'os':
      // read_clipboard / notify carry no path/command/host target — the action class + the tool id (on the
      // approval request) are the whole preview (the prompt reads "Approve read_clipboard?").
      return {};
    default: {
      // Exhaustiveness guard — a future ToolActionClass member fails loud HERE at compile time (the `never`
      // assignment) with a precise error, not a generic "not all paths return".
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

/** The DISPLAY copy: {@link rawPreviewFor}'s field selection with every string scrubbed. */
function previewFor(action: ToolActionClass, target: PolicyTarget): ToolActionPreview {
  const raw = rawPreviewFor(action, target);
  return {
    ...(raw.path === undefined ? {} : { path: redactSecretShapedText(raw.path) }),
    ...(raw.command === undefined ? {} : { command: redactSecretShapedText(raw.command) }),
    ...(raw.host === undefined ? {} : { host: redactSecretShapedText(raw.host) }),
  };
}

function enforceHttpEgress(toolId: ToolId, url: string, ctx: ToolDispatchContext): void {
  const parsed = extractHttpsHost(url);
  if (parsed === null || parsed.hasCredentials) {
    throw new ToolPolicyError(
      toolId,
      'insecure_url',
      `tool \`${toolId}\`: outbound URL must be HTTPS without embedded credentials`,
    );
  }
  const allowed = ctx.toolPolicy.allowedDomains ?? [];
  if (!allowed.includes(parsed.host)) {
    throw new ToolPolicyError(
      toolId,
      'domain_not_allowed',
      `tool \`${toolId}\`: host not in the allowedDomains allowlist`,
    );
  }
  // The SSRF range-block (private/loopback/link-local/metadata) + connect-pinning is the host egress
  // capability's job (the one shared primitive, 1.AE) — never re-implemented in the pure engine.
}

/**
 * A minimal glob: `*` (any run, incl. empty) and `?` (exactly one char); everything else is literal;
 * full-string match. Implemented as a **linear-time** iterative matcher with a single backtrack point
 * for the last `*` — NOT a compiled RegExp. A RegExp translation (`a*a*a*…`) backtracks catastrophically
 * (ReDoS) on an author-supplied pathological glob; this matcher is O(len(value) × len(glob)) worst case,
 * with no exponential blowup. (`allowedCommandGlobs` is opt-in and author-controlled, but a community /
 * imported workflow is a real threat surface — see ADR-0029.)
 */
function globMatch(glob: string, value: string): boolean {
  let g = 0; // index into glob
  let v = 0; // index into value
  let star = -1; // glob index just past the last `*` seen, or -1
  let mark = 0; // value index to resume from when backtracking the last `*`
  while (v < value.length) {
    const gc = glob[g];
    if (gc === '?' || (gc !== undefined && gc !== '*' && gc === value[v])) {
      g++;
      v++;
    } else if (gc === '*') {
      star = ++g; // `*` matches zero chars first; remember where to extend it
      mark = v;
    } else if (star >= 0) {
      g = star; // mismatch — let the last `*` swallow one more char of value
      v = ++mark;
    } else {
      return false;
    }
  }
  while (glob[g] === '*') {
    g++; // trailing `*`s match the empty remainder
  }
  return g === glob.length;
}

/* ------------------------------------------------------------------------------------------------ *
 * Step 6 — output_mapping (full result → workflow-state projection).
 * ------------------------------------------------------------------------------------------------ */

function applyOutputMapping(
  full: unknown,
  mapping: Readonly<Record<string, string>> | undefined,
): unknown {
  if (mapping === undefined) {
    return full;
  }
  const out: Record<string, unknown> = {};
  for (const [stateKey, path] of Object.entries(mapping)) {
    if (UNSAFE_ARG_KEYS.has(stateKey)) {
      continue; // a `__proto__` stateKey would mutate `out`'s prototype, not add an own property
    }
    out[stateKey] = readPath(full, path);
  }
  return out;
}

/**
 * Read a simple dot-path (`a.b.c`) from a value; undefined when any segment is absent. Walks ONLY own
 * data properties (`Object.hasOwn`) — a segment naming an inherited member (`__proto__`, `constructor`,
 * `toString`) returns undefined, never the prototype/constructor function. Mirrors the hardened
 * `interpolation/path.ts` reader; do not regress to a bare `cursor[segment]`.
 */
function readPath(value: unknown, path: string): unknown {
  if (path === '') {
    return value;
  }
  let cursor = value;
  for (const segment of path.split('.')) {
    if (!isRecord(cursor) || !Object.hasOwn(cursor, segment)) {
      return undefined;
    }
    cursor = cursor[segment];
  }
  return cursor;
}

/* ------------------------------------------------------------------------------------------------ *
 * Step 8 — event-input sanitization (config-only + secret-tainted keys removed). The bus does final
 * generic masking (ADR-0036); this strips the tool-aware sensitive fields only the registry knows.
 * ------------------------------------------------------------------------------------------------ */

function sanitizeInput(
  def: ToolDef,
  effective: Record<string, unknown>,
  secretArgKeys: ReadonlySet<string> | undefined,
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...effective };
  for (const key of def.configOnlyParams ?? []) {
    delete out[key];
  }
  if (secretArgKeys !== undefined) {
    // **RECURSIVELY.** A top-level-only deletion misses `{"auth":{"api_key": …}}`, which is the ordinary
    // shape for an MCP tool whose schema this repo does not own. The shape scrub below is the second line;
    // this is the first, and it is the one that knows the host's declared secret names.
    for (const key of Object.keys(out)) {
      out[key] = dropSecretKeysDeep(out[key], secretArgKeys);
    }
    for (const key of secretArgKeys) {
      delete out[key];
    }
  }
  // Redact inline media bytes AND secret-shaped values from every surviving arg before it becomes
  // `agent:tool_call.toolInput`: that field rides the event/IPC/log/`--json` stream (an I3 boundary). The
  // `secretArgKeys` deletion above only covers KNOWN top-level key names, so a model-set credential in an
  // arbitrary place (an `http_request` `Authorization` header value, a token in the body or url query) would
  // otherwise pass through — `redactSecretShapedValue` scrubs it by shape, keeping the object keys (header
  // names) intact. Symmetric to the `outputSummary` scrub on the result side — display-only, the dispatch
  // already ran on the real args.
  //
  // **Walked ONCE over the whole object, not per key.** A per-key loop handed the walker each VALUE with
  // its key already stripped, so the key-name rule — the one that catches an opaque credential with no
  // recognisable shape — could only ever fire on NESTED members, where `Object.entries` still has the key.
  // A tool's own TOP-LEVEL secretish parameter, which is exactly what an MCP server declares freely, went
  // through untouched into both the durable digest and the event stream. A review recovered `api_key`
  // verbatim from a real dispatch.
  const walked = redactSecretShapedValue(redactInlineMedia(boundArgsForScan(out)));
  // The walk preserves plain-object shape, so this is the same record with scrubbed members; the guard is
  // a boundary check rather than a cast, and the fallback can only be reached if the walk ever stops
  // returning an object for an object input.
  return isPlainRecord(walked) ? walked : out;
}

/**
 * The ceiling on how much of a single argument string the scrub will look at.
 *
 * The result side already truncates before scrubbing (`makeSummary`); the args side did not, so every
 * effectful dispatch ran seven full-string passes over an UNCAPPED value — plausibly megabytes, via a
 * `write_file` `content` sourced from a prior large `read_file`, or an `http_request` `body`. Each pass is
 * linear (bounded quantifiers, no nesting — measured, not assumed), so this is avoidable synchronous CPU on
 * the dispatch hot path rather than a ReDoS. The cap is generous: a credential is short, and the tail of a
 * megabyte payload carries no diagnostic value the head does not.
 */
const ARG_SCAN_MAX_CHARS = 16 * 1024;

/**
 * Truncate over-long STRING leaves before the scrub walks them, so the redaction cost is bounded per
 * argument. The marker is explicit and carries the true length — a silently shortened value in a durable
 * digest would be indistinguishable from a genuinely shorter one, and telling two calls apart is the
 * digest's whole job.
 */
function boundArgsForScan(value: unknown, seen: WeakSet<object> = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    return value.length <= ARG_SCAN_MAX_CHARS
      ? value
      : `${value.slice(0, ARG_SCAN_MAX_CHARS)}…[${String(value.length)} chars total]`;
  }
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[cyclic]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => boundArgsForScan(item, seen));
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = boundArgsForScan(item, seen);
  return out;
}

/** Narrow the walk's `unknown` result back to a record, without an unsafe cast. */
function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Drop every declared secret key at ANY depth. Bounded by a `WeakSet` cycle guard, mirroring the shape walk
 * next to it — a tool's args can be an arbitrary object graph, and an MCP tool's more so.
 */
function dropSecretKeysDeep(
  value: unknown,
  secretArgKeys: ReadonlySet<string>,
  seen: WeakSet<object> = new WeakSet<object>(),
): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[cyclic]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => dropSecretKeysDeep(item, secretArgKeys, seen));
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return value; // Date/RegExp/Map/… — left for the shape walk, exactly as it leaves them
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (secretArgKeys.has(key)) continue;
    out[key] = dropSecretKeysDeep(item, secretArgKeys, seen);
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------ *
 * Cancellation + small guards.
 * ------------------------------------------------------------------------------------------------ */

function throwIfAborted(ctx: ToolDispatchContext, toolId: ToolId | undefined): void {
  if (ctx.signal?.aborted === true) {
    throw new ToolCancelledError(toolId);
  }
}

function isAbort(cause: unknown, ctx: ToolDispatchContext): boolean {
  if (ctx.signal?.aborted === true) {
    return true;
  }
  return cause instanceof Error && cause.name === 'AbortError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
