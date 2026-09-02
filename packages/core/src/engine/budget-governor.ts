import {
  estimateMaxNextCost,
  estimateMediaCost,
  UnknownModelError,
  type EndpointKind,
  type MediaUnitsEstimate,
  type PricingOverlay,
  type ProviderId,
} from '@relavium/llm';
import type { Budget, MediaBilledModality } from '@relavium/shared';

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
  /**
   * The stable discriminant (D10). Callers narrow on `.code`, never on `.name` or `.message` — and never on
   * `instanceof` across a bundle seam, where two realizations of the class can coexist and silently answer
   * `false`. Adopted ahead of Wave 3's `RelaviumError` migration, which this shape has to slot into.
   */
  readonly code = 'budget_exceeded' as const;
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
  /** The stable discriminant (D10) — see {@link BudgetExceededError.code}. */
  readonly code = 'budget_paused' as const;
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
  /**
   * The MODEL has no price at all (ADR-0071 §K7). A partial gap — a priced model with an unrated modality —
   * is deliberately NOT this verdict: it carries a real allow/warn/fail result and reports the gap out of band
   * on {@link BudgetEvaluation.unpricedModalities}, because the cap still applies to the token side
   * ([ADR-0089](../../../../docs/decisions/0089-media-correctness-four-boundaries.md) §4).
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
  readonly settleAtReservedEstimate: (origin?: CommitmentOrigin) => void;
  /** Drop an admission that produced no attributable realized cost. Equivalent to `settle(0)`. */
  readonly release: () => void;
  /**
   * The exact priced amount this admission reserved — the number ADR-0074 §3 freezes onto
   * `media_job:submitted.acceptedCostMicrocents` at submit time.
   *
   * Without it the resume path had to RE-PRICE an already-accepted job, so a user-price or catalog change between
   * submission and resume silently rewrote a commitment the provider had already accepted.
   *
   * Optional so the many hand-built `{ settle, settleAtReservedEstimate, release }` doubles in the test suite stay
   * constructible; every admission the governor actually issues carries it.
   */
  readonly reservedMicrocents?: number;
}

/** Internal evaluation detail: the public verdict stays compact while admission keeps the exact priced estimate. */
interface BudgetEvaluation {
  readonly result: BudgetCheckResult;
  /** Present only for a priced, bounded call; absent means there is nothing meaningful to reserve. */
  readonly estimateMicrocents?: number;
  /**
   * A PARTIAL pricing gap: the model is priced, the cap still applies to the token side, and one or more
   * media modalities are missing a rate (ADR-0089 §4). Distinct from `result.kind === 'unpriced'`, which
   * means nothing could be priced — here the verdict is a real allow/warn/fail and this rides alongside it,
   * so the cap is still enforced on what IS priceable rather than abandoned wholesale.
   */
  readonly unpricedModalities?: readonly MediaBilledModality[];
}

/** The pricing lookup is deliberately separate from the policy verdict so an already-submitted job can be restored. */
type EstimateResult =
  | {
      readonly kind: 'priced';
      readonly estimateMicrocents: number;
      /** Billed modalities with requested volume and no rate — the figure above excludes their charge. */
      readonly unpricedModalities: readonly MediaBilledModality[];
    }
  | { readonly kind: 'unpriced' };

/**
 * Narrow a thrown value to {@link BudgetExceededError} by its `code` (D10).
 *
 * `instanceof` is correct INSIDE `packages/core`, where there is one realization of the class. It is not safe for
 * a surface: the CLI bundles the engine into one file while its tests import the package directly, so two
 * realizations can coexist and `instanceof` silently answers `false` at exactly the boundary that has to catch it.
 * Same hazard, same shape as `isCorruptRunEventError` in `@relavium/db`.
 */
export function isBudgetExceededError(value: unknown): value is BudgetExceededError {
  // The `code` alone is NOT enough. `AgentTurnError` carries `readonly code: ErrorCode`, and the taxonomy
  // contains `'budget_exceeded'` — so a code-only guard admits it and then hands the caller `spentMicrocents` /
  // `limitMicrocents` typed `number` but actually `undefined`, printing "spent undefined of undefined" through a
  // guard whose whole promise is safety. So also require a field only THIS class has.
  return (
    value instanceof Error &&
    'code' in value &&
    value.code === 'budget_exceeded' &&
    'limitMicrocents' in value &&
    typeof value.limitMicrocents === 'number'
  );
}

/** Narrow a thrown value to {@link BudgetPauseError} by its `code` — see {@link isBudgetExceededError}. */
export function isBudgetPauseError(value: unknown): value is BudgetPauseError {
  // Same structural check as {@link isBudgetExceededError}. No class collides on `'budget_paused'` today, but
  // relying on that is relying on nobody ever adding one — and the sibling guard already proved how that ends.
  return (
    value instanceof Error &&
    'code' in value &&
    value.code === 'budget_paused' &&
    'thresholdPct' in value &&
    typeof value.thresholdPct === 'number'
  );
}

/**
 * A conservative commitment whose durable write failed (ADR-0074 §2).
 *
 * Typed rather than a re-thrown `unknown`, so the engine and a host can narrow on it instead of on a message, and
 * so the original rejection survives as `cause` for a log. The reservation it describes is deliberately STILL
 * consuming cap capacity when this throws — §2: "a persistence failure never releases capacity; it fails the
 * active owner loudly while preserving the conservative reservation in memory for the terminal path."
 */
export class CommitmentDurabilityError extends Error {
  override readonly name = 'CommitmentDurabilityError';
  readonly code = 'commitment_not_durable' as const;

  constructor(
    cause: unknown,
    /**
     * The node whose commitment failed to persist — NOT whichever node happens to reach a barrier first. Under a
     * `fan_out` both branches await the same chain link, so without this the run blamed the first branch to
     * flush, which may have made no commitment at all.
     */
    readonly nodeId?: string,
  ) {
    super('a conservative budget commitment could not be made durable', { cause });
  }
}

/**
 * What the governor may emit, envelope-less — the host attaches the correlation key.
 *
 * `budget:warning` is a streamed advisory; `budget:estimate_committed` MUST be durable (ADR-0074 §2 — surviving a
 * crash is the whole reason it exists), which is why the governor has its own emit hook rather than routing
 * through the node executor's streamed `params.emit`.
 */
type WithoutRunId<T> = T extends unknown ? Omit<T, 'runId'> : never;
export type GovernorEventDraft = WithoutRunId<
  // DISTRIBUTIVE: a bare `Omit` over a union collapses it to the shared keys, silently losing `model` /
  // `spentMicrocents` and turning both drafts into the same near-empty shape.
  Extract<RunEventDraft, { type: 'budget:warning' | 'budget:estimate_committed' }>
>;

/**
 * Who owned the attempt a commitment is made for. The governor prices calls but does not know the graph, so the
 * caller supplies the identity that goes on the durable event; the model comes from the admission itself.
 */
export interface CommitmentOrigin {
  /**
   * The agent node that owned the attempt — and on a SESSION turn the agent ref, which is what the turn core
   * carries as its `nodeId` there. That matches `cost:updated`, which does the same, so a consumer can attribute
   * both realized and conservative money the same way on both surfaces. Optional because the field is optional
   * on the event; every current caller supplies it.
   */
  readonly nodeId?: string;
  /** 1-based within-chain attempt, matching `cost:updated` — see the event's schema doc. */
  readonly attemptNumber?: number;
}

/**
 * The pre-egress budget governor (ADR-0028, 1.AC). It is stateful per run: it tracks the current
 * cumulative cost plus in-flight admissions, re-arms warn-mode notices after new realized spend, and throws a
 * typed error for `fail` / `pause_for_approval`. All cost figures are integer micro-cents.
 */
export class BudgetGovernor {
  readonly #budget: Budget;
  readonly #defaultMaxTokensEstimate: number;
  readonly #emit: (event: GovernorEventDraft) => Promise<void>;
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
  /**
   * The durability barrier for conservative commitments (ADR-0074 §2).
   *
   * The ledger mutation is SYNCHRONOUS — `settleAtReservedEstimate` is called from inside the fallback chain's
   * `onAttempt` callback, which cannot await — but "the next provider attempt and the enclosing turn completion
   * wait for the commitment's durability acknowledgement". So the emit is chained here and awaited at exactly
   * those two points: {@link checkPreEgress} before it admits anything else, and {@link flushCommitments} at the
   * turn/run boundary. Chaining (rather than keeping a set) also serializes the writes, so two commitments in the
   * same tick cannot interleave their persists.
   */
  #commitmentsInFlight: Promise<void> = Promise.resolve();
  /**
   * How many commitment writes are outstanding — so the barrier costs NOTHING when there is nothing to wait for.
   *
   * `await`ing an already-resolved promise still burns a microtask, and `checkPreEgress` is the hot pre-egress
   * path taken by every attempt. Worse than the cost: an unconditional await changes the observable interleaving
   * of concurrent admissions, which the warning latch's own tests legitimately pin. So the barrier is entered only
   * when a commitment is actually in flight or a prior write failed.
   */
  #pendingCommitments = 0;
  /**
   * A commitment whose durable write FAILED, retained until someone awaits the barrier.
   *
   * §2: "A persistence failure never releases capacity; it fails the active owner loudly while preserving the
   * conservative reservation in memory for the terminal path." Both halves matter. The in-memory
   * `#conservativeCostMicrocents` is already incremented and is deliberately NOT rolled back — the provider may
   * have billed, so the cap must stay closed for the rest of this process. And the failure is not swallowed: it
   * is re-thrown at the next barrier, so the owner learns that its money record is not durable rather than
   * continuing to spend against a cap whose state will not survive a crash. Nobody awaits the emit at the call
   * site, so without this the rejection would be unhandled.
   */
  #commitmentFailure: CommitmentDurabilityError | undefined;
  /**
   * STICKY: this owner's conservative-money record has failed to persist at least once.
   *
   * Deliberately NOT a barrier input — `#pendingCommitments` and the unsurfaced `#commitmentFailure` already
   * decide when to wait, and making a past failure block every later turn would be harsher than §2 asks for (the
   * safety property, capacity preserved in memory, holds regardless).
   *
   * What it is for: `#commitmentFailure` is surfaced ONCE, so after that nothing remembers. A long-lived owner —
   * a chat session — then renders its conservative amount as if it were safely recorded, when in fact a crash
   * would lose it. §1 requires a surface to show that amount; this is how the surface knows to qualify it. Read
   * via {@link conservativeDurabilityBroken}.
   */
  #durabilityBroken = false;
  /**
   * Nodes with a resumed media job whose money basis is UNKNOWN — a row written before ADR-0074 §3 froze it.
   *
   * §3: "With a configured cap, a resumed legacy pending job is treated fail-closed for new egress until it
   * settles; it is never silently under-reserved from a newer, cheaper price." The hazard is specific: the only
   * reservation we can make for such a job is a re-price from TODAY's catalog, and if the price dropped, that
   * reserves less than the provider will actually bill — so the cap would admit new spend against headroom that
   * does not exist. Refusing new egress until the job settles is the only honest answer, because when it settles
   * the realized charge replaces the guess and the uncertainty is gone.
   *
   * Cleared per node by {@link clearLegacyMediaJob}. Empty in every run that has no pre-§3 rows, which is every
   * run started after §3 ships — so this costs nothing on the normal path.
   */
  readonly #legacyMediaJobNodes = new Map<string, { promise: Promise<void>; settle: () => void }>();
  #reservedCostMicrocents = 0;
  #nextAdmissionId = 0;
  readonly #reservedAdmissions = new Map<number, number>();
  // A warning is deduped while no money has changed across concurrent true attempt admissions, then re-armed by a
  // positive realized-cost update so a long-lived warn-mode session does not go permanently silent.
  #warningArmed = true;
  /** The one durable warning currently being written. Concurrent admissions await this exact promise. */
  #warningInFlight: Promise<void> | undefined;
  readonly #onUnpriced:
    | ((
        model: string,
        capMicrocents: number,
        modalities?: readonly MediaBilledModality[],
      ) => void)
    | undefined;
  /** `${model}\0${modality}` keys already announced — see {@link BudgetGovernor.#noticeUnpricedModalities}. */
  readonly #unpricedModalityNotified = new Set<string>();
  readonly #onLegacyMediaJobHold: ((nodeIds: readonly string[]) => void) | undefined;
  readonly #unpricedNotified = new Set<string>(); // once per model — a standing condition, not a per-turn event

  constructor(params: {
    readonly budget: Budget;
    readonly defaultMaxTokensEstimate?: number;
    readonly emit: (event: GovernorEventDraft) => Promise<void>;
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
    readonly onUnpriced?: (
      model: string,
      capMicrocents: number,
      /** Present ⇒ the MODEL is priced and only these billed modalities are not (ADR-0089 §4). */
      modalities?: readonly MediaBilledModality[],
    ) => void;
    /**
     * New egress is being HELD while a resumed pre-§3 media job's cost basis is unknown (ADR-0074 §3).
     *
     * §3 requires the compatibility fallback be OBSERVABLE "so operators can distinguish legacy uncertainty from
     * a current priced submission". Without this the hold is silent, and a `resume` simply appears to stall with
     * no explanation — the worst possible presentation of correct behaviour. Fired ONCE per wait, not per check.
     */
    readonly onLegacyMediaJobHold?: (nodeIds: readonly string[]) => void;
  }) {
    this.#budget = params.budget;
    this.#defaultMaxTokensEstimate = params.defaultMaxTokensEstimate ?? DEFAULT_MAX_TOKENS_ESTIMATE;
    this.#emit = params.emit;
    this.#overlay = params.resolvePrice;
    this.#onUnpriced = params.onUnpriced;
    this.#onLegacyMediaJobHold = params.onLegacyMediaJobHold;
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
    // A priced MODEL with an unpriced MODALITY (ADR-0089 §4). The cap can still be enforced on the token side,
    // so this is deliberately NOT the `unpriced` verdict above — that one abandons the cap for the whole call.
    // What it shares with that case is the strict-mode answer, and for the identical reason ADR-0071 §K7 gave:
    // the charge cannot be estimated, so under `strict_cost_cap` it is refused rather than guessed at.
    //
    // Before this, the media estimate contributed 0 for such a modality and the call sailed through a strict cap
    // as though it were free — which is `CR-55`, and the reason the token path and the media path disagreed
    // about what a strict cap means.
    if (estimateResult.unpricedModalities.length > 0 && this.#budget.strict_cost_cap === true) {
      const sorted = [...estimateResult.unpricedModalities].sort();
      const named = sorted.join(', ');
      // Canonical billed units (ADR-0044 §3): an image per image, audio and video per second.
      const flags = sorted
        .map((m) => (m === 'image' ? '--image <usd-per-image>' : `--${m} <usd-per-second>`))
        .join(' ');
      return {
        result: {
          kind: 'fail',
          error: new BudgetExceededError(
            this.#cumulativeCostMicrocents,
            this.#budget.max_cost_microcents,
            undefined,
            // The remedy must be a command that RUNS. `relavium models pricing <model>` alone exits 2 on a
            // missing `--provider`, and the flags that actually add a media rate are `--image`/`--audio`/
            // `--video` — naming the bare command trains a user to give up and disable the cap instead, which
            // is the failure ADR-0089 §4(c) exists to prevent.
            `model '${model}' has no ${named} rate, so the ${this.#budget.max_cost_microcents}-micro-cent cap cannot be enforced on this generation (strict_cost_cap is on). Add one with \`relavium models pricing ${model} --provider <p> ${flags}\`, or turn strict_cost_cap off.`,
          ),
        },
      };
    }
    const estimate = estimateResult.estimateMicrocents;
    // Non-strict, and a modality had no rate: the verdict below is a REAL allow/warn/fail against the priced
    // part, and the gap rides beside it so `checkPreEgress` can say so once. Attaching it to every arm rather
    // than only to `allow` is deliberate — a call that trips the cap on its token side is still a call whose
    // media charge we could not see, and the user is owed that sentence whichever way the verdict went.
    const gap: Pick<BudgetEvaluation, 'unpricedModalities'> =
      estimateResult.unpricedModalities.length === 0
        ? {}
        : { unpricedModalities: estimateResult.unpricedModalities };
    // This is the admission-control invariant: a later concurrent branch sees every already-authorized worst-case
    // call, not merely the last durable `cost:updated` snapshot. There is deliberately no await between this read
    // and the ledger insertion in `checkPreEgress` below.
    const projected =
      this.#cumulativeCostMicrocents +
      this.#conservativeCostMicrocents +
      this.#reservedCostMicrocents +
      estimate;
    if (projected <= this.#budget.max_cost_microcents) {
      return { result: { kind: 'allow' }, estimateMicrocents: estimate, ...gap };
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
          ...gap,
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
          ...gap,
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
          ...gap,
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
    // ADR-0074 §2's barrier: the NEXT provider attempt waits for any prior commitment's durability. Before this
    // point a crash between a possibly-billable call and its durable record would reopen the cap; awaiting here is
    // what closes that window, and it throws if the write failed rather than admitting more spend against a cap
    // whose state will not survive. It runs BEFORE `#evaluate` so the projection also sees the settled ledger —
    // and deliberately not between `#evaluate` and `#admit`, where an await would break admission control.
    // Guarded so the common case (nothing outstanding) pays no microtask at all; see `#pendingCommitments`.
    if (this.#pendingCommitments > 0 || this.#commitmentFailure !== undefined) {
      await this.flushCommitments();
    }
    // ADR-0074 §3's fail-closed hold. A resumed pre-§3 media job holds a reservation we could only obtain by
    // RE-PRICING from today's catalog; if the price fell since submission, that reserves less than the provider
    // will bill, and admitting new egress against the difference spends headroom that does not exist.
    //
    // It WAITS rather than throwing, and that distinction is the whole of §3's "until it settles". Throwing was
    // unimplementable as a hold: `budget_exceeded` is not in `RETRYABLE_ERROR_CODES` and `retry_on` is
    // schema-restricted to that same set, so no author can opt a node into retrying it — a sibling node would
    // simply die, aborting the run and abandoning the very job it was waiting for, often seconds before it
    // reported. Waiting is bounded without any timer of our own: the job's `deadlineAt` already fails it through
    // the poll loop, and every exit route resolves this promise (run teardown included, or a waiter would hang).
    //
    // §3 scopes this to "with a configured cap", and no extra condition is needed: the engine constructs a
    // governor ONLY when the workflow declares a budget, and `Budget` requires `max_cost_microcents`. Reaching
    // this line already means a cap exists — a run without one has no governor to hold anything, which is right,
    // since there is no headroom to misjudge.
    if (this.#legacyMediaJobNodes.size > 0) {
      // Announce BEFORE the first await, once per wait — §3's observability clause. A silent hold presents
      // correct behaviour as an unexplained stall. Best-effort: a misbehaving notice sink must never turn a
      // budget check into a failure, which is the same posture `onUnpriced` takes below.
      //
      // NOT deduped, unlike `onUnpriced` — deliberately, and the asymmetry is the point. Unpriced is a
      // STANDING CONDITION of a model, so repeating it every loop iteration would be noise. A hold is an
      // EVENT against one attempted egress: each blocked attempt is a distinct thing the user is waiting on,
      // and silently dropping the second one would leave a sibling stalled with no explanation — the exact
      // failure §3 exists to prevent. Bounded in practice by the job's own `deadlineAt`, and the CLI's
      // renderer bounds the id list it prints.
      try {
        this.#onLegacyMediaJobHold?.([...this.#legacyMediaJobNodes.keys()]);
      } catch {
        // The notice is advisory; it cannot block or fail the check.
      }
    }
    while (this.#legacyMediaJobNodes.size > 0) {
      // Re-checked in a loop: a second legacy job can register while we await the first.
      await Promise.all([...this.#legacyMediaJobNodes.values()].map((e) => e.promise));
    }
    const evaluation = this.#evaluate(model, maxTokens, mediaUnitsEstimate, provider);
    const { result } = evaluation;
    // A partial pricing gap (ADR-0089 §4): the verdict below stands on its own — the cap WAS applied to the
    // priced part — and this only adds the sentence the user is owed. Announced before the verdict is acted on,
    // because a `fail` arm throws and would otherwise swallow it. Deduped per (model, modality) for the same
    // reason the unpriced-model notice is deduped: it is a standing condition of the model, not an event.
    if (evaluation.unpricedModalities !== undefined) {
      this.#noticeUnpricedModalities(model, evaluation.unpricedModalities);
    }
    if (result.kind === 'allow') return this.#admit(model, evaluation.estimateMicrocents);
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
      const admission = this.#admit(model, evaluation.estimateMicrocents);
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
   * Chain one commitment's durable write onto the barrier. Never awaited HERE — the caller is a synchronous chain
   * callback — so a rejection is captured rather than left unhandled, and re-thrown at the next barrier.
   */
  #persistCommitment(
    draft: Extract<GovernorEventDraft, { type: 'budget:estimate_committed' }>,
  ): void {
    this.#pendingCommitments += 1;
    this.#commitmentsInFlight = this.#commitmentsInFlight.then(() =>
      // `Promise.resolve().then(…)`, NOT a bare `this.#emit(draft)`. A sink that throws SYNCHRONOUSLY — a
      // `better-sqlite3` write is exactly that, and §4's transactional persister write will be one — would escape
      // before `.catch`/`.finally` are attached. Then: no typed error, `#pendingCommitments` leaked at ≥1 for the
      // process, and `#commitmentsInFlight` left permanently REJECTED — so every later `checkPreEgress` throws at
      // the barrier and, because that happens before `#admit`, no new commitment can ever chain a fresh link to
      // clear it. The governor would be bricked. `#emitWarning` below already uses this shape.
      //
      // The inner chain therefore ALWAYS resolves, which is why there is no onRejected arm here: it would be dead.
      Promise.resolve()
        .then(() => this.#emit(draft))
        .catch((error: unknown) => {
          // Keep the FIRST failure: it is the one that broke durability, and later writes may well fail for the
          // same reason. The in-memory reservation stays — see `#commitmentFailure`.
          this.#commitmentFailure ??= new CommitmentDurabilityError(error, draft.nodeId);
          this.#durabilityBroken = true;
        })
        .finally(() => {
          this.#pendingCommitments -= 1;
        }),
    );
  }

  /**
   * Await every conservative commitment's durable write, then surface a failure.
   *
   * ADR-0074 §2's barrier. Called at the enclosing turn/run boundary and — critically — before the governor
   * admits the NEXT provider attempt, which is what closes the crash window between a possibly-billable call and
   * the point its money became durable. Throws the retained failure so the owner fails loudly; the conservative
   * amount is deliberately still consuming capacity when it does.
   */
  async flushCommitments(): Promise<void> {
    await this.#commitmentsInFlight;
    const failure = this.#commitmentFailure;
    if (failure !== undefined) {
      // The ERROR is surfaced once (a later flush must not re-report the same broken write as if it were new),
      // but `#durabilityBroken` stays set, so the barrier is still entered and a subsequent failure is still
      // reported. The reservation is never rolled back either way.
      this.#commitmentFailure = undefined;
      throw failure;
    }
  }

  /**
   * The durable conservative total — what a persister writes and a resume restores. Deliberately separate from
   * any realized figure: ADR-0074 §1 keeps actual and conservative money apart, and `cost:updated` /
   * `total_cost_microcents` stay realized-only.
   */
  get conservativeCostMicrocents(): number {
    return this.#conservativeCostMicrocents;
  }

  /**
   * Has any conservative commitment failed to persist for this owner? Sticky for the owner's life.
   *
   * A surface rendering the committed amount (§1) uses this to qualify it: the cap is still being enforced in this
   * process, but the record would not survive a crash. The one-shot error tells the owner once; this is what is
   * left afterwards.
   */
  get conservativeDurabilityBroken(): boolean {
    return this.#durabilityBroken;
  }

  /**
   * Seed the conservative total when rehydrating (checkpoint resume, `chat-resume`).
   *
   * Takes the MAXIMUM, which cannot express §1's future DECREASE. So once `budget:estimate_released` lands, the
   * caller must compute "sum less releases" and pass the RESULT — a two-step `restore(sum)` then
   * `restore(sum - released)` silently keeps the higher value.
   *
   * ADR-0074 §2 requires both totals restored BEFORE resumed work is scheduled — otherwise the first post-resume
   * pre-egress check projects against a cap that has forgotten money the provider may already have billed. Takes
   * the MAXIMUM rather than assigning: seeding must never lower a total this process has already accumulated, so a
   * double-restore or a restore racing a live commitment cannot reopen capacity.
   */
  restoreConservativeCost(microcents: number): void {
    // VALIDATED, because this is the one public setter on a money path. Every internal figure is integer by
    // construction (`estimateMaxNextCost`/`estimateMediaCost` both round), but a fractional value here would be
    // carried into the next commitment's `cumulativeConservativeMicrocents`, fail `nonNegativeInt` at the bus, and
    // KILL THE RUN with "a conservative budget commitment could not be made durable" — a caller's bad input
    // surfacing as a durability failure. `NaN`/negatives would fail the `>` comparison harmlessly and `Infinity`
    // would degrade to a permanent block, but relying on that is luck rather than a contract.
    if (!Number.isSafeInteger(microcents) || microcents <= 0) {
      return;
    }
    if (microcents > this.#conservativeCostMicrocents) {
      this.#conservativeCostMicrocents = microcents;
    }
  }

  /**
   * Clear the conservative total by an explicit user decision (ADR-0074 §1).
   *
   * The bound that keeps a commitment from becoming an indefinite block: "the user must be able to clear it
   * deliberately … exactly like raising the cap under `on_exceed`. What is forbidden is the system silently
   * deciding the estimate was wrong." So this is only ever called from a surface acting on a user's choice, never
   * from an engine heuristic. It re-arms the warning latch because capacity genuinely changed.
   *
   * The durable half — a `budget:estimate_released` event, so the release survives a resume instead of silently
   * returning — is RESERVED but not yet emitted (see sse-event-schema.md §Reserved). Until a surface exists to
   * make the decision, this clears the live governor only; wiring the event is that surface's commit.
   *
   * **The WORKFLOW path is not blocked while that is outstanding, and it is worth being precise about why.** A
   * resumed run does restore its conservative total, so its cap really is permanently smaller for that run — but
   * §1's escape already exists there in another form: under `on_exceed: pause_for_approval` the user approves the
   * node and the engine records a one-shot per-node bypass, and under `on_exceed: fail` the deliberate act is
   * raising `max_cost_microcents` in the YAML, which is literally the analogy §1 draws ("exactly like raising the
   * cap under `on_exceed`"). The gap is the SESSION path, where `[chat]` has neither a gate nor a per-run YAML —
   * which is why the marker for it lives in `session-host.ts`, next to the wiring §4 has to add.
   */
  releaseConservativeCommitments(): number {
    const released = this.#conservativeCostMicrocents;
    this.#conservativeCostMicrocents = 0;
    this.#warningArmed = true;
    return released;
  }

  /**
   * Mark a resumed media job as carrying a pre-§3, unknown money basis (ADR-0074 §3).
   *
   * Deliberately node-keyed rather than a bare counter: the refusal message can then name what to wait for, and a
   * re-entrant resume of the same node cannot double-register.
   */
  registerLegacyMediaJob(nodeId: string): void {
    if (this.#legacyMediaJobNodes.has(nodeId)) return; // idempotent; a re-entrant resume must not double-register
    let settle = (): void => undefined;
    const promise = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.#legacyMediaJobNodes.set(nodeId, { promise, settle });
  }

  /**
   * The job settled, so its realized charge has replaced the guess — the uncertainty is over, and anything
   * waiting on it may proceed.
   *
   * MUST also be called at run teardown for every still-registered node. A waiter blocked on a job that will now
   * never settle would hang forever, which is worse than either failing or admitting.
   */
  clearLegacyMediaJob(nodeId: string): void {
    const entry = this.#legacyMediaJobNodes.get(nodeId);
    if (entry === undefined) return;
    this.#legacyMediaJobNodes.delete(nodeId);
    entry.settle();
  }

  /**
   * Release EVERY outstanding hold at once — the run is ending, so nothing will ever settle.
   *
   * Without this a `checkPreEgress` suspended in the hold keeps its node counted as `running`, `#step` never
   * reaches `#countRunning() === 0`, and the run never emits a terminal at all. The hold was meant to delay
   * egress, not to make a run unkillable, so the abort path must always be able to break it.
   */
  releaseAllLegacyMediaJobHolds(): void {
    // Iterating the LIVE map while `clearLegacyMediaJob` deletes from it is safe: a `Map` iterator tolerates the
    // deletion of the entry it is currently on, and each call deletes exactly that one. A snapshot copy would
    // only matter if a callee ever deleted an entry the iterator had not reached yet.
    for (const nodeId of this.#legacyMediaJobNodes.keys()) {
      this.clearLegacyMediaJob(nodeId);
    }
  }

  /** Node ids whose resumed media job still has an unknown money basis. */
  get legacyMediaJobNodes(): readonly string[] {
    return [...this.#legacyMediaJobNodes.keys()];
  }

  /**
   * Recreate a reservation at an amount that was ALREADY priced and accepted — no pricing lookup (ADR-0074 §3).
   *
   * The difference from {@link reserveCommittedEgress} is the whole point: that one re-prices from the current
   * catalog and user overlay, so a price change between a job's submission and a resume silently rewrote a
   * commitment the provider had already accepted. This one restores the exact frozen figure.
   *
   * `0` is a legitimate input and correctly yields no admission — an unpriced model under a non-strict cap took
   * the allow-degrade path and held none at submit time either, so restoring one would invent a reservation that
   * never existed.
   */
  reserveAcceptedCost(model: string, acceptedMicrocents: number): BudgetAdmission | undefined {
    // Guarded like `restoreConservativeCost`: this reads a persisted figure from a `run_events` row, which is the
    // one input path the governor cannot type-check its way out of.
    if (!Number.isSafeInteger(acceptedMicrocents) || acceptedMicrocents <= 0) return undefined;
    return this.#admit(model, acceptedMicrocents);
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
    return estimate.kind === 'priced' ? this.#admit(model, estimate.estimateMicrocents) : undefined;
  }

  /**
   * Announce a partial pricing gap once per (model, modality).
   *
   * Separate from the unpriced-MODEL notice above, and keyed more finely on purpose: a model can be missing an
   * image rate while carrying an audio one, and collapsing the two would either repeat the same sentence for a
   * second modality or silence it. Best-effort exactly like its sibling — a misbehaving host renderer must
   * never turn an advisory into a blocked call — and the dedupe is recorded even when the sink throws, so a
   * broken renderer cannot produce an exception storm.
   */
  #noticeUnpricedModalities(model: string, modalities: readonly MediaBilledModality[]): void {
    for (const modality of modalities) {
      const key = `${model}\u0000${modality}`;
      if (this.#unpricedModalityNotified.has(key)) continue;
      this.#unpricedModalityNotified.add(key);
      try {
        this.#onUnpriced?.(model, this.#budget.max_cost_microcents, [modality]);
      } catch {
        // Advisory only; it cannot block or fail the check.
      }
    }
  }

  /** Calculate a price without applying cap policy; shared by prospective admission and committed-job restoration. */
  #estimate(
    model: string,
    maxTokens: number | undefined,
    mediaUnitsEstimate: readonly MediaUnitsEstimate[] | undefined,
    provider: ProviderId | undefined,
  ): EstimateResult {
    try {
      // Token estimate + the disjoint media estimate (ADR-0044 §3). An unknown MODEL throws and follows the
      // uniform policy in #evaluate; an unpriced MODALITY on a known model comes back named (ADR-0089 §4)
      // rather than as a silent 0, because a 0 here is what let a strict cap admit paid generation (`CR-55`).
      const tokens = estimateMaxNextCost(
        model,
        maxTokens ?? this.#defaultMaxTokensEstimate,
        this.#overlay,
        // Key the endpoint on the routing provider (review M2). A media-only gate omits it (`maxTokens: 0`
        // makes the token estimate 0 regardless), so `official` is a harmless default there.
        (provider === undefined ? undefined : this.#resolveEndpoint?.(provider)) ?? 'official',
      );
      const media =
        mediaUnitsEstimate === undefined
          ? undefined
          : estimateMediaCost(model, mediaUnitsEstimate, this.#overlay);
      return {
        kind: 'priced',
        estimateMicrocents: tokens + (media?.microcents ?? 0),
        unpricedModalities: media?.unpricedModalities ?? [],
      };
    } catch (err) {
      if (err instanceof UnknownModelError) return { kind: 'unpriced' };
      throw err;
    }
  }

  /** Insert one reservation synchronously. Zero/unpriced/unbounded evaluations intentionally carry no lease. */
  #admit(model: string, estimateMicrocents: number | undefined): BudgetAdmission | undefined {
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
      reservedMicrocents: estimateMicrocents,
      settle,
      settleAtReservedEstimate: (origin) => {
        if (settled) return;
        settled = true;
        const reserved = this.#reservedAdmissions.get(id);
        if (reserved === undefined) return;
        this.#reservedAdmissions.delete(id);
        this.#reservedCostMicrocents -= reserved;
        this.#conservativeCostMicrocents += reserved;
        this.#warningArmed = true;
        // The snapshot is read AFTER the increment, so it always includes this commitment — the invariant the
        // event's schema refinement pins, and the one bug the refinement exists to catch.
        this.#persistCommitment({
          type: 'budget:estimate_committed',
          ...(origin?.nodeId === undefined ? {} : { nodeId: origin.nodeId }),
          ...(origin?.attemptNumber === undefined ? {} : { attemptNumber: origin.attemptNumber }),
          model,
          estimateMicrocents: reserved,
          cumulativeConservativeMicrocents: this.#conservativeCostMicrocents,
        });
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
