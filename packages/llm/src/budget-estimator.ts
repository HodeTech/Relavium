import { priceModel } from './cost-tracker.js';

const TOKENS_PER_MTOK = 1_000_000;

/**
 * Pre-egress worst-case cost estimate for a single LLM call.
 *
 * The estimate prices only the **output** side at the model's declared `maxTokens`
 * (or a configured default), because the engine does not tokenize the prompt locally.
 * This is intentionally conservative: it may block slightly early rather than overshoot.
 *
 * All figures are integer micro-cents.
 */
export function estimateMaxNextCost(modelId: string, maxOutputTokens: number): number {
  const p = priceModel(modelId);
  if (maxOutputTokens <= 0) {
    return 0;
  }
  return Math.round((maxOutputTokens * p.outputPerMtokMicrocents) / TOKENS_PER_MTOK);
}
