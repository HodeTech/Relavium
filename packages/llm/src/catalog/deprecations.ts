/**
 * **When to warn a user** — a Relavium-owned overlay, and deliberately the ONE thing the generated catalog does not
 * decide ([ADR-0071](../../../../docs/decisions/0071-models-dev-as-the-model-metadata-source.md) §10).
 *
 * models.dev publishes a `status` flag, not a retirement date, and a flag cannot tell a user *"this stops working
 * in eleven days"*. That sentence is an editorial call about our own users, made from the provider's own
 * announcement — which is why it survives the deletion of the hand-typed price table rather than dying with it.
 *
 * The first implementation of the swap dropped these dates on the argument that "the provider is the only one who
 * knows when the provider is retiring something, so it should come from the live list". The argument is right and
 * the conclusion was wrong: **no adapter populates `ModelListing.deprecatedAt`** — the OpenAI-compatible list is
 * id-only, and Anthropic's and Gemini's mappers carry limits and names, nothing else. So `deprecated` became
 * permanently `false` for every model in the product, and `deepseek-chat` was set to stop working on 2026-07-24
 * with nothing anywhere to say so. Information we already had, thrown away.
 *
 * This is NOT a second pricing home. It carries no price, no ceiling, no capability — one date per model, from a
 * published retirement notice, and the merge unions it with whatever the live list and the user say (earliest
 * wins). A model absent from it is simply not announced as retiring.
 *
 * **Adding one:** cite the provider's announcement in the comment. Removing one once its date has passed is not
 * urgent — the entry keeps flagging a model that genuinely no longer works.
 */
export const MODEL_DEPRECATIONS: Readonly<Record<string, string>> = {
  // DeepSeek's legacy aliases (api-docs.deepseek.com/quick_start/pricing, verified 2026-07-03): both retire at
  // 2026-07-24 15:59 UTC, superseded by `deepseek-v4-flash` / `deepseek-v4-pro`, which serve non-thinking and
  // thinking on one id each.
  'deepseek-chat': '2026-07-24T15:59:00Z',
  'deepseek-reasoner': '2026-07-24T15:59:00Z',
};

/** The announced retirement date for a model id, or `undefined` if none is announced. */
export function deprecationFor(modelId: string): string | undefined {
  return MODEL_DEPRECATIONS[modelId];
}
