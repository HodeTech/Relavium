import type { MediaBilledModality } from '@relavium/shared';

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
 * used here. **DeepSeek re-verified 2026-07-03** (api-docs.deepseek.com/quick_start/pricing): the current ids
 * are `deepseek-v4-flash` (default) and `deepseek-v4-pro` (premium), each serving non-thinking + thinking on one
 * id; the legacy `deepseek-chat`/`-reasoner` aliases deprecate 2026-07-24 15:59 UTC (re-verify / remove then).
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
  /**
   * ISO-8601 date this model is scheduled to retire, if any (ADR-0064 §7). The pure {@link mergeModelCatalog}
   * flags an entry `deprecated` once `now >= deprecatedAt` (unioned with a live-list deprecation date, taking
   * the earlier). The picker flags a deprecated model but never forbids it — a legacy alias still costs
   * correctly until its date. Absent ⇒ not deprecated.
   */
  readonly deprecatedAt?: string;
  /**
   * Per-modality media **output** rates (1.AF/D17,
   * [ADR-0044](../../../docs/decisions/0044-media-access-governance-read-media-save-to-cost.md) §3) — integer
   * micro-cents per billed unit: `image` per image (the unit is a count), `audio`/`video` per second. The
   * keys are exactly the `MEDIA_BILLED_MODALITIES` (`document`/PDF bills as tokens, so it is excluded). A
   * **missing** modality rate (or an absent `mediaOutputRates`) means the model has no metered media rate —
   * the realized fold and the pre-egress estimate **degrade to 0** for it (H4: never hard-fail a valid run on
   * a missing rate), and a token-count audio unit from a token-based provider stays observability-only until a
   * per-count rate exists. No 1.AF model emits billed media output, so every row leaves this undefined; the
   * shape is the seam for the model catalog's media rates.
   */
  // Keyed by the canonical `MediaBilledModality` set (image/audio/video) via a mapped type, so the keys
  // stay in sync with `MEDIA_BILLED_MODALITIES` at compile time — never a hand-maintained literal.
  readonly mediaOutputRates?: { readonly [K in MediaBilledModality]?: number };
  /**
   * Whether this model supports a reasoning-effort control ([ADR-0066](../../../docs/decisions/0066-normalized-reasoning-effort-control.md)) —
   * the static per-model capability the host projects to `resolveReasoning` (gating whether `reasoningEffort` is
   * sent + whether the picker offers the effort selector). **Opt-in**: absent ⇒ `false` (the SAFE default — a
   * non-reasoning model must never receive the field). Set `true` only for a model whose adapter maps the tier
   * (so DeepSeek stays absent until its adapter mapping lands, even though v4 reasons — the effort is not
   * controllable there yet).
   */
  readonly reasoning?: boolean;
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
    reasoning: true,
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
    reasoning: true,
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
    reasoning: true,
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
    reasoning: true,
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
    reasoning: true,
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
    reasoning: true,
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
    reasoning: true,
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
    reasoning: true,
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 65_536,
    inputPerMtokMicrocents: usd(1.25), // prompts ≤200K tier (>200K: $2.50 in / $15 out)
    outputPerMtokMicrocents: usd(10),
    cachedInputPerMtokMicrocents: usd(0.125),
  },

  // --- DeepSeek (verified 2026-07-03: api-docs.deepseek.com/quick_start/pricing; via the OpenAI-compatible
  // adapter) — the current ids are `deepseek-v4-flash` (default tier) and `deepseek-v4-pro` (premium tier). Each
  // serves BOTH non-thinking and thinking (default) modes on ONE id — the mode is a request param, not a
  // separate model — so there is no per-mode row. Reasoning-effort IS controllable (ADR-0066): the create-chat-
  // completion API takes a `thinking` object (`type: enabled|disabled` + `reasoning_effort: high|max`), mapped in
  // openai.ts (`reasoning: true` below). The legacy `deepseek-chat` (non-thinking) / `deepseek-reasoner` (thinking)
  // aliases are kept below until they deprecate on 2026-07-24 15:59 UTC and stay reasoning-uncontrollable.
  'deepseek-v4-flash': {
    provider: 'deepseek',
    nativeId: 'deepseek-v4-flash',
    displayName: 'DeepSeek-V4-Flash',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000,
    inputPerMtokMicrocents: usd(0.14),
    outputPerMtokMicrocents: usd(0.28),
    cachedInputPerMtokMicrocents: usd(0.0028), // cache-hit input
    reasoning: true, // ADR-0066: v4 exposes a controllable `thinking` param (off / high / max)
  },
  'deepseek-v4-pro': {
    provider: 'deepseek',
    nativeId: 'deepseek-v4-pro',
    displayName: 'DeepSeek-V4-Pro',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000,
    inputPerMtokMicrocents: usd(0.435),
    outputPerMtokMicrocents: usd(0.87),
    cachedInputPerMtokMicrocents: usd(0.003625), // cache-hit input
    reasoning: true, // ADR-0066: v4 exposes a controllable `thinking` param (off / high / max)
  },
  // Legacy aliases — deprecating 2026-07-24 15:59 UTC. Kept so an existing agent/config that still names them
  // keeps costing correctly until then; the pricing page no longer lists them, so these hold the last verified
  // (2026-06-11) values — re-verify or remove at deprecation.
  'deepseek-chat': {
    provider: 'deepseek',
    nativeId: 'deepseek-chat',
    displayName: 'DeepSeek-V4-Flash (chat, legacy)',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000,
    inputPerMtokMicrocents: usd(0.14),
    outputPerMtokMicrocents: usd(0.28),
    cachedInputPerMtokMicrocents: usd(0.0028), // cache-hit input
    deprecatedAt: '2026-07-24T15:59:00Z', // legacy alias retires 2026-07-24 15:59 UTC (see header)
  },
  'deepseek-reasoner': {
    provider: 'deepseek',
    nativeId: 'deepseek-reasoner',
    displayName: 'DeepSeek-V4-Flash (reasoner, legacy)',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000,
    // The thinking-mode alias of v4-flash — thinking is a request PARAM, not a separate model, so it bills at the
    // SAME v4-flash rate as `deepseek-chat` (the prior 0.435/0.87 was a stale R1-era carryover from before v4).
    inputPerMtokMicrocents: usd(0.14),
    outputPerMtokMicrocents: usd(0.28),
    cachedInputPerMtokMicrocents: usd(0.0028),
    deprecatedAt: '2026-07-24T15:59:00Z', // legacy alias retires 2026-07-24 15:59 UTC (see header)
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

/**
 * A CONSERVATIVE model-id reasoning heuristic ([ADR-0066](../../../docs/decisions/0066-normalized-reasoning-effort-control.md) §4)
 * — the second arm of {@link modelSupportsReasoning}, applied ONLY to an id absent from the static registry (a
 * live-discovered model whose list endpoint omits a reasoning flag). Each arm is a family/pattern where the WHOLE
 * matched set reasons, so a new member of a known reasoning family (e.g. a next o-series id) gates correctly before
 * the registry is updated. Deliberately **narrow**: it does NOT prefix-match ambiguous families whose lineup mixes
 * reasoning and non-reasoning members by *version* (base Claude Sonnet, Gemini by version), because OVER-matching
 * would send the tier to a non-reasoning model and earn a provider rejection — strictly worse than the safe
 * under-match (no effort UX until the registry adds the model, the same maintenance shape as pricing). DeepSeek IS
 * matched, but only the `deepseek-v[4-9]` prefix (whose whole set serves the `thinking` param); its legacy
 * `deepseek-chat`/`-reasoner` aliases are not `v`-prefixed, so they never match. The `-chat` exclusion keeps
 * OpenAI's non-reasoning `gpt-5-chat` conversational variant — and any future `deepseek-v_-chat` non-thinking
 * variant — out.
 */
export function reasoningModelIdHeuristic(model: string): boolean {
  const m = model.toLowerCase();
  if (/^o\d/.test(m)) return true; // OpenAI o-series (o1 / o3 / o4 / o5+) — the entire family reasons
  if (m.startsWith('gpt-5') && !m.includes('chat')) return true; // the reasoning gpt-5 line (gpt-5-chat is non-reasoning)
  if (m.startsWith('claude-opus')) return true; // Claude Opus reasons (extended thinking)
  if (/^deepseek-v[4-9]/.test(m) && !m.includes('chat')) return true; // DeepSeek v4+ serves the `thinking` param; a future `-chat` non-thinking variant stays out (ADR-0066 §4)
  if (m.includes('thinking')) return true; // an explicit "thinking" model id (e.g. a Gemini thinking variant)
  return false;
}

/**
 * Whether a model supports a reasoning-effort control ([ADR-0066](../../../docs/decisions/0066-normalized-reasoning-effort-control.md)
 * §4) — the per-model capability the host projects to the engine's `resolveReasoning` gate (and the `/models`
 * picker's effort selector). The STATIC registry is authoritative for a canonical id (its `reasoning` flag, `true`
 * OR `false` — so an explicit non-reasoning member always wins); a NON-registry id (a live-discovered model) falls
 * back to the conservative {@link reasoningModelIdHeuristic}. A pure host-side helper, like {@link contextWindowForModel}.
 */
export function modelSupportsReasoning(model: string): boolean {
  if (isCanonicalModelId(model)) {
    // Widen the literal-union entry to `ModelPricing` so `.reasoning` (absent on the non-reasoning members) reads as
    // `boolean | undefined` — each entry `satisfies ModelPricing`, so this is assignment, not a cast. The registry
    // is authoritative for a known id, so a false/absent flag is NOT overridden by the id heuristic.
    const entry: ModelPricing = MODEL_PRICING[model];
    return entry.reasoning === true;
  }
  return reasoningModelIdHeuristic(model);
}

/**
 * The context window (max tokens) for a canonical model id, or `undefined` for an unknown id (e.g. a custom
 * base-URL model absent from the catalog). A light, pure host-side helper — the SAME catalog value the adapters'
 * `LlmProvider.contextLimit` returns — for UI that needs the window WITHOUT going through the provider seam: the
 * ADR-0062 §7 footer context-fullness indicator (last input tokens ÷ window). A custom-model `undefined` degrades
 * the indicator to "not shown", exactly as it degrades auto-compaction (ADR-0062 §5).
 */
export function contextWindowForModel(model: string): number | undefined {
  return isCanonicalModelId(model) ? MODEL_PRICING[model].contextWindowTokens : undefined;
}
