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

/** Why a strict budget check refused the prospective call. */
export type BudgetExceededReason = 'projected_over_cap' | 'unpriced_model';

/**
 * Thrown when a priced pre-egress projection exceeds a configured `on_exceed: fail` cap, or when strict-cost mode
 * refuses an unpriced prospective call. The turn/run adapter maps this to the `budget_exceeded` `ErrorCode`.
 */
export class BudgetExceededError extends Error {
  override readonly name = 'BudgetExceededError';
  constructor(
    readonly spentMicrocents: number,
    readonly limitMicrocents: number,
    /**
     * The priced post-call projection when one exists. It is deliberately absent for a strict-cap refusal of an
     * unpriced model: inventing `cap + 1` there would falsely claim that we measured a cost we explicitly could
     * not measure.
     */
    readonly projectedMicrocents: number | undefined,
    // A caller-supplied message for the case the cap fails NOT because spend exceeded it, but because it could not
    // be enforced at all — an unpriced model under `strict_cost_cap` (ADR-0071 §K7). Absent ⇒ the projection line.
    message?: string,
    readonly reason: BudgetExceededReason = projectedMicrocents === undefined
      ? 'unpriced_model'
      : 'projected_over_cap',
  ) {
    super(
      message ??
        (projectedMicrocents === undefined
          ? `pre-egress budget check failed: the cap of ${limitMicrocents} micro-cents cannot be enforced ` +
            `because the prospective call has no price (spent ${spentMicrocents})`
          : `pre-egress budget check failed: projected ${projectedMicrocents} micro-cents exceeds ` +
            `the cap of ${limitMicrocents} micro-cents (spent ${spentMicrocents})`),
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
 * One priced provider-call admission. The caller owns its lifetime: settle it with a known actual charge, retain
 * its bounded estimate when egress may have happened without trustworthy usage, or release it only when no egress
 * can be attributed. All operations are idempotent so every error path can safely close the lease exactly once.
 */
export interface BudgetAdmission {
  /** Reconcile the reserved estimate with an attempt's realized, priced charge. */
  readonly settle: (realizedMicrocents: number) => void;
  /**
   * Conservatively account for the full reservation when the provider may already have accepted/billed a call but
   * did not supply trustworthy usage. This is intentionally distinct from {@link release}: an uncertain bill must
   * never reopen capacity under a strict cap.
   */
  readonly settleAtReservedEstimate: () => void;
  /** Drop an admission that produced no attributable realized cost. Equivalent to `settle(0)`. */
  readonly release: () => void;
}

/** Internal evaluation detail: the public verdict stays compact while admission keeps the exact priced estimate. */
interface BudgetEvaluation {
  readonly result: BudgetCheckResult;
  /** Present only for a priced, bounded call; absent means there is nothing meaningful to reserve. */
  readonly estimateMicrocents?: number;
}

/** The pricing lookup is deliberately separate from the policy verdict so an already-submitted job can be restored. */
type EstimateResult =
  | { readonly kind: 'priced'; readonly estimateMicrocents: number }
  | { readonly kind: 'unpriced' };

/**
 * The pre-egress budget governor (ADR-0028, 1.AC). It is stateful per run: it tracks the current
 * cumulative cost plus in-flight admissions, re-arms warn-mode notices after new realized spend, and throws a
 * typed error for `fail` / `pause_for_approval`. All cost figures are integer micro-cents.
 */
export class BudgetGovernor {
  readonly #budget: Budget;
  readonly #defaultMaxTokensEstimate: number;
  readonly #emit: (
    event: Omit<Extract<RunEventDraft, { type: 'budget:warning' }>, 'runId'>,
  ) => Promise<void>;
  readonly #overlay: PricingOverlay | undefined;
  readonly #resolveEndpoint: ((provider: ProviderId) => EndpointKind) | undefined;
  /** The durable/realized total reported by the engine or session cost stream. */
  #cumulativeCostMicrocents = 0;
  /**
   * Bounded estimates committed for attempts that may have billed but supplied no trustworthy usage. This is kept
   * separate from the durable total: an unrelated lower/older cost event must never erase an uncertain bill and
   * silently reopen strict-cap capacity.
   */
  #conservativeCostMicrocents = 0;
  #reservedCostMicrocents = 0;
  #nextAdmissionId = 0;
  readonly #reservedAdmissions = new Map<number, number>();
  // A warning is deduped while no money has changed across concurrent true attempt admissions, then re-armed by a
  // positive realized-cost update so a long-lived warn-mode session does not go permanently silent.
  #warningArmed = true;
  /** The one durable warning currently being written. Concurrent admissions await this exact promise. */
  #warningInFlight: Promise<void> | undefined;
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

  /** Update the governor with the engine's durable running cumulative cost. Conservative unknown-usage debits stay separate. */
  updateCost(cumulativeCostMicrocents: number): void {
    if (cumulativeCostMicrocents > this.#cumulativeCostMicrocents) {
      this.#warningArmed = true;
    }
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
    return this.#evaluate(model, maxTokens, mediaUnitsEstimate, provider).result;
  }

  /** Evaluate against the authoritative realized total plus every live admission, without mutating either. */
  #evaluate(
    model: string,
    maxTokens: number | undefined,
    mediaUnitsEstimate: readonly MediaUnitsEstimate[] | undefined,
    provider: ProviderId | undefined,
  ): BudgetEvaluation {
    // A cap of 0 means UNBOUNDED (`[chat].max_cost_microcents`: "0 = unbounded"): never block, and never
    // reach the `thresholdPct` division below (which would be `/0` → NaN). A workflow `BudgetSchema` forbids
    // 0 (`positiveInt`), but the governor is reused for the `[chat]`/session path where 0 is valid. This
    // short-circuit stays BEFORE any estimate (ADR-0044 §3 — no `/0`, no estimate work when unbounded).
    if (this.#budget.max_cost_microcents <= 0) {
      return { result: { kind: 'allow' } };
    }
    const estimateResult = this.#estimate(model, maxTokens, mediaUnitsEstimate, provider);
    if (estimateResult.kind === 'unpriced') {
      // An unpriced model id (a custom/self-hosted id OR a first-party catalog gap) cannot be distinguished at
      // this seam. The regular cap degrades to allow with one notice for EVERY unpriced id; strict_cost_cap blocks
      // EVERY unpriced id. The uniform policy is the only honest one when the charge cannot be estimated.
      if (this.#budget.strict_cost_cap === true) {
        return {
          result: {
            kind: 'fail',
            error: new BudgetExceededError(
              this.#cumulativeCostMicrocents,
              this.#budget.max_cost_microcents,
              undefined,
              `model '${model}' has no price, so the ${this.#budget.max_cost_microcents}-micro-cent cap cannot be enforced on it (strict_cost_cap is on). Price it with \`relavium models pricing ${model}\`, or turn strict_cost_cap off.`,
            ),
          },
        };
      }
      // The ordinary trade (ADR-0028 H4): an unpriced call cannot be bounded, but refusing it merely because a
      // price row is missing is worse when the caller did not opt into strict mode. Allow — but SAY so once.
      return { result: { kind: 'unpriced', model } };
    }
    const estimate = estimateResult.estimateMicrocents;
    // This is the admission-control invariant: a later concurrent branch sees every already-authorized worst-case
    // call, not merely the last durable `cost:updated` snapshot. There is deliberately no await between this read
    // and the ledger insertion in `checkPreEgress` below.
    const projected =
      this.#cumulativeCostMicrocents +
      this.#conservativeCostMicrocents +
      this.#reservedCostMicrocents +
      estimate;
    if (projected <= this.#budget.max_cost_microcents) {
      return { result: { kind: 'allow' }, estimateMicrocents: estimate };
    }

    const thresholdPct = clampPct(Math.round((projected / this.#budget.max_cost_microcents) * 100));

    switch (this.#budget.on_exceed) {
      case 'warn':
        return {
          result: {
            kind: 'warn',
            spentMicrocents: this.#cumulativeCostMicrocents,
            limitMicrocents: this.#budget.max_cost_microcents,
            thresholdPct,
          },
          estimateMicrocents: estimate,
        };
      case 'fail':
        return {
          result: {
            kind: 'fail',
            error: new BudgetExceededError(
              this.#cumulativeCostMicrocents,
              this.#budget.max_cost_microcents,
              projected,
            ),
          },
        };
      case 'pause_for_approval':
        return {
          result: {
            kind: 'pause',
            error: new BudgetPauseError(
              this.#cumulativeCostMicrocents,
              this.#budget.max_cost_microcents,
              thresholdPct,
            ),
          },
        };
    }
  }

  /**
   * Atomically admit one true provider attempt: price it against realized spend plus all live reservations, insert
   * its reservation before the first await, then emit a re-armable warning or throw the typed fail/pause outcome.
   * The returned admission MUST be settled, conservatively committed, or released exactly once by the attempt owner.
   */
  async checkPreEgress(
    model: string,
    maxTokens: number | undefined,
    mediaUnitsEstimate?: readonly MediaUnitsEstimate[],
    provider?: ProviderId,
  ): Promise<BudgetAdmission | undefined> {
    const evaluation = this.#evaluate(model, maxTokens, mediaUnitsEstimate, provider);
    const { result } = evaluation;
    if (result.kind === 'allow') return this.#admit(evaluation.estimateMicrocents);
    if (result.kind === 'unpriced') {
      // Once per model — a standing condition, not an event (a `loop` over an unpriced model must not repeat it
      // every iteration). The engine cannot print; the host is told and decides where the sentence goes.
      if (!this.#unpricedNotified.has(result.model)) {
        this.#unpricedNotified.add(result.model);
        // The advisory surface is not allowed to turn an explicit allow-degrade policy into a hidden block. The
        // condition remains deduped even if a host renderer/logger fails, preventing an exception storm.
        try {
          this.#onUnpriced?.(result.model, this.#budget.max_cost_microcents);
        } catch {
          // Best-effort host notice; the governed decision remains allow for non-strict unpriced models.
        }
      }
      return undefined;
    }
    if (result.kind === 'warn') {
      const admission = this.#admit(evaluation.estimateMicrocents);
      try {
        await this.#emitWarning(result);
        return admission;
      } catch (error) {
        admission?.release();
        throw error;
      }
    }
    throw result.error;
  }

  /**
   * Recreate a reservation for egress that is already irrevocably submitted (currently an async media job during
   * checkpoint resume). It intentionally bypasses cap policy and warnings: rejecting a job after its provider has
   * accepted it cannot prevent spend. Unknown prices have no meaningful reservation and preserve the normal
   * allow-degrade behavior.
   */
  reserveCommittedEgress(
    model: string,
    maxTokens: number | undefined,
    mediaUnitsEstimate?: readonly MediaUnitsEstimate[],
    provider?: ProviderId,
  ): BudgetAdmission | undefined {
    const estimate = this.#estimate(model, maxTokens, mediaUnitsEstimate, provider);
    return estimate.kind === 'priced' ? this.#admit(estimate.estimateMicrocents) : undefined;
  }

  /** Calculate a price without applying cap policy; shared by prospective admission and committed-job restoration. */
  #estimate(
    model: string,
    maxTokens: number | undefined,
    mediaUnitsEstimate: readonly MediaUnitsEstimate[] | undefined,
    provider: ProviderId | undefined,
  ): EstimateResult {
    try {
      // Token estimate + the disjoint media estimate (ADR-0044 §3). estimateMediaCost prices only the modalities
      // the model rates (a missing rate degrades to 0); an unknown model follows the uniform policy in #evaluate.
      return {
        kind: 'priced',
        estimateMicrocents:
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
            : estimateMediaCost(model, mediaUnitsEstimate, this.#overlay)),
      };
    } catch (err) {
      if (err instanceof UnknownModelError) return { kind: 'unpriced' };
      throw err;
    }
  }

  /** Insert one reservation synchronously. Zero/unpriced/unbounded evaluations intentionally carry no lease. */
  #admit(estimateMicrocents: number | undefined): BudgetAdmission | undefined {
    if (estimateMicrocents === undefined || estimateMicrocents <= 0) return undefined;
    const id = this.#nextAdmissionId++;
    this.#reservedAdmissions.set(id, estimateMicrocents);
    this.#reservedCostMicrocents += estimateMicrocents;
    let settled = false;
    const settle = (realizedMicrocents: number): void => {
      if (settled) return;
      settled = true;
      const reserved = this.#reservedAdmissions.get(id);
      if (reserved === undefined) return;
      this.#reservedAdmissions.delete(id);
      this.#reservedCostMicrocents -= reserved;
      // A cost event immediately follows on the normal path and assigns the same authoritative total. Advancing
      // here keeps admissions sound even if an event sink throws after the provider has already charged the call.
      if (realizedMicrocents > 0) {
        this.#cumulativeCostMicrocents += realizedMicrocents;
        this.#warningArmed = true;
      }
    };
    return {
      settle,
      settleAtReservedEstimate: () => {
        if (settled) return;
        settled = true;
        const reserved = this.#reservedAdmissions.get(id);
        if (reserved === undefined) return;
        this.#reservedAdmissions.delete(id);
        this.#reservedCostMicrocents -= reserved;
        this.#conservativeCostMicrocents += reserved;
        this.#warningArmed = true;
      },
      release: () => settle(0),
    };
  }

  /**
   * Emit at most once until positive realized spend re-arms the condition. A second concurrent warning admission
   * awaits the first persistence promise instead of egressing while that write could still fail; a failed write
   * re-arms the latch and makes every waiter roll its own reservation back.
   */
  #emitWarning(result: Extract<BudgetCheckResult, { kind: 'warn' }>): Promise<void> {
    const inFlight = this.#warningInFlight;
    if (inFlight !== undefined) return inFlight;
    if (!this.#warningArmed) return Promise.resolve();
    this.#warningArmed = false;
    const emitted = Promise.resolve().then(() =>
      this.#emit({
        type: 'budget:warning',
        spentMicrocents: result.spentMicrocents,
        limitMicrocents: result.limitMicrocents,
        thresholdPct: result.thresholdPct,
      }),
    );
    this.#warningInFlight = emitted;
    void emitted.then(
      () => {
        if (this.#warningInFlight === emitted) this.#warningInFlight = undefined;
      },
      () => {
        if (this.#warningInFlight === emitted) {
          this.#warningInFlight = undefined;
          this.#warningArmed = true;
        }
      },
    );
    return emitted;
  }
}

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}
