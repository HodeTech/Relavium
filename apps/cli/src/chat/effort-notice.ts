import type { EffortGateResult } from '@relavium/core';
import {
  catalogModel,
  effortTiersFor as seamEffortTiersFor,
  reasoningControlShape,
  reasoningWithheldByCap,
  wireValueFor,
  CANONICAL_ON_TIER,
} from '@relavium/llm';
import { EFFORT_TIER_HINT, REASONING_EFFORTS, type ReasoningEffort } from '@relavium/shared';

import { sanitizeInline } from '../render/sanitize.js';

/**
 * What we TELL the user when a reasoning tier is withheld
 * ([ADR-0071](../../../../docs/decisions/0071-models-dev-as-the-model-metadata-source.md) §6).
 *
 * The gate replaced a loud provider 400 with a quiet no-op — the turn runs, the field is dropped, and the bill
 * lands at the provider's default tier. That is the better failure ONLY if it is said out loud; a rejection the
 * user cannot see is worse than the error it replaced. Every surface that can withhold (the `/effort` command, the
 * session seed, the workflow runner, the in-Home chat) says it with the sentences below, so the wording cannot
 * drift between them.
 *
 * It lives here rather than beside the picker because the picker is one CONSUMER of it: the engine host
 * (`build-engine.ts`) and the session host both need it too, and neither should be reaching into `render/tui/`.
 */

/** The model id, safe to write to a terminal — it comes from an authored YAML and is only `nonEmptyString` there. */
function safeModel(model: string): string {
  return sanitizeInline(model);
}

/**
 * Why this model has no effort control at all — the sentence a surface shows instead of a dead overlay.
 *
 * The two causes need different words because they need different ACTIONS. A model with no catalog row may simply
 * be newer than our snapshot, and a refresh could give it its control back; a model that publishes no knob will
 * never have one, however often we refresh. "No reasoning control" for both — which is all the old id heuristic
 * could say — tells the user nothing they can act on.
 */
export function effortUnavailableNote(model: string): string {
  return catalogModel(model) === undefined
    ? `${safeModel(model)} is not in Relavium's model catalog, so its reasoning control is unknown — no tier is sent. Run \`relavium models refresh\` if the model is newer than the catalog.`
    : `${safeModel(model)} publishes no controllable reasoning tier — a tier would be ignored.`;
}

/**
 * Why THIS tier is not available, and which ones are — the sentence for a tier the model rejects.
 *
 * `accepted` is what the engine's gate already computed (`{kind:'rejected', requested, accepted}`), re-sorted into
 * canonical tier order: the gate builds its array by spreading a `Set` whose insertion order puts `off` last (it
 * rides a different axis), and the rows must read `off → low → medium → high → max` wherever they appear.
 */
export function effortRejectedNote(
  model: string,
  requested: ReasoningEffort,
  accepted: Iterable<ReasoningEffort>,
): string {
  const offered = new Set(accepted);
  const list = REASONING_EFFORTS.filter((tier) => offered.has(tier));
  return list.length === 0
    ? effortUnavailableNote(model)
    : `${safeModel(model)} does not accept reasoning effort '${requested}' — it takes ${list.join(', ')}. No tier is sent.`;
}

/**
 * The reasoning-effort ROWS a picker should offer for a model, in canonical order — the PRESENTATION projection of
 * `@relavium/llm`'s wire-accurate {@link acceptedTiers}, deduped so no two rows produce the SAME provider behavior
 * (ADR-0066 amendment). By the model's control SHAPE ({@link reasoningControlShape}), never per-model:
 *
 *   - **graded** (a real effort ladder): the accepted tiers, DEDUPED by distinct wire value. DeepSeek's
 *     low/medium/high all send `high`, so they collapse to ONE row (`off/high/max`); Gemini's `max` coarsens onto
 *     `high` (`low/medium/high`). A model whose rungs are all distinct (`claude-opus-4-8`, `gpt-5.4-pro`) is
 *     unchanged. The representative kept per wire is the tier whose own NAME matches the wire (so DeepSeek's
 *     `high`-wire row reads "high", not "low" or "max"), else the highest tier for that wire.
 *   - **budget** (a continuous token budget, no ladder — `claude-haiku-4-5`): a two-row **off/on**, "on" =
 *     {@link CANONICAL_ON_TIER}. A budget has no meaningful discrete rungs (Claude-Code parity). Only a GENUINE
 *     two-state choice opens the overlay: a model that cannot be turned off (`gemini-2.5-pro`) has nothing to
 *     toggle, so the list is empty.
 *   - **none** (`deepseek-reasoner`'s `{}`, a custom/uncatalogued model, or a model with no usable knob): empty.
 *
 * Every emitted tier is a member of the seam's accepted set, so the accept sends a value the engine gate accepts
 * verbatim. Empty for all three "nothing to offer" cases; the surfaces distinguish WHY in what they SAY (see
 * {@link effortUnavailableNote}). The seam ({@link acceptedTiers}) is unchanged — this is presentation only.
 */
export function effortTiersFor(model: string): readonly ReasoningEffort[] {
  const entry = catalogModel(model);
  const accepted = seamEffortTiersFor(model);
  const shape = reasoningControlShape(entry?.reasoning);
  if (shape === 'none') return [];
  if (shape === 'budget') {
    // A continuous budget → off/on. BOTH states must be reachable for a real choice; else nothing to pick.
    return accepted.has('off') && accepted.has(CANONICAL_ON_TIER) ? ['off', CANONICAL_ON_TIER] : [];
  }
  // graded: keep one representative tier per distinct WIRE value (see the doc for how the representative is chosen).
  const provider = entry?.provider ?? 'openai';
  const repByWire = new Map<string, ReasoningEffort>();
  for (const tier of REASONING_EFFORTS) {
    if (tier === 'off' || !accepted.has(tier)) continue;
    const wire = wireValueFor(provider, tier);
    if (wire === undefined) continue;
    const cur = repByWire.get(wire);
    // Ascending order, so a later tier is HIGHER. Overwrite unless the current rep is already the name-match for
    // this wire (then keep it — the name-match reads truest, e.g. Gemini's `high` over its coarsened `max`).
    if (cur === undefined || (cur as string) !== wire) repByWire.set(wire, tier);
  }
  const reps = new Set(repByWire.values());
  return REASONING_EFFORTS.filter((t) => (t === 'off' ? accepted.has('off') : reps.has(t)));
}

/**
 * The display label + hint for one effort ROW (or the bound tier in the footer/notice) — so a budget model's
 * canonical-on tier reads "on" everywhere, while every graded tier reads its own name. Keeps the picker, the footer
 * and the notices from disagreeing about what a tier is called.
 */
export function effortRowLabel(
  model: string,
  tier: ReasoningEffort,
): { label: string; hint: string } {
  if (
    tier === CANONICAL_ON_TIER &&
    reasoningControlShape(catalogModel(model)?.reasoning) === 'budget'
  ) {
    return { label: 'on', hint: 'reasoning on' };
  }
  return { label: tier, hint: EFFORT_TIER_HINT[tier] };
}

/**
 * Project an arbitrary tier onto the SURVIVING picker row that represents it (ADR-0066 amendment) — so an
 * opening-highlight or ✓ lands on a real row even when that tier was deduped away or collapsed to on/off. Without
 * it, `rows.indexOf(a-collapsed-tier)` is `-1` and a fresh `/models` accept on the neutral highlight silently wrote
 * `off` for a graded-collapsed model (`effortTiersFor('deepseek-v4-pro')` = ['off','high','max'], and the neutral
 * `medium` is not a row). A budget model folds any non-off tier onto the canonical-on row; a graded model folds a
 * tier onto the surviving row with the SAME wire value. `undefined` ⇒ nothing represents it (empty list, or `off`
 * on a can't-disable model) — the caller clamps to the first row.
 */
export function projectEffortToRow(
  model: string,
  rows: readonly ReasoningEffort[],
  tier: ReasoningEffort,
): ReasoningEffort | undefined {
  if (rows.includes(tier)) return tier; // already a surviving row
  if (tier === 'off') return undefined; // its own axis — if `off` is not a row, nothing represents it
  const entry = catalogModel(model);
  if (reasoningControlShape(entry?.reasoning) === 'budget') {
    return rows.includes(CANONICAL_ON_TIER) ? CANONICAL_ON_TIER : undefined;
  }
  const provider = entry?.provider ?? 'openai';
  const wire = wireValueFor(provider, tier);
  return rows.find(
    (r): r is Exclude<ReasoningEffort, 'off'> => r !== 'off' && wireValueFor(provider, r) === wire,
  );
}

/**
 * The single note for a WITHHELD reasoning tier (ADR-0071 §6) — the one place the engine host (`build-engine.ts`)
 * and the session host map an {@link EffortGateResult} to words, so neither carries its own inline ternary and the
 * wording cannot drift between them. The core invokes the `onEffortWithheld` sink for `rejected`, `uncontrollable`,
 * and `capped` (agent-runner / agent-session), so those three are the outcomes with a sentence; the exhaustive
 * default guards a future gate kind against silently taking one of the existing sentences.
 */
export function effortWithheldNote(result: EffortGateResult, model: string): string {
  switch (result.kind) {
    case 'rejected':
      return effortRejectedNote(model, result.requested, result.accepted);
    case 'uncontrollable':
      return effortUnavailableNote(model);
    case 'capped':
      return effortCappedNote(model, result.requested, result.maxTokens);
    default:
      throw new Error(`effortWithheldNote: '${result.kind}' is not a withheld outcome`);
  }
}

/**
 * The note for a tier the model ACCEPTS but the request's `max_tokens` withholds (review M6). A budget-shaped model
 * (`claude-haiku-4-5`) needs room for its minimum thinking budget under the output cap; a tight `max_tokens` leaves
 * none, so the adapter drops thinking. The blocker is the CAP — so the sentence names `max_tokens`, not the tier.
 */
export function effortCappedNote(
  model: string,
  requested: ReasoningEffort,
  maxTokens: number,
): string {
  const { label } = effortRowLabel(model, requested);
  return `reasoning ${label} needs a larger max_tokens than ${maxTokens} on ${sanitizeInline(model)} — it was withheld this turn.`;
}

/** The {@link import('@relavium/core').ReasoningCapCheck} for the CLI hosts: reads the catalog for the bound model's
 *  budget range and asks whether the adapter would drop thinking under this `max_tokens` (review M6). `off` is never
 *  budgeted, and an uncatalogued model has no budget to exceed — both are `false` (nothing is cap-withheld). */
export function reasoningWithheldByCapFor(
  model: string,
  tier: ReasoningEffort,
  maxTokens: number,
): boolean {
  if (tier === 'off') return false;
  const entry = catalogModel(model);
  if (entry?.reasoning === undefined) return false;
  return reasoningWithheldByCap(entry.provider, entry.reasoning, tier, maxTokens);
}

/**
 * Wrap a notice sink so a PERSISTENT condition is reported once, not once per turn.
 *
 * The gate is consulted on every turn and every agent-node execution, and a withheld tier is not a transient
 * event — a stale `off` bound on `gemini-2.5-pro` (which cannot disable thinking at all) is withheld on turn one
 * and on turn fifty. Without this the transcript grows a fresh copy of the same sentence every turn, and a
 * workflow agent inside a `loop` prints the same stderr warning on every iteration. `BudgetGovernor`'s warning
 * has the same shape and is threshold-gated for the same reason.
 *
 * Keyed on the NOTE, so a genuinely new condition — a different tier, a different model after a reseat — still
 * speaks up. The set lives for the life of the sink, which is the life of the session or run.
 */
export function onceEffortNotice(sink: (note: string) => void): (note: string) => void {
  const said = new Set<string>();
  return (note: string): void => {
    if (said.has(note)) return;
    said.add(note);
    sink(note);
  };
}

/**
 * Integer micro-cents → a plain USD string (1 USD = 1e8 micro-cents), fixed-decimal so a tiny cap reads `$0.00`
 * rather than `$1e-8`. Two decimals is the granularity a cost cap is ever set at; a sub-cent cap rounds to `$0.00`,
 * which is honest — it is effectively "block everything".
 */
export function capUsd(microcents: number): string {
  return `$${(microcents / 100_000_000).toFixed(2)}`;
}

/**
 * What we tell a user when a turn ran on a model we could not PRICE (ADR-0071 §K7).
 *
 * A cost cap on an unpriced model is a hole: the governor cannot estimate a turn's cost, so it degrades to `allow`
 * — the right trade for a self-hosted model with ~no metered cost, but a false sense of safety if said in silence.
 * One sentence, everywhere, so the chat transcript, `relavium run`, `agent run`, and the resumed `gate` all say it
 * the same way. `strict_cost_cap` is named as the block-instead escape hatch, and `models pricing` as the fix.
 */
export function unpricedModelNote(
  model: string,
  capMicrocents: number,
  // The exact key a user edits to turn strict on, which DIFFERS by surface: a chat user sets `[chat] strict_cost_cap`
  // in config.toml, a workflow user sets `budget.strict_cost_cap` in the YAML. A generic "strict_cost_cap" makes each
  // guess which file. Default to the bare name for a caller that has no better spelling.
  strictSetting = 'strict_cost_cap',
): string {
  // Sanitize the provider-controlled model id at this display boundary, exactly as the sibling effort notices do —
  // a crafted id must not smuggle a terminal escape into the transcript line (it appears twice, incl. a command).
  const safeModel = sanitizeInline(model);
  return `${safeModel} has no price, so the cost cap (${capUsd(capMicrocents)}) does not apply to it. Price it with \`relavium models pricing ${safeModel}\`, or set ${strictSetting} to refuse an unpriced model.`;
}
