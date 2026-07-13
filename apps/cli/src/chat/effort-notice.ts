import { catalogModel } from '@relavium/llm';
import { REASONING_EFFORTS, type ReasoningEffort } from '@relavium/shared';

import { sanitizeInline } from '../render/tui/chat-projection.js';

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
export function unpricedModelNote(model: string, capMicrocents: number): string {
  return `${model} has no price, so the cost cap (${capUsd(capMicrocents)}) does not apply to it. Price it with \`relavium models pricing ${model}\`, or turn on strict_cost_cap to refuse an unpriced model.`;
}
