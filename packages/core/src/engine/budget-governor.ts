import {
  estimateMaxNextCost,
  estimateMediaCost,
  UnknownModelError,
  type MediaUnitsEstimate,
  type PricingOverlay,
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
  ) {
    super(
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
  #cumulativeCostMicrocents = 0;
  #warningEmitted = false;

  constructor(params: {
    readonly budget: Budget;
    readonly defaultMaxTokensEstimate?: number;
    readonly emit: (
      event: Omit<Extract<RunEventDraft, { type: 'budget:warning' }>, 'runId'>,
    ) => Promise<void>;
    /** The user-pricing overlay (2.5.G S10) — makes the PRE-EGRESS estimate price a user-priced model that the
     *  static registry lacks, so `max_cost_microcents` enforces it (the cap-gap fix). Absent ⇒ static-only. */
    readonly resolvePrice?: PricingOverlay;
  }) {
    this.#budget = params.budget;
    this.#defaultMaxTokensEstimate = params.defaultMaxTokensEstimate ?? DEFAULT_MAX_TOKENS_ESTIMATE;
    this.#emit = params.emit;
    this.#overlay = params.resolvePrice;
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
        estimateMaxNextCost(model, maxTokens ?? this.#defaultMaxTokensEstimate, this.#overlay) +
        (mediaUnitsEstimate === undefined
          ? 0
          : estimateMediaCost(model, mediaUnitsEstimate, this.#overlay));
    } catch (err) {
      // An unpriced model (e.g. a custom base-URL / self-hosted id with no pricing row) throws
      // UnknownModelError. The pre-egress governor must NOT hard-fail an otherwise-valid run on it —
      // degrade to `allow`, mirroring the FallbackChain's "unpriced ⇒ no-cost" policy (H4). A self-hosted
      // model has ~no metered cost, so the cap simply does not constrain it. Any other error is a real bug.
      if (err instanceof UnknownModelError) {
        return { kind: 'allow' };
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
  ): Promise<void> {
    const result = this.evaluatePreEgress(model, maxTokens, mediaUnitsEstimate);
    if (result.kind === 'allow') return;
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
