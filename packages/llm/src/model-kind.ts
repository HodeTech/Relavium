/**
 * Is this model id a CHAT model? — the one canonical home of that question (CLAUDE.md rule 8).
 *
 * It began life inside the OpenAI adapter as the live-list filter ([ADR-0064](../../../docs/decisions/0064-live-model-catalog.md) §3):
 * a provider's `/v1/models` is id-only, with no capability metadata, so the filter is an id-family heuristic.
 * It moved here when a **second** consumer appeared — the generated catalog
 * ([ADR-0071](../../../docs/decisions/0071-models-dev-as-the-model-metadata-source.md)) — and the two must not
 * drift, for a reason that is not cosmetic:
 *
 * `keepOpenAiModelId` short-circuits on `pricedIds.has(id)` — **a priced id bypasses this deny-list entirely**,
 * so that a cost-eligible model can never be filtered out of the live list. Once the catalog becomes the priced
 * set, any non-chat model the catalog imports would be *rescued* by that short-circuit and appear in the user's
 * model picker as something they can chat with. `text-embedding-3-large` is priced upstream and would have
 * arrived exactly that way. Two filters that disagree is a cascade; one filter cannot.
 */

/**
 * Id SEGMENTS that are NOT chat text models. **Deny wins over allow**, so `gpt-image-1` /
 * `gpt-4o-audio-preview` / `omni-moderation` are dropped even though they match a `gpt`/`o` allow-family.
 */
const NON_CHAT_SEGMENTS = [
  'embedding',
  'tts',
  'whisper',
  'image',
  'moderation',
  'realtime',
  'audio',
  'dall-e',
  'transcribe',
  'search',
  'instruct',
  'ocr',
  'davinci',
  'babbage',
] as const;

/** Escape a literal string for embedding inside a `RegExp`. The tokens carry no metacharacters today
 *  (`dall-e`'s `-` is literal outside a character class), but this keeps the boundary match safe if one is added. */
function escapeRegExp(text: string): string {
  // `String.raw` avoids the doubled backslash of `'\\$&'` — the replacement is a literal `\` + the `$&` match ref.
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * ONE combined matcher, compiled ONCE at module load — every segment as an alternation, still anchored on a
 * `-`/`_` boundary. The previous form built a fresh `RegExp` per segment on EVERY call: fourteen compiles per
 * model id, and a bulk `sync:models` runs this over thousands of ids. No `g` flag — `.test` on a stateful regex
 * would carry `lastIndex` between calls.
 */
const NON_CHAT_SEGMENT_RE = new RegExp(
  `(^|[-_])(?:${NON_CHAT_SEGMENTS.map(escapeRegExp).join('|')})([-_]|$)`,
);

/**
 * True when `id` names something other than a chat text model.
 *
 * Every token is matched on a `-`/`_` **SEGMENT boundary**, never as a bare substring — which is load-bearing:
 * `search` must fire on `gpt-4o-search-preview` (`-search-`) and must NOT fire on `o3-deep-research`
 * (re**search**), a real reasoning model that a substring match would silently delete from the catalog and the
 * picker alike.
 */
export function isNonChatModelId(id: string): boolean {
  return NON_CHAT_SEGMENT_RE.test(id.toLowerCase());
}
