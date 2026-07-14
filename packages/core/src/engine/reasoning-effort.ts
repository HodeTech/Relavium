import type { ReasoningEffort } from '@relavium/shared';

/**
 * The host's per-model projection of **which reasoning tiers this model will actually accept**
 * ([ADR-0071](../../../../docs/decisions/0071-models-dev-as-the-model-metadata-source.md) §6).
 *
 * It replaces a `boolean`, and the upgrade is the whole point: *"does this model reason"* is not the question the
 * wire asks. `gpt-5.4-pro` reasons **and rejects `low`**; `gpt-5-pro` reasons and accepts only `high`;
 * `gemini-2.5-pro` reasons and **cannot be turned off at all**. A boolean answers `true` to every one of them and
 * the tier the user picked goes straight to the provider — which is the 400 the maintainer reported.
 *
 * `undefined` ⇒ the host cannot describe this model (no resolver wired, or a custom endpoint the catalog does not
 * carry). An **empty set** ⇒ the model reasons but exposes no controllable tier (`deepseek-reasoner`). Both mean
 * the same thing at the wire: **withhold the field**.
 */
export type ResolveEffortTiers = (model: string) => ReadonlySet<ReasoningEffort> | undefined;

/** What the gate decided, and — when it withheld — enough to tell the user WHY without guessing. */
export type EffortGateResult =
  | { readonly kind: 'send'; readonly effort: ReasoningEffort }
  /** No tier was resolved at all (nothing authored, no config default, no session override). Not a problem. */
  | { readonly kind: 'unset' }
  /** The model does not reason, or exposes no controllable tier. The field is withheld. */
  | { readonly kind: 'uncontrollable' }
  /**
   * The model reasons, but **rejects the requested tier**. Withheld — never silently promoted to a neighbouring
   * one, which would change behaviour *and* raise spend without the user asking. `accepted` is what it WOULD take,
   * so a surface can say something actionable instead of "it failed".
   */
  | {
      readonly kind: 'rejected';
      readonly requested: ReasoningEffort;
      readonly accepted: readonly ReasoningEffort[];
    }
  /**
   * The model ACCEPTS the tier, but a budget-shaped model withholds it because the request's `max_tokens` leaves no
   * room for its minimum thinking budget (review M6). The blocker is the CAP, not the model — so the message points
   * the user at `max_tokens`, not at the tier. `maxTokens` is the cap that was too small.
   */
  | { readonly kind: 'capped'; readonly requested: ReasoningEffort; readonly maxTokens: number };

/** Does a budget-shaped model withhold this tier under this output cap? Host-injected (it reads the catalog for the
 *  model's budget range); the pure gate stays platform-free. Called only for a NON-`off` tier the model accepts. */
export type ReasoningCapCheck = (
  model: string,
  tier: ReasoningEffort,
  maxTokens: number,
) => boolean;

/**
 * Gate — and now **CLAMP** — the normalized reasoning-effort tier against what the model actually accepts
 * ([ADR-0066](../../../../docs/decisions/0066-normalized-reasoning-effort-control.md),
 * [ADR-0071](../../../../docs/decisions/0071-models-dev-as-the-model-metadata-source.md) §6).
 *
 * The previous version was **pass-through-or-withhold**, not a clamp: if the model reasoned *at all*, whatever
 * tier the user picked went to the wire unexamined. That is the F3 bug. It now sends a tier only if the model is
 * on record as taking it.
 *
 * A rejected tier is **withheld, never promoted**. Substituting the nearest acceptable tier would silently change
 * what the model does and silently raise what it costs — and the user would have no way to know either happened.
 *
 * The one home for the rule (both the workflow `AgentRunner` path and the `AgentSession` per-turn build use it),
 * so it cannot drift between them. Pure — `packages/core` stays platform-free; the host injects the resolver.
 */
export function gateReasoningEffort(
  effort: ReasoningEffort | undefined,
  model: string,
  resolveEffortTiers: ResolveEffortTiers | undefined,
  cap?: { readonly maxTokens: number; readonly withheldByCap: ReasoningCapCheck },
): EffortGateResult {
  if (effort === undefined) return { kind: 'unset' };

  const accepted = resolveEffortTiers?.(model);
  // No resolver, an unknown model, or a model with no controllable tier — all withhold. An unknown model is the
  // safe default on purpose: guessing is what put a rejected value on the wire in the first place.
  if (accepted === undefined || accepted.size === 0) return { kind: 'uncontrollable' };

  if (!accepted.has(effort))
    return { kind: 'rejected', requested: effort, accepted: [...accepted] };

  // The tier is accepted — but a budget-shaped model still withholds it at send when the request's cap leaves no
  // room for the budget floor (review M6). `off` is never budgeted, so it is exempt. Surface it as `capped` so the
  // adapter's silent drop becomes a message that names `max_tokens` as the fix. A cap is only checked when the host
  // both wired the check and set a `max_tokens`; an absent cap uses the adapter's (large) default, which never
  // withholds. The gate and the adapter agree by construction: both read `reasoningBudgetFor`.
  if (effort !== 'off' && cap !== undefined && cap.withheldByCap(model, effort, cap.maxTokens)) {
    return { kind: 'capped', requested: effort, maxTokens: cap.maxTokens };
  }
  return { kind: 'send', effort };
}

/** The tier to send, or `undefined` to omit the field — the shorthand a request-builder wants. */
export function effortToSend(result: EffortGateResult): ReasoningEffort | undefined {
  return result.kind === 'send' ? result.effort : undefined;
}
