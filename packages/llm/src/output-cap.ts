import { catalogModel } from './catalog/lookup.js';
import { LlmConfigError } from './errors.js';
import type { LlmRequest, ProviderId } from './types.js';

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

/** Estimate-only fallback; never inserted into an uncapped wire request (ADR-0101). */
export const DEFAULT_OUTPUT_TOKENS_ESTIMATE = 4096;

/** Required keys prevent a hook from silently discarding the native escape hatch. */
export interface OutputCapInputs {
  readonly model: string;
  readonly maxTokens: number | undefined;
  readonly providerOptions: Readonly<Record<string, unknown>> | undefined;
}

export interface OutputCapIdentity extends OutputCapInputs {
  readonly provider: ProviderId;
  readonly endpoint: EndpointKind;
}

export type OutputCapField = 'max_tokens' | 'max_completion_tokens' | 'maxOutputTokens';

/** Ephemeral, factory-created snapshot. Mapped wire/thinking inputs are distinct from reservation. */
export interface PreparedOutputCapPlan extends OutputCapIdentity {
  readonly outputCeiling: number | undefined;
  readonly mappedField: OutputCapField;
  readonly mappedValue: number | undefined;
  readonly nativeOptions: Readonly<Record<string, unknown>> | undefined;
  readonly effectiveCap: number | undefined;
}

const preparedPlans = new WeakSet<object>();
// Original identities are private binding evidence only. Caller-owned objects never reach the wire.
const originalCapInputs = new WeakMap<object, Readonly<Record<string, unknown>> | undefined>();
const CAP_FIELDS: readonly OutputCapField[] = [
  'max_tokens',
  'max_completion_tokens',
  'maxOutputTokens',
];

/** Typed, content-free refusal of a substituted/forged or differently bound plan. */
export class InvalidOutputCapPlanError extends LlmConfigError {
  readonly code = 'invalid_output_cap_plan';

  constructor() {
    super('prepared output cap plan does not match the request and actual endpoint');
    this.name = 'InvalidOutputCapPlanError';
  }
}

export function isPreparedOutputCapPlan(value: unknown): value is PreparedOutputCapPlan {
  return typeof value === 'object' && value !== null && preparedPlans.has(value);
}

function guardCapInspection<T>(inspect: () => T): T {
  try {
    return inspect();
  } catch {
    // Getters, proxy traps and serializers may throw credentials or private request content.
    // Neither the throwable nor its cause may leave the cap inspection boundary.
    throw new InvalidOutputCapPlanError();
  }
}

function clampToCeiling(value: number, ceiling: number | undefined): number {
  return ceiling === undefined ? value : Math.min(value, ceiling);
}

function positiveNativeCap(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function immutableJsonCap(field: OutputCapField, value: unknown): unknown {
  // JSON also invokes BigInt.prototype.toJSON for a primitive BigInt.
  if (
    (typeof value !== 'object' || value === null) &&
    typeof value !== 'function' &&
    typeof value !== 'bigint'
  )
    return value;
  try {
    // A holder preserves the property key supplied to toJSON, unlike stringify(value).
    const parsed: unknown = JSON.parse(JSON.stringify({ [field]: value }));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new InvalidOutputCapPlanError();
    }
    const captured: unknown = Object.getOwnPropertyDescriptor(parsed, field)?.value;
    const pending: unknown[] = [captured];
    while (pending.length > 0) {
      const item = pending.pop();
      if (typeof item !== 'object' || item === null) continue;
      for (const child of Object.values(item)) pending.push(child);
      // Freeze alone leaves inherited toJSON executable during later SDK serialization.
      // JSON arrays keep their array identity and own data with a detached prototype.
      Object.setPrototypeOf(item, null);
      Object.freeze(item);
    }
    return captured;
  } catch {
    throw new InvalidOutputCapPlanError();
  }
}

/** The one lowering policy for all adapters and all reservation consumers (ADR-0071/0101). */
export function prepareOutputCapPlan(info: OutputCapIdentity): PreparedOutputCapPlan {
  return guardCapInspection(() => captureOutputCapPlan(info));
}

function captureOutputCapPlan(info: OutputCapIdentity): PreparedOutputCapPlan {
  const outputCeiling =
    info.endpoint === 'custom' ? undefined : catalogModel(info.model)?.maxOutputTokens;
  const mappedField: OutputCapField =
    info.provider === 'gemini'
      ? 'maxOutputTokens'
      : info.provider === 'openai' && info.endpoint === 'official'
        ? 'max_completion_tokens'
        : 'max_tokens';
  const requested =
    info.provider === 'anthropic'
      ? (info.maxTokens ?? DEFAULT_OUTPUT_TOKENS_ESTIMATE)
      : info.maxTokens;
  const mappedValue =
    requested === undefined ? undefined : clampToCeiling(requested, outputCeiling);
  const discarded = (field: OutputCapField): boolean =>
    // Gemini's SDK drops these foreign config fields before serializing the HTTP body.
    (info.provider === 'gemini' && field !== 'maxOutputTokens') ||
    (mappedValue !== undefined &&
      (info.provider === 'openai' || info.provider === 'deepseek'
        ? field === 'max_tokens' || field === 'max_completion_tokens'
        : field === mappedField));
  let original: Readonly<Record<string, unknown>> | undefined;
  let providerOptions: Readonly<Record<string, unknown>> | undefined;
  try {
    original =
      info.providerOptions === undefined
        ? undefined
        : Object.freeze(
            Object.fromEntries(
              CAP_FIELDS.filter((field) => Object.hasOwn(info.providerOptions ?? {}, field)).map(
                (field) => [field, info.providerOptions?.[field]],
              ),
            ),
          );
    providerOptions =
      original === undefined
        ? undefined
        : Object.freeze(
            Object.fromEntries(
              CAP_FIELDS.filter((field) => Object.hasOwn(original ?? {}, field)).map((field) => {
                const value = original?.[field];
                // Discarded executable/opaque controls need no serialization (even a cycle is harmless).
                const opaque =
                  (typeof value === 'object' && value !== null) ||
                  typeof value === 'function' ||
                  typeof value === 'bigint';
                return [
                  field,
                  discarded(field) && opaque ? undefined : immutableJsonCap(field, value),
                ];
              }),
            ),
          );
  } catch {
    throw new InvalidOutputCapPlanError();
  }
  const native = providerOptions === undefined ? undefined : { ...providerOptions };
  if (native !== undefined) {
    for (const field of CAP_FIELDS) if (discarded(field)) delete native[field];
  }
  let effectiveCap = mappedValue;
  if (effectiveCap === undefined) {
    const nativeFields: readonly OutputCapField[] =
      info.provider === 'gemini'
        ? ['maxOutputTokens']
        : info.provider === 'deepseek' && info.endpoint === 'official'
          ? ['max_tokens']
          : ['max_tokens', 'max_completion_tokens'];
    for (const key of nativeFields) {
      const cap = positiveNativeCap(native?.[key]);
      if (cap !== undefined) effectiveCap = Math.max(effectiveCap ?? 0, cap);
    }
  }
  const plan = Object.freeze({
    model: info.model,
    maxTokens: info.maxTokens,
    providerOptions,
    provider: info.provider,
    endpoint: info.endpoint,
    outputCeiling,
    mappedField,
    mappedValue,
    nativeOptions: native === undefined ? undefined : Object.freeze(native),
    effectiveCap,
  });
  preparedPlans.add(plan);
  originalCapInputs.set(plan, original);
  return plan;
}

/** Preserve current non-cap options while applying the captured cap reconciliation in one home. */
export function outputCapNativeOptions(
  plan: PreparedOutputCapPlan,
  options: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  return guardCapInspection(() => mergeOutputCapNativeOptions(plan, options));
}

function mergeOutputCapNativeOptions(
  plan: PreparedOutputCapPlan,
  options: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (!isPreparedOutputCapPlan(plan)) throw new InvalidOutputCapPlanError();
  if (options === undefined && plan.nativeOptions === undefined) return undefined;
  const merged = { ...options };
  // Native options are body data. An executable outer serializer can replace the entire mapped body.
  if (typeof merged['toJSON'] === 'function') delete merged['toJSON'];
  for (const field of CAP_FIELDS) {
    if (Object.hasOwn(plan.nativeOptions ?? {}, field)) merged[field] = plan.nativeOptions?.[field];
    else delete merged[field];
  }
  return merged;
}

/** A plan may cross awaits, but cannot cross a request-cap or routing identity change. */
export function assertOutputCapPlanMatches(
  plan: PreparedOutputCapPlan,
  info: OutputCapIdentity,
): void {
  guardCapInspection(() => checkOutputCapPlanBinding(plan, info));
}

function checkOutputCapPlanBinding(plan: PreparedOutputCapPlan, info: OutputCapIdentity): void {
  const matches = (expected: Readonly<Record<string, unknown>> | undefined): boolean =>
    CAP_FIELDS.every(
      (field) =>
        Object.hasOwn(expected ?? {}, field) === Object.hasOwn(info.providerOptions ?? {}, field) &&
        Object.is(expected?.[field], info.providerOptions?.[field]),
    );
  if (
    !isPreparedOutputCapPlan(plan) ||
    plan.model !== info.model ||
    plan.provider !== info.provider ||
    plan.endpoint !== info.endpoint ||
    !Object.is(plan.maxTokens, info.maxTokens) ||
    (!matches(plan.providerOptions) && !matches(originalCapInputs.get(plan)))
  ) {
    throw new InvalidOutputCapPlanError();
  }
}

/** Consume a measured candidate's plan unchanged; a different candidate gets its own bound plan. */
export function outputCapPlanForRequest(
  request: LlmRequest,
  provider: ProviderId,
  endpoint: EndpointKind,
): PreparedOutputCapPlan {
  return guardCapInspection(() => findOutputCapPlanForRequest(request, provider, endpoint));
}

function findOutputCapPlanForRequest(
  request: LlmRequest,
  provider: ProviderId,
  endpoint: EndpointKind,
): PreparedOutputCapPlan {
  const info: OutputCapIdentity = {
    model: request.model,
    maxTokens: request.maxTokens,
    providerOptions: request.providerOptions,
    provider,
    endpoint,
  };
  const existing =
    request.preparedOutputCaps?.find(
      (plan) =>
        plan.model === request.model && plan.provider === provider && plan.endpoint === endpoint,
    ) ??
    request.preparedOutputCaps?.find(
      (plan) => plan.model === request.model && plan.provider === provider,
    );
  if (existing !== undefined) {
    assertOutputCapPlanMatches(existing, info);
    return existing;
  }
  return prepareOutputCapPlan(info);
}

/** Stage the cap copy once before admission/key awaits; the wire uses the same copied controls. */
export function prepareOutputCapRequest(
  request: LlmRequest,
  provider: ProviderId,
  endpoint: EndpointKind,
): { readonly request: LlmRequest; readonly plan: PreparedOutputCapPlan } {
  return guardCapInspection(() => stageOutputCapRequest(request, provider, endpoint));
}

function stageOutputCapRequest(
  request: LlmRequest,
  provider: ProviderId,
  endpoint: EndpointKind,
): { readonly request: LlmRequest; readonly plan: PreparedOutputCapPlan } {
  const capCopy: LlmRequest = {
    ...request,
    ...(request.providerOptions === undefined
      ? {}
      : { providerOptions: Object.freeze({ ...request.providerOptions }) }),
  };
  const plan = outputCapPlanForRequest(capCopy, provider, endpoint);
  const options =
    capCopy.providerOptions === undefined ? undefined : { ...capCopy.providerOptions };
  if (options !== undefined) {
    for (const field of CAP_FIELDS) {
      if (Object.hasOwn(plan.providerOptions ?? {}, field))
        options[field] = plan.providerOptions?.[field];
      else delete options[field];
    }
  }
  const staged: LlmRequest = {
    ...capCopy,
    ...(options === undefined ? {} : { providerOptions: Object.freeze(options) }),
    preparedOutputCaps: [plan],
  };
  return { request: Object.freeze(staged), plan };
}

/** A known cap wins; an uncapped estimate is clamped only against the captured official ceiling. */
export function outputTokensReservation(
  plan: PreparedOutputCapPlan,
  configuredFallback: number | undefined,
): number {
  if (!isPreparedOutputCapPlan(plan)) throw new InvalidOutputCapPlanError();
  return (
    plan.effectiveCap ??
    clampToCeiling(configuredFallback ?? DEFAULT_OUTPUT_TOKENS_ESTIMATE, plan.outputCeiling)
  );
}

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
