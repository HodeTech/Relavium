import { catalogModel } from './catalog/lookup.js';

/**
 * The request's output cap, held **at or below the model's own ceiling**
 * ([ADR-0071](../../../docs/decisions/0071-models-dev-as-the-model-metadata-source.md) §7).
 *
 * The other half of the maintainer's "max tokens errors". An authored `max_tokens: 200000` on a model whose
 * `limit.output` is 64 000 is not an ambitious request — it is a 400, every turn, and the workflow it sits in
 * never runs. Nothing in the shipped code compared the two: `MODEL_PRICING` carried a context window and no
 * output limit at all, so there was nothing to compare against. The catalog carries both.
 *
 * **Down, never up.** A cap BELOW the model's ceiling is the author's deliberate choice — a cost control, a
 * latency budget, a hard bound on a summary's length — and raising it to the ceiling would spend the user's money
 * on their behalf. Only the impossible half is corrected.
 */

/**
 * Can we describe the endpoint this request is going to?
 *
 * The catalog describes MODELS as their providers serve them. A custom `base_url` ([ADR-0065](../../../docs/decisions/0065-provider-economics-and-extensibility.md))
 * — LM Studio, Ollama, vLLM, an enterprise gateway — may serve something entirely different under a familiar id,
 * with its own limits. Clamping there would silently lower a cap the user set on a model we are only guessing at,
 * and a silent lowering is a behaviour change we have no right to make.
 *
 * This is the same reasoning that WITHHOLDS the reasoning field on an unknown model, pointed at a different
 * decision — and it lands the other way, because the two failures are not symmetric. Withholding a field we
 * cannot justify is safe; lowering a number the user typed is not.
 */
export type EndpointKind = 'official' | 'custom';

/**
 * The `max_tokens` to send: the caller's, capped at the model's published output ceiling.
 *
 * `undefined` in ⇒ `undefined` out — no cap authored, so the provider's own default stands. An id the catalog
 * does not carry, or a custom endpoint, passes through untouched: we clamp only against a limit we actually know.
 */
export function cappedMaxTokens(
  requested: number | undefined,
  model: string,
  endpoint: EndpointKind = 'official',
): number | undefined {
  if (requested === undefined || endpoint === 'custom') return requested;
  const ceiling = catalogModel(model)?.maxOutputTokens;
  if (ceiling === undefined) return requested; // not in the catalog — nothing to clamp against
  return Math.min(requested, ceiling);
}

/**
 * Did the cap get clamped? — for the one caller that wants to SAY so.
 *
 * A clamp is not a withhold: the request still asks for every token the model can physically produce, so nothing
 * the user wanted is lost. But an author who wrote `max_tokens: 200000` believes they asked for 200 000, and the
 * gap between belief and reality is exactly the sort of thing that gets debugged for an hour.
 */
export function wasCapClamped(
  requested: number | undefined,
  model: string,
  endpoint: EndpointKind = 'official',
): boolean {
  const capped = cappedMaxTokens(requested, model, endpoint);
  return capped !== undefined && requested !== undefined && capped < requested;
}
