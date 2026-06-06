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
 * **Verification.** Anthropic figures are confirmed against the model catalog (claude-api,
 * 2026-05-26). The OpenAI / Gemini / DeepSeek figures are best-known **placeholders — VERIFY
 * against each provider's pricing page before relying on a cost figure**; updating one is a
 * one-line edit. (Gemini's real pricing is context-tiered; the ≤128K tier is used here.)
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
  // --- Anthropic (confirmed: claude-api model catalog, 2026-05-26) ----------------------------
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

  // --- OpenAI (VERIFY against platform.openai.com/pricing) ------------------------------------
  'gpt-4o': {
    provider: 'openai',
    nativeId: 'gpt-4o',
    displayName: 'GPT-4o',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    inputPerMtokMicrocents: usd(2.5),
    outputPerMtokMicrocents: usd(10),
    cachedInputPerMtokMicrocents: usd(1.25), // OpenAI auto-caches; no separate write charge
  },
  'gpt-4o-mini': {
    provider: 'openai',
    nativeId: 'gpt-4o-mini',
    displayName: 'GPT-4o mini',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    inputPerMtokMicrocents: usd(0.15),
    outputPerMtokMicrocents: usd(0.6),
    cachedInputPerMtokMicrocents: usd(0.075),
  },

  // --- Gemini (VERIFY against ai.google.dev/pricing; real pricing is context-tiered) ----------
  'gemini-2.0-flash': {
    provider: 'gemini',
    nativeId: 'gemini-2.0-flash',
    displayName: 'Gemini 2.0 Flash',
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 8_192,
    inputPerMtokMicrocents: usd(0.1),
    outputPerMtokMicrocents: usd(0.4),
    cachedInputPerMtokMicrocents: usd(0.025),
  },
  'gemini-1.5-pro': {
    provider: 'gemini',
    nativeId: 'gemini-1.5-pro',
    displayName: 'Gemini 1.5 Pro',
    contextWindowTokens: 2_097_152,
    maxOutputTokens: 8_192,
    inputPerMtokMicrocents: usd(1.25),
    outputPerMtokMicrocents: usd(5),
    cachedInputPerMtokMicrocents: usd(0.3125),
  },

  // --- DeepSeek (VERIFY against api-docs.deepseek.com; served via the OpenAI-compatible adapter) -
  'deepseek-chat': {
    provider: 'deepseek',
    nativeId: 'deepseek-chat',
    displayName: 'DeepSeek-V3 (chat)',
    contextWindowTokens: 64_000,
    maxOutputTokens: 8_192,
    inputPerMtokMicrocents: usd(0.27),
    outputPerMtokMicrocents: usd(1.1),
    cachedInputPerMtokMicrocents: usd(0.07), // cache-hit input
  },
  'deepseek-reasoner': {
    provider: 'deepseek',
    nativeId: 'deepseek-reasoner',
    displayName: 'DeepSeek-R1 (reasoner)',
    contextWindowTokens: 64_000,
    maxOutputTokens: 8_192,
    inputPerMtokMicrocents: usd(0.55),
    outputPerMtokMicrocents: usd(2.19),
    cachedInputPerMtokMicrocents: usd(0.14),
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
