import {
  estimateResolvedRequestCost,
  outputCapPlanForRequest,
  outputTokensReservation,
  supportsRequest,
  InvalidTokenEstimateError,
  UnknownModelError,
  type FallbackPlanEntry,
  type LlmRequest,
  type MediaUnitsEstimate,
  type PricingOverlay,
} from '@relavium/llm';

import type {
  AllowanceEntryIdentity,
  AllowanceExcludedEntry,
  AllowancePricedEntry,
  AllowanceProvenance,
  AllowanceQuote,
  AllowanceQuoteResult,
  ResolvedRequestEstimate,
} from '@relavium/shared';

export type {
  AllowanceEntryIdentity,
  AllowanceExcludedEntry,
  AllowancePricedEntry,
  AllowanceProvenance,
  AllowanceAmount,
  AllowanceQuote,
  AllowanceQuoteResult,
} from '@relavium/shared';

interface QuoteCommon {
  readonly entries: readonly FallbackPlanEntry[];
  readonly mediaUnitsEstimate?: readonly MediaUnitsEstimate[];
}

/** Ephemeral construction context; never serialized into authorization or checkpoint rows. */
export type AllowanceQuoteContext = QuoteCommon &
  (
    | {
        readonly route: 'text';
        /** The paused construction request, before any candidate's dialect filtering. */
        readonly request: LlmRequest;
        readonly inputTokensEstimate: number;
        readonly maxTokensEstimate: number | undefined;
        readonly maxToolTurns: number;
      }
    | { readonly route: 'generative' }
  );

export type AllowanceQuoteInput = AllowanceQuoteContext & {
  readonly overlay?: PricingOverlay;
  readonly strictCostCap: boolean;
};

function assertCount(value: number, positive: boolean): void {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    throw new InvalidTokenEstimateError();
  }
}

/**
 * Freeze A = calls × attempts × largest E at the paused input size (ADR-0097).
 * Capability/streaming skips are excluded; cooldown does not remove an eligible entry. Node retries do
 * not multiply the amount. Every text candidate consumes its own cap plan against the SAME raw canonical
 * and native cap inputs; a primary's filtered request is insufficient for a heterogeneous chain.
 */
export function quoteBudgetAllowance(input: AllowanceQuoteInput): AllowanceQuoteResult {
  if (input.entries.length === 0) throw new InvalidTokenEstimateError();
  const inline =
    input.route === 'text' && input.request.outputModalities?.some((m) => m !== 'text') === true;
  let calls = 1;
  if (input.route === 'text') {
    assertCount(input.maxToolTurns, false);
    if (!inline && (input.request.tools?.length ?? 0) > 0) {
      calls = input.maxToolTurns + 1;
      assertCount(calls, true);
    }
  }
  const eligible: AllowancePricedEntry[] = [];
  const excluded: AllowanceExcludedEntry[] = [];
  let attempts = 0;
  let largest = 0;
  let representable = true;
  const entries = input.route === 'generative' ? input.entries.slice(0, 1) : input.entries;
  for (const [index, entry] of entries.entries()) {
    const entryAttempts = input.route === 'generative' ? 1 : entry.maxAttempts;
    assertCount(entryAttempts, true);
    const identity: AllowanceEntryIdentity = {
      index,
      model: entry.model,
      provider: entry.provider.id,
      endpoint: entry.provider.customEndpoint === true ? 'custom' : 'official',
    };
    let output = 0;
    if (input.route === 'text') {
      const request = { ...input.request, model: entry.model };
      if (
        (!inline && !entry.provider.supports.streaming) ||
        !supportsRequest(entry.provider.supports, request, {
          catalogAuthoritative: identity.endpoint === 'official',
        })
      ) {
        excluded.push(Object.freeze({ ...identity, reason: 'unsupported' }));
        continue;
      }
      output = outputTokensReservation(
        outputCapPlanForRequest(request, identity.provider, identity.endpoint),
        input.maxTokensEstimate,
      );
    } else if (entry.provider.generateMedia === undefined) {
      excluded.push(Object.freeze({ ...identity, reason: 'unsupported' }));
      continue;
    }
    let estimate: ResolvedRequestEstimate;
    try {
      estimate = estimateResolvedRequestCost(
        entry.model,
        input.route === 'generative' ? 0 : input.inputTokensEstimate,
        output,
        input.mediaUnitsEstimate,
        input.overlay,
      );
    } catch (error) {
      if (!(error instanceof UnknownModelError)) throw error;
      excluded.push(Object.freeze({ ...identity, reason: 'unpriced_model' }));
      continue;
    }
    if (input.strictCostCap && estimate.unpricedModalities.length > 0) {
      excluded.push(Object.freeze({ ...identity, reason: 'unpriced_modality' }));
      continue;
    }
    eligible.push(Object.freeze({ ...identity, attempts: entryAttempts, estimate }));
    attempts += entryAttempts;
    if (estimate.kind === 'unrepresentable') representable = false;
    else largest = Math.max(largest, estimate.microcents);
  }
  const excludedEntries = Object.freeze(excluded);
  if (eligible.length === 0) return Object.freeze({ kind: 'unpriced', excludedEntries });
  // The actual plan bounds make this small. A malformed direct caller must never put an unsafe count
  // in quote provenance, even when its eventual monetary product would be zero.
  assertCount(attempts, true);
  const amount = calls * attempts * largest;
  representable &&= Number.isSafeInteger(amount) && amount >= 0;
  const provenance: AllowanceProvenance = Object.freeze({
    version: 1,
    route: input.route,
    calls,
    attempts,
    entries: Object.freeze(eligible),
  });
  const quote: AllowanceQuote = Object.freeze({
    amount: representable
      ? Object.freeze({ kind: 'representable', microcents: amount })
      : Object.freeze({ kind: 'unrepresentable' }),
    provenance,
    excludedEntries,
  });
  return Object.freeze({ kind: 'quoted', quote });
}

function sameList<T>(
  left: readonly T[],
  right: readonly T[],
  same: (a: T, b: T) => boolean,
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index];
      return other !== undefined && same(entry, other);
    })
  );
}

function sameIdentity(left: AllowanceEntryIdentity, right: AllowanceEntryIdentity): boolean {
  return (
    left.index === right.index &&
    left.model === right.model &&
    left.provider === right.provider &&
    left.endpoint === right.endpoint
  );
}

function sameEstimate(left: ResolvedRequestEstimate, right: ResolvedRequestEstimate): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'priced' && right.kind === 'priced' && left.microcents !== right.microcents)
    return false;
  const a = left.basis;
  const b = right.basis;
  return (
    a.inputTokensEstimate === b.inputTokensEstimate &&
    a.outputTokensReservation === b.outputTokensReservation &&
    a.inputRateKind === b.inputRateKind &&
    a.inputPerMtokMicrocents === b.inputPerMtokMicrocents &&
    a.outputPerMtokMicrocents === b.outputPerMtokMicrocents &&
    a.contextTierAboveTokens === b.contextTierAboveTokens &&
    sameList(
      a.media,
      b.media,
      (x, y) =>
        x.modality === y.modality && x.units === y.units && x.rateMicrocents === y.rateMicrocents,
    ) &&
    sameList(left.unpricedModalities, right.unpricedModalities, (x, y) => x === y)
  );
}

/**
 * Early refusal using recorded priced quantities, before a host prepares credentials or MCP.
 * A match is NOT approval: current request eligibility and exclusions still require the engine's
 * complete prepared quote. The same rate-only kernel/comparison serves both paths.
 */
export function budgetAllowancePricesMatch(
  recorded: AllowanceQuoteResult,
  overlay?: PricingOverlay,
): boolean {
  if (recorded.kind !== 'quoted') return false;
  try {
    return recorded.quote.provenance.entries.every((entry) => {
      const basis = entry.estimate.basis;
      const current = estimateResolvedRequestCost(
        entry.model,
        basis.inputTokensEstimate,
        basis.outputTokensReservation,
        basis.media.map(({ modality, units }) => ({ modality, units })),
        overlay,
      );
      return sameEstimate(entry.estimate, current);
    });
  } catch {
    // A missing price or failed host inspection leaves approval unavailable without exposing its cause.
    return false;
  }
}

/** Full effective price/eligibility comparison; equal aggregate A alone is never sufficient. */
export function sameBudgetAllowanceQuote(
  left: AllowanceQuoteResult,
  right: AllowanceQuoteResult,
): boolean {
  if (left.kind !== right.kind) return false;
  const excluded = (
    a: readonly AllowanceExcludedEntry[],
    b: readonly AllowanceExcludedEntry[],
  ): boolean => sameList(a, b, (x, y) => sameIdentity(x, y) && x.reason === y.reason);
  if (left.kind === 'unpriced' && right.kind === 'unpriced')
    return excluded(left.excludedEntries, right.excludedEntries);
  if (left.kind !== 'quoted' || right.kind !== 'quoted') return false;
  const a = left.quote;
  const b = right.quote;
  if (a.amount.kind !== b.amount.kind) return false;
  if (
    a.amount.kind === 'representable' &&
    b.amount.kind === 'representable' &&
    a.amount.microcents !== b.amount.microcents
  )
    return false;
  return (
    a.provenance.version === b.provenance.version &&
    a.provenance.route === b.provenance.route &&
    a.provenance.calls === b.provenance.calls &&
    a.provenance.attempts === b.provenance.attempts &&
    excluded(a.excludedEntries, b.excludedEntries) &&
    sameList(
      a.provenance.entries,
      b.provenance.entries,
      (x, y) =>
        sameIdentity(x, y) && x.attempts === y.attempts && sameEstimate(x.estimate, y.estimate),
    )
  );
}
