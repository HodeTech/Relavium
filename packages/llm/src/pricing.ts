import type { ProviderId } from './types.js';

/**
 * The canonical model-pricing table — the in-code **source of truth** the adapters (1.C/1.G/1.H)
 * and the `CostTracker` (1.B) share, keyed on canonical model id. `model_catalog`
 * ([database-schema.md](../../../docs/reference/desktop/database-schema.md)) ships empty and is a
 * display projection *seeded from here*. Prices are **integer micro-cents per million tokens**
 * (1 micro-cent = 1e-8 USD) — no float, ever. The `input` / `output` / `cachedInput` prices map to
 * the DB's `*_per_mtok_microcents` columns; `cacheWrite` (Anthropic-only) is **in-code only** —
 * there is no `model_catalog` cache-write column, so it is never seeded or persisted.
 *
 * USD/MTok → micro-cents/MTok is `usd × 1e8` (e.g. $5.00 → 500_000_000).
 *
 * **Verification (2026-06-11).** Every row verified against the provider's live pricing page:
 * Anthropic via the claude-api pricing page (Opus 4.8 / Sonnet 4.6 / Haiku 4.5 unchanged; the
 * flagship **Claude Fable 5** added); OpenAI (developers.openai.com), Gemini (ai.google.dev), and
 * DeepSeek (api-docs.deepseek.com) re-fetched the same day. The prior
 * `gpt-4o` / `gpt-4o-mini` / `gemini-2.0-flash` / `gemini-1.5-pro` rows were retired — shut down or
 * removed from the provider catalogs — and replaced with the current flagship/mini and Pro/Flash
 * models. Gemini Pro/Flash are context-tiered: the ≤200K (Pro) and text/image/video (Flash) tier is
 * used here. DeepSeek's `deepseek-chat`/`-reasoner` ids alias `deepseek-v4-flash` (non-thinking /
 * thinking) and are scheduled for deprecation on 2026-07-24 — re-verify then.
 */

export interface ModelPricing {
  /** The seam provider this model belongs to. */
  readonly provider: ProviderId;
  /** The provider-native model id the adapter sends (often equal to the canonical key). */
  readonly nativeId: string;
  readonly displayName: string;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly inputPerMtokMicrocents: number;
  readonly outputPerMtokMicrocents: number;
  /** Cache-read (cached-input) price; 0 when the provider does not discount cache reads. */
  readonly cachedInputPerMtokMicrocents: number;
  /** Cache-write price, where the provider charges one (Anthropic does); undefined otherwise. */
  readonly cacheWritePerMtokMicrocents?: number;
}

const USD_PER_MTOK_TO_MICROCENTS = 100_000_000; // 1 USD = 1e8 micro-cents
/** USD-per-million-tokens → integer micro-cents-per-million-tokens. */
const usd = (perMtok: number): number => Math.round(perMtok * USD_PER_MTOK_TO_MICROCENTS);

/** Canonical model id → pricing. The canonical id is what an authored agent/workflow names. */
export const MODEL_PRICING = {
  // --- Anthropic (verified 2026-06-11: platform.claude.com pricing page) ----------------------
  'claude-fable-5': {
    provider: 'anthropic',
    nativeId: 'claude-fable-5',
    displayName: 'Claude Fable 5',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    inputPerMtokMicrocents: usd(10),
    outputPerMtokMicrocents: usd(50),
    cachedInputPerMtokMicrocents: usd(1), // cache read = 0.1× input
    cacheWritePerMtokMicrocents: usd(12.5), // cache write (5-min TTL) = 1.25× input
  },
  'claude-opus-4-8': {
    provider: 'anthropic',
    nativeId: 'claude-opus-4-8',
    displayName: 'Claude Opus 4.8',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    inputPerMtokMicrocents: usd(5),
    outputPerMtokMicrocents: usd(25),
    cachedInputPerMtokMicrocents: usd(0.5), // cache read = 0.1× input
    cacheWritePerMtokMicrocents: usd(6.25), // cache write (5-min TTL) = 1.25× input
  },
  'claude-sonnet-4-6': {
    provider: 'anthropic',
    nativeId: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 64_000,
    inputPerMtokMicrocents: usd(3),
    outputPerMtokMicrocents: usd(15),
    cachedInputPerMtokMicrocents: usd(0.3),
    cacheWritePerMtokMicrocents: usd(3.75),
  },
  'claude-haiku-4-5': {
    provider: 'anthropic',
    nativeId: 'claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5',
    contextWindowTokens: 200_000,
    maxOutputTokens: 64_000,
    inputPerMtokMicrocents: usd(1),
    outputPerMtokMicrocents: usd(5),
    cachedInputPerMtokMicrocents: usd(0.1),
    cacheWritePerMtokMicrocents: usd(1.25),
  },

  // --- OpenAI (verified 2026-06-11: developers.openai.com/api/docs/pricing) -------------------
  'gpt-5.5': {
    provider: 'openai',
    nativeId: 'gpt-5.5',
    displayName: 'GPT-5.5',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    inputPerMtokMicrocents: usd(5),
    outputPerMtokMicrocents: usd(30),
    cachedInputPerMtokMicrocents: usd(0.5), // OpenAI auto-caches; no separate write charge
  },
  'gpt-5.4-mini': {
    provider: 'openai',
    nativeId: 'gpt-5.4-mini',
    displayName: 'GPT-5.4 mini',
    contextWindowTokens: 400_000,
    maxOutputTokens: 128_000,
    inputPerMtokMicrocents: usd(0.75),
    outputPerMtokMicrocents: usd(4.5),
    cachedInputPerMtokMicrocents: usd(0.075),
  },

  // --- Gemini (verified 2026-06-11: ai.google.dev/gemini-api/docs/pricing; context-tiered) ----
  'gemini-2.5-flash': {
    provider: 'gemini',
    nativeId: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 65_536,
    inputPerMtokMicrocents: usd(0.3), // text/image/video tier (audio: $1.00/MTok)
    outputPerMtokMicrocents: usd(2.5),
    cachedInputPerMtokMicrocents: usd(0.03),
  },
  'gemini-2.5-pro': {
    provider: 'gemini',
    nativeId: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 65_536,
    inputPerMtokMicrocents: usd(1.25), // prompts ≤200K tier (>200K: $2.50 in / $15 out)
    outputPerMtokMicrocents: usd(10),
    cachedInputPerMtokMicrocents: usd(0.125),
  },

  // --- DeepSeek (verified 2026-06-11: api-docs.deepseek.com; via the OpenAI-compatible adapter) -
  // deepseek-chat/-reasoner alias deepseek-v4-flash (non-thinking / thinking); deprecating 2026-07-24.
  'deepseek-chat': {
    provider: 'deepseek',
    nativeId: 'deepseek-chat',
    displayName: 'DeepSeek-V4-Flash (chat)',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000,
    inputPerMtokMicrocents: usd(0.14),
    outputPerMtokMicrocents: usd(0.28),
    cachedInputPerMtokMicrocents: usd(0.0028), // cache-hit input
  },
  'deepseek-reasoner': {
    provider: 'deepseek',
    nativeId: 'deepseek-reasoner',
    displayName: 'DeepSeek-V4-Flash (reasoner)',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000,
    inputPerMtokMicrocents: usd(0.435),
    outputPerMtokMicrocents: usd(0.87),
    cachedInputPerMtokMicrocents: usd(0.003625),
  },
} as const satisfies Readonly<Record<string, ModelPricing>>;

/** The canonical model ids the pricing table covers. */
export type CanonicalModelId = keyof typeof MODEL_PRICING;

const CANONICAL_MODEL_IDS = new Set<string>(Object.keys(MODEL_PRICING));

/**
 * Type guard: is `value` a canonical model id the pricing table covers? Backed by a `Set` of own
 * keys, so it is immune to prototype-chain keys (`'toString'`, `'constructor'`, …) — unlike `in`.
 */
export function isCanonicalModelId(value: string): value is CanonicalModelId {
  return CANONICAL_MODEL_IDS.has(value);
}

/** Every canonical model id, for diagnostics (e.g. the unknown-model error). */
export const KNOWN_MODEL_IDS: readonly CanonicalModelId[] =
  Object.keys(MODEL_PRICING).filter(isCanonicalModelId);
