import type { ProviderId } from '../types.js';

/**
 * A context-size pricing tier — "above N context tokens, the rate changes"
 * ([ADR-0071](../../../../docs/decisions/0071-models-dev-as-the-model-metadata-source.md) §11).
 *
 * `gemini-2.5-pro` is 1.25/10 below 200k and **2.5/15 above**. A flat rate understates long-context spend by up
 * to 2× — tolerable when the cost cap was advisory, not when it is a safety control. The **pre-egress estimate
 * takes the HIGHEST applicable tier**: a cap that over-estimates refuses a turn the user could have afforded; a
 * cap that under-estimates lets real money escape. Only one of those is recoverable.
 */
export interface CatalogPriceTier {
  /** The context-token threshold above which these rates apply. */
  readonly aboveContextTokens: number;
  readonly inputPerMtokMicrocents: number;
  readonly outputPerMtokMicrocents: number;
  readonly cachedInputPerMtokMicrocents?: number;
}

/**
 * How a model exposes its reasoning control — **per MODEL, not per provider**, which is the whole point.
 *
 * [ADR-0066](../../../../docs/decisions/0066-normalized-reasoning-effort-control.md) made the native shape a
 * property of the **adapter** and the capability a per-model `boolean`. A boolean cannot say *"this model takes
 * a token budget in [128, 32768] and has no off switch"* — and that inexpressibility shipped as a live bug: our
 * Gemini adapter sends `thinkingLevel` to `gemini-2.5-*`, which Google's docs say **do not support it**. This
 * type is the correction.
 *
 * The three axes are **not** mutually exclusive — `gemini-2.5-flash` has both `toggle` and `budgetTokens`;
 * `claude-sonnet-4-6` has both `effortValues` and `budgetTokens`. An adapter picks the shape it can lower.
 *
 * An **empty** descriptor (`reasoning: {}`) is a real and distinct state: the model *reasons* but exposes **no
 * control** (`deepseek-reasoner`). That is not the same as no reasoning at all — it tells the picker to offer
 * nothing, rather than to offer everything.
 */
export interface ReasoningControls {
  /**
   * The **PROVIDER-WIRE** effort values this model accepts (`none|minimal|low|medium|high|xhigh|max`) — NOT
   * Relavium's normalized {@link ReasoningEffort}. The two vocabularies overlap enough to be dangerous: reading
   * these as our tiers drops `off` from **every** Claude model (where `off` is `thinking:{disabled}`, not an
   * effort value) and drops `off`+`max` from `gpt-5.5`. They are only ever *composed* with an adapter's wire map
   * by `acceptedTiers` — never copied.
   */
  readonly effortValues?: readonly string[];
  /**
   * The token-budget axis, when the model takes one. **`min` is load-bearing**: `gemini-2.5-flash` has `min: 0`
   * (so thinking CAN be disabled) while `gemini-2.5-pro` has `min: 128` (so it **cannot** — Google's docs say
   * "N/A: Cannot disable thinking"). One field, and the `off` tier's availability falls straight out of it. A
   * hand-maintained boolean could never have carried that.
   */
  readonly budgetTokens?: { readonly min: number; readonly max?: number };
  /** The model exposes a plain on/off switch for thinking. */
  readonly toggle?: true;
}

/**
 * One model's metadata, normalized from the upstream catalog — the **generated** replacement for the
 * hand-maintained `MODEL_PRICING` row ([ADR-0071](../../../../docs/decisions/0071-models-dev-as-the-model-metadata-source.md)).
 *
 * Money is **integer micro-cents per million tokens** (1 micro-cent = 1e-8 USD) — no float, ever, on any path
 * that reaches the cost cap.
 */
export interface CatalogModel {
  readonly provider: ProviderId;
  readonly modelId: string;
  readonly displayName: string;
  readonly contextWindowTokens: number;
  /** The model's own output ceiling. Nothing clamps against it today — half of "max tokens errors". */
  readonly maxOutputTokens: number;
  readonly inputPerMtokMicrocents: number;
  readonly outputPerMtokMicrocents: number;
  /**
   * **Absent ≠ 0.** 19 of the ~97 imported models carry no cache-read rate (`gpt-5.4-pro` among them). `0` means
   * *"no discount"* — writing it for an absent rate would bill cached input at **zero**, a silent undercharge in
   * the mechanism this work exists to harden. Absent ⇒ the cost path falls back to the full input rate.
   */
  readonly cachedInputPerMtokMicrocents?: number;
  /** Cache-WRITE, where a provider charges one (Anthropic does). */
  readonly cacheWritePerMtokMicrocents?: number;
  /** Context-size pricing tiers, when the model has them. Absent ⇒ the flat rate applies at every length. */
  readonly contextTiers?: readonly CatalogPriceTier[];
  /** Absent ⇒ the model does not reason. Present-but-empty ⇒ it reasons with **no controllable tier**. */
  readonly reasoning?: ReasoningControls;
  /** Absent ⇒ the model accepts every request parameter (the safe default). Present ⇒ carries only the parameters
   *  the model does NOT accept. See {@link RequestCapabilities}. */
  readonly requestCapabilities?: RequestCapabilities;
  // --- Pure enrichment (ADR-0072 point 5) --------------------------------------------------------------------
  // Descriptive metadata that never reaches the cost cap or the wire. DB-refreshed for every model (a refresh may
  // update these even on a shipped id, unlike the pinned money/wire fields), and every one is absent-tolerant: a
  // consumer with no data degrades to a safe assumption (text-only I/O, unknown cutoff), never an error. Absent
  // throughout the generated snapshot until a models.dev sync populates them.
  /** The input modalities the model accepts (e.g. `['text','image']`). Absent ⇒ unknown; assume text. */
  readonly inputModalities?: readonly string[];
  /** The output modalities the model can produce (e.g. `['text']`). Absent ⇒ unknown; assume text. */
  readonly outputModalities?: readonly string[];
  /** The model's training knowledge cutoff, as upstream states it (e.g. `'2024-10'`). Absent ⇒ unpublished. */
  readonly knowledgeCutoff?: string;
  /** A human description. models.dev publishes none today; carried per the maintainer's request (ADR-0072). */
  readonly description?: string;
}

/**
 * Per-model REQUEST capabilities (ADR-0071 amendment) — whether the model accepts a given request PARAMETER,
 * sourced per-model from models.dev the same way `reasoning` is. `temperature`, `tool_call`, `structured_output`
 * and `attachment` all vary per model WITHIN a single provider (e.g. `gpt-5.6-luna` rejects `temperature` while
 * its siblings accept it), so a provider-wide {@link CapabilityFlags} boolean cannot say what is true — the same
 * shape of problem ADR-0071 fixed for pricing and reasoning. This is DISTINCT from `CapabilityFlags`, and lives
 * here (not on the seam struct) exactly as `reasoning` does.
 *
 * A field is present ONLY when upstream says the model does NOT accept the parameter (`false`); **absent ⇒
 * accepted** — the safe default, so a model we have no data for is never denied a parameter it takes. The adapters
 * WITHHOLD the wire parameter when the flag is `false`, turning a provider 400 into a dropped-and-noted field.
 */
export interface RequestCapabilities {
  /** `false` ⇒ the model rejects a `temperature` parameter (models.dev). Absent ⇒ accepted. */
  readonly temperature?: boolean;
  /** `false` ⇒ the model rejects tool/function-call definitions. Absent ⇒ accepted. */
  readonly toolCall?: boolean;
  /** `false` ⇒ the model rejects a structured-output / response-format request. Absent ⇒ accepted. */
  readonly structuredOutput?: boolean;
  /** `false` ⇒ the model rejects non-text (image/file) input attachments. Absent ⇒ accepted. */
  readonly attachment?: boolean;
}

/** The generated snapshot: canonical model id → its metadata. Keyed by id alone, matching the merge's key. */
export type CatalogSnapshot = Readonly<Record<string, CatalogModel>>;
