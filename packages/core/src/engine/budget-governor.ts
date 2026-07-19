import {
  estimateMaxNextCost,
  estimateMediaCost,
  UnknownModelError,
  type EndpointKind,
  type MediaUnitsEstimate,
  type PricingOverlay,
  type ProviderId,
} from '@relavium/llm';
import type { Budget } from '@relavium/shared';

import type { RunEventDraft } from './event-bus.js';
import type { GateRequest } from './node-executor.js';

/**
 * Default per-call output-token estimate used by the pre-egress budget governor when neither the
 * node/session nor the host config supplies `max_tokens_estimate` (ADR-0028). The canonical value
 * is deliberately conservative: it is a safety rail, not a performance target.
 */
export const DEFAULT_MAX_TOKENS_ESTIMATE = 4096;

/**
 * Thrown when a pre-egress check would exceed the configured cost cap and `on_exceed: fail` is set.
 * The turn/run adapter maps this to the `budget_exceeded` `ErrorCode`.
 */
export class BudgetExceededError extends Error {
  override readonly name = 'BudgetExceededError';
  constructor(
    readonly spentMicrocents: number,
    readonly limitMicrocents: number,
    readonly projectedMicrocents: number,
    // A caller-supplied message for the case the cap fails NOT because spend exceeded it, but because it could not
    // be enforced at all — an unpriced model under `strict_cost_cap` (ADR-0071 §K7). Absent ⇒ the projection line.
    message?: string,
  ) {
    super(
      message ??
        `pre-egress budget check failed: projected ${projectedMicrocents} micro-cents exceeds ` +
          `the cap of ${limitMicrocents} micro-cents (spent ${spentMicrocents})`,
    );
  }
}

/**
 * Thrown when a pre-egress check would exceed the configured cost cap and
 * `on_exceed: pause_for_approval` is set. The agent runner maps this to a `paused` node outcome
 * (reusing the human-gate seam) so the run can be resumed via `engine.resume(runId, gateId, decision)`.
 */
export class BudgetPauseError extends Error {
  override readonly name = 'BudgetPauseError';
  constructor(
    readonly spentMicrocents: number,
    readonly limitMicrocents: number,
    readonly thresholdPct: number,
  ) {
    super(
      `pre-egress budget check would exceed the cap of ${limitMicrocents} micro-cents ` +
        `(spent ${spentMicrocents}); run paused for approval`,
    );
  }

  /**
   * Build a `GateRequest` the engine can park like a human gate. The engine assigns the stable
   * `gateId` when it persists `budget:paused`.
   */
  toGateRequest(): GateRequest {
    return {
      gateType: 'approval',
      message:
        `This agent step's next LLM call would push the run past its budget cap of ${this.limitMicrocents} ` +
        `micro-cents (already spent ${this.spentMicrocents}). Approve to let the step run to completion past ` +
        `the cap; reject to fail the run with budget_exceeded.`,
      spentMicrocents: this.spentMicrocents,
      limitMicrocents: this.limitMicrocents,
      isBudgetGate: true,
    };
  }
}

/** What the governor decided at a pre-egress check. */
export type BudgetCheckResult =
  | { readonly kind: 'allow' }
  | {
      readonly kind: 'warn';
      readonly spentMicrocents: number;
      readonly limitMicrocents: number;
      readonly thresholdPct: number;
    }
  /**
   * The turn is ALLOWED, but the model has no price, so the cap could not be applied to it (ADR-0071 §K7). Carried
   * — not swallowed — so the surface can say so once: a cost cap that silently does not apply is a false sense of
   * safety, and the user who set one deserves to know which model slipped past it.
   */
  | { readonly kind: 'unpriced'; readonly model: string }
  | { readonly kind: 'fail'; readonly error: BudgetExceededError }
  | { readonly kind: 'pause'; readonly error: BudgetPauseError };

/**
 * The pre-egress budget governor (ADR-0028, 1.AC). It is stateful per run: it tracks the current
 * cumulative cost, emits at most one `budget:warning` event per run, and throws a typed error for
 * `fail` / `pause_for_approval`. All cost figures are integer micro-cents.
 */
export class BudgetGovernor {
  readonly #budget: Budget;
  readonly #defaultMaxTokensEstimate: number;
  readonly #emit: (
    event: Omit<Extract<RunEventDraft, { type: 'budget:warning' }>, 'runId'>,
  ) => Promise<void>;
  readonly #overlay: PricingOverlay | undefined;
  readonly #resolveEndpoint: ((provider: ProviderId) => EndpointKind) | undefined;
  #cumulativeCostMicrocents = 0;
  #warningEmitted = false;
  readonly #onUnpriced: ((model: string, capMicrocents: number) => void) | undefined;
  readonly #unpricedNotified = new Set<string>(); // once per model — a standing condition, not a per-turn event

  constructor(params: {
    readonly budget: Budget;
    readonly defaultMaxTokensEstimate?: number;
    readonly emit: (
      event: Omit<Extract<RunEventDraft, { type: 'budget:warning' }>, 'runId'>,
    ) => Promise<void>;
    /** The user-pricing overlay (2.5.G S10) — makes the PRE-EGRESS estimate price a user-priced model that the
     *  static registry lacks, so `max_cost_microcents` enforces it (the cap-gap fix). Absent ⇒ static-only. */
    readonly resolvePrice?: PricingOverlay;
    /**
     * Is this model's provider on its OWN API, or behind a custom `base_url`
     * ([ADR-0071](../../../../docs/decisions/0071-models-dev-as-the-model-metadata-source.md) §7)?
     *
     * The adapter clamps an authored `max_tokens` to the model's published ceiling on an official endpoint, and
     * deliberately does NOT on a custom one (a gateway may serve anything under a familiar id). The estimate has to
     * make the SAME call, or it stops describing the request: assume `official` on a gateway and the estimate lands
     * BELOW what the wire can spend, so the governor under-authorizes and waves through a call it should have
     * stopped. The engine cannot know a base URL — the host injects the answer, exactly as it injects the price.
     *
     * Absent ⇒ every model is treated as official, which is the adapter's own default for an un-overridden endpoint.
     *
     * Keyed on the ROUTING PROVIDER, not the model: a custom gateway serving another provider's model id is
     * `custom` at the wire yet `official` by the model's catalog provider, and estimating from the catalog
     * provider under-authorizes the turn (review M2). The provider rides the pre-egress info per attempt.
     */
    readonly resolveEndpoint?: (provider: ProviderId) => EndpointKind;
    /**
     * Called when a turn runs on a model we cannot PRICE, so the cap could not apply to it (ADR-0071 §K7). Fired
     * once per model. The engine cannot print; the host routes the notice (chat → the transcript, `run` → stderr).
     * Absent ⇒ silent, and `strict_cost_cap` (which BLOCKS instead) is the loud alternative for anyone who wants it.
     */
    readonly onUnpriced?: (model: string, capMicrocents: number) => void;
  }) {
    this.#budget = params.budget;
    this.#defaultMaxTokensEstimate = params.defaultMaxTokensEstimate ?? DEFAULT_MAX_TOKENS_ESTIMATE;
    this.#emit = params.emit;
    this.#overlay = params.resolvePrice;
    this.#onUnpriced = params.onUnpriced;
    this.#resolveEndpoint = params.resolveEndpoint;
  }

  /** Update the governor with the engine's authoritative running cumulative cost. */
  updateCost(cumulativeCostMicrocents: number): void {
    this.#cumulativeCostMicrocents = cumulativeCostMicrocents;
  }

  /**
   * Evaluate one prospective LLM call. Returns a result description (synchronous, no side effects);
   * callers apply the action by throwing the supplied error or, for `warn`, emitting the event.
   * `mediaUnitsEstimate` (1.AF/D17) adds a disjoint per-modality media addend to the projection.
   */
  evaluatePreEgress(
    model: string,
    maxTokens: number | undefined,
    mediaUnitsEstimate?: readonly MediaUnitsEstimate[],
    provider?: ProviderId,
  ): BudgetCheckResult {
    // A cap of 0 means UNBOUNDED (`[chat].max_cost_microcents`: "0 = unbounded"): never block, and never
    // reach the `thresholdPct` division below (which would be `/0` → NaN). A workflow `BudgetSchema` forbids
    // 0 (`positiveInt`), but the governor is reused for the `[chat]`/session path where 0 is valid. This
    // short-circuit stays BEFORE any estimate (ADR-0044 §3 — no `/0`, no estimate work when unbounded).
    if (this.#budget.max_cost_microcents <= 0) {
      return { kind: 'allow' };
    }
    let estimate: number;
    try {
      // Token estimate + the disjoint media estimate (ADR-0044 §3). estimateMediaCost prices only the
      // modalities the model rates (a missing rate degrades to 0); both share the UnknownModelError
      // degrade-to-allow below, so an unpriced model never hard-fails the run.
      estimate =
        estimateMaxNextCost(
          model,
          maxTokens ?? this.#defaultMaxTokensEstimate,
          this.#overlay,
          // Key the endpoint on the routing provider (review M2). A media-only gate omits it (`maxTokens: 0`
          // makes the token estimate 0 regardless), so `official` is a harmless default there.
          (provider === undefined ? undefined : this.#resolveEndpoint?.(provider)) ?? 'official',
        ) +
        (mediaUnitsEstimate === undefined
          ? 0
          : estimateMediaCost(model, mediaUnitsEstimate, this.#overlay));
    } catch (err) {
      // An unpriced model (e.g. a custom base-URL / self-hosted id with no pricing row) throws
      // UnknownModelError. The pre-egress governor must NOT hard-fail an otherwise-valid run on it —
      // degrade to `allow`, mirroring the FallbackChain's "unpriced ⇒ no-cost" policy (H4). A self-hosted
      // model has ~no metered cost, so the cap simply does not constrain it. Any other error is a real bug.
      if (err instanceof UnknownModelError) {
        // A model with no price. The cap CANNOT bound it — we do not know what a turn costs. Two ways to treat that:
        if (this.#budget.strict_cost_cap === true) {
          // The user asked for a hard cap. If we cannot price it, we do not run it — that is what "strict" means.
          return {
            kind: 'fail',
            error: new BudgetExceededError(
              this.#cumulativeCostMicrocents,
              this.#budget.max_cost_microcents,
              this.#cumulativeCostMicrocents,
              `model '${model}' has no price, so the ${this.#budget.max_cost_microcents}-micro-cent cap cannot be enforced on it (strict_cost_cap is on). Price it with \`relavium models pricing ${model}\`, or turn strict_cost_cap off.`,
            ),
          };
        }
        // The ordinary trade (ADR-0028 H4): a self-hosted model has ~no metered cost, and refusing an otherwise
        // valid run over a missing price is worse than the small risk. Allow — but SAY it is unpriced, once.
        return { kind: 'unpriced', model };
      }
      throw err;
    }
    const projected = this.#cumulativeCostMicrocents + estimate;
    if (projected <= this.#budget.max_cost_microcents) {
      return { kind: 'allow' };
    }

    const thresholdPct = clampPct(
      Math.round((this.#cumulativeCostMicrocents / this.#budget.max_cost_microcents) * 100),
    );

    switch (this.#budget.on_exceed) {
      case 'warn':
        return {
          kind: 'warn',
          spentMicrocents: this.#cumulativeCostMicrocents,
          limitMicrocents: this.#budget.max_cost_microcents,
          thresholdPct,
        };
      case 'fail':
        return {
          kind: 'fail',
          error: new BudgetExceededError(
            this.#cumulativeCostMicrocents,
            this.#budget.max_cost_microcents,
            projected,
          ),
        };
      case 'pause_for_approval':
        return {
          kind: 'pause',
          error: new BudgetPauseError(
            this.#cumulativeCostMicrocents,
            this.#budget.max_cost_microcents,
            thresholdPct,
          ),
        };
    }
  }

  /**
   * Apply the pre-egress check: emits a one-time `budget:warning` on the warn path, returns on allow,
   * and throws `BudgetExceededError` / `BudgetPauseError` for fail / pause. Async because the warning
   * event is durable.
   */
  async checkPreEgress(
    model: string,
    maxTokens: number | undefined,
    mediaUnitsEstimate?: readonly MediaUnitsEstimate[],
    provider?: ProviderId,
  ): Promise<void> {
    const result = this.evaluatePreEgress(model, maxTokens, mediaUnitsEstimate, provider);
    if (result.kind === 'allow') return;
    if (result.kind === 'unpriced') {
      // Once per model — a standing condition, not an event (a `loop` over an unpriced model must not repeat it
      // every iteration). The engine cannot print; the host is told and decides where the sentence goes.
      if (!this.#unpricedNotified.has(result.model)) {
        this.#unpricedNotified.add(result.model);
        this.#onUnpriced?.(result.model, this.#budget.max_cost_microcents);
      }
      return;
    }
    if (result.kind === 'warn') {
      if (!this.#warningEmitted) {
        this.#warningEmitted = true;
        await this.#emit({
          type: 'budget:warning',
          spentMicrocents: result.spentMicrocents,
          limitMicrocents: result.limitMicrocents,
          thresholdPct: result.thresholdPct,
        });
      }
      return;
    }
    throw result.error;
  }
}

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}
