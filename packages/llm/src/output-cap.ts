import { catalogModel } from './catalog/lookup.js';
import { requestSupportReason } from './capabilities.js';
import { LlmConfigError, UnsupportedRequestDataError } from './errors.js';
import { copyInertDataInto } from './inert-data.js';
import type { CapabilityFlags, LlmRequest, ProviderId } from './types.js';
import type { EndpointKind } from '@relavium/shared';

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
export type { EndpointKind } from '@relavium/shared';

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
  const owned = ownedRequests.get(request);
  if (owned !== undefined) return assertOwnedRequestBinding(request, provider, endpoint);
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

/** Internal ownership construction; no candidate's routing identity is inferred from a model. */
export interface RequestCandidate {
  readonly model: string;
  readonly provider: ProviderId;
  readonly endpoint: EndpointKind;
}

/** Opaque factory handle. Only selected projections are dispatchable LlmRequests. */
export interface OwnedLlmRequest {
  readonly candidates: readonly RequestCandidate[];
}

interface CandidateOutcome {
  readonly candidate: RequestCandidate;
  // Absence is a fixed, content-free capture failure. It is never an exclusion reason.
  readonly plan: PreparedOutputCapPlan | undefined;
}

interface OwnedRequestState {
  readonly payload: LlmRequest;
  readonly outcomes: readonly CandidateOutcome[];
  readonly projections: Map<CandidateOutcome, LlmRequest>;
  readonly optionsAliased: boolean;
}

const ownedHandles = new WeakMap<object, OwnedRequestState>();
const ownedRequests = new WeakMap<
  object,
  { readonly state: OwnedRequestState; readonly outcome: CandidateOutcome }
>();
const requestExceptions = new Set(['signal', 'preparedOutputCaps']);
const preparedPlanArrays = new WeakSet<object>();

function sameCandidate(left: RequestCandidate, right: RequestCandidate): boolean {
  return (
    left.model === right.model &&
    left.provider === right.provider &&
    left.endpoint === right.endpoint
  );
}

function candidateOutcome(state: OwnedRequestState, candidate: RequestCandidate): CandidateOutcome {
  const outcome = state.outcomes.find((item) => sameCandidate(item.candidate, candidate));
  if (outcome === undefined) throw new InvalidOutputCapPlanError();
  return outcome;
}

function ownedState(source: OwnedLlmRequest | LlmRequest): OwnedRequestState {
  const state = ownedHandles.get(source) ?? ownedRequests.get(source)?.state;
  if (state === undefined) throw new InvalidOutputCapPlanError();
  return state;
}

/**
 * Applicability precedes cap selection. Delegate to the existing capability authority without
 * exposing a capless dispatchable request or surfacing a failed, unsupported candidate's cap.
 * Cooldown and attempt policy remain the caller's responsibility; cooldown is not a quote exclusion.
 */
export function ownedRequestSupportReason(
  source: OwnedLlmRequest | LlmRequest,
  candidate: RequestCandidate,
  supports: CapabilityFlags,
): string | null {
  const state = ownedState(source);
  const outcome = candidateOutcome(state, candidate);
  return requestSupportReason(
    supports,
    { ...state.payload, model: outcome.candidate.model },
    {
      catalogAuthoritative: outcome.candidate.endpoint === 'official',
    },
  );
}

/** Cancellation stays observable even when the first configured candidate has a failed cap. */
export function ownedRequestSignal(source: OwnedLlmRequest | LlmRequest): LlmRequest['signal'] {
  return ownedState(source).payload.signal;
}

/** Inspect root descriptors without invoking any request getter or dropping future fields. */
function requestDescriptors(request: LlmRequest): LlmRequest {
  try {
    const target: LlmRequest = { model: '', messages: [] };
    Object.setPrototypeOf(target, null);
    const prototype: unknown = Object.getPrototypeOf(request);
    if (prototype !== null && prototype !== Object.prototype)
      throw new UnsupportedRequestDataError();
    for (const key of Reflect.ownKeys(request)) {
      const descriptor = Object.getOwnPropertyDescriptor(request, key);
      if (
        typeof key !== 'string' ||
        key === '__proto__' ||
        descriptor === undefined ||
        !descriptor.enumerable ||
        !('value' in descriptor)
      )
        throw new UnsupportedRequestDataError();
      Object.defineProperty(target, key, {
        value: descriptor.value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return target;
  } catch {
    throw new UnsupportedRequestDataError();
  }
}

function capOmissions(options: Readonly<Record<string, unknown>>): ReadonlySet<string> {
  try {
    const omitted = new Set<string>(CAP_FIELDS);
    const serializer = Object.getOwnPropertyDescriptor(options, 'toJSON');
    // This is the existing outer-option serializer discard, not a generic serializer privilege.
    if (serializer !== undefined && 'value' in serializer && typeof serializer.value === 'function')
      omitted.add('toJSON');
    return omitted;
  } catch {
    throw new UnsupportedRequestDataError();
  }
}

function incomingPlans(request: LlmRequest): readonly PreparedOutputCapPlan[] {
  return guardCapInspection(() => {
    if (request.preparedOutputCaps === undefined) return [];
    const source = request.preparedOutputCaps;
    if (!Array.isArray(source) || Object.getPrototypeOf(source) !== Array.prototype)
      throw new InvalidOutputCapPlanError();
    const length: unknown = Object.getOwnPropertyDescriptor(source, 'length')?.value;
    if (
      typeof length !== 'number' ||
      !Number.isInteger(length) ||
      length < 0 ||
      length > 0xffff_ffff
    )
      throw new InvalidOutputCapPlanError();
    const plans: PreparedOutputCapPlan[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(source, String(index));
      const value: unknown =
        descriptor !== undefined && descriptor.enumerable && 'value' in descriptor
          ? descriptor.value
          : undefined;
      if (!isPreparedOutputCapPlan(value)) throw new InvalidOutputCapPlanError();
      plans.push(value);
    }
    for (const key of Reflect.ownKeys(source)) {
      if (key === 'length') continue;
      if (key === 'toJSON' && preparedPlanArrays.has(source)) continue;
      if (
        typeof key !== 'string' ||
        !Number.isSafeInteger(Number(key)) ||
        Number(key) < 0 ||
        String(Number(key)) !== key ||
        Number(key) >= length
      )
        throw new InvalidOutputCapPlanError();
    }
    return plans;
  });
}

function originalControlsMatch(plan: PreparedOutputCapPlan, request: LlmRequest): boolean {
  return guardCapInspection(() =>
    CAP_FIELDS.every((field) => {
      const original = originalCapInputs.get(plan);
      return (
        Object.hasOwn(original ?? {}, field) ===
          Object.hasOwn(request.providerOptions ?? {}, field) &&
        Object.is(original?.[field], request.providerOptions?.[field])
      );
    }),
  );
}

function handleFor(state: OwnedRequestState): OwnedLlmRequest {
  const handle: OwnedLlmRequest = Object.freeze({
    candidates: Object.freeze(state.outcomes.map((outcome) => outcome.candidate)),
  });
  ownedHandles.set(handle, state);
  return handle;
}

function requestState(
  payload: LlmRequest,
  outcomes: readonly CandidateOutcome[],
): OwnedRequestState {
  return { payload, outcomes, projections: new Map(), optionsAliased: optionsAreAliased(payload) };
}

/** Only the owned graph is inspected here; live cancellation is never traversed. */
function optionsAreAliased(payload: LlmRequest): boolean {
  const options = payload.providerOptions;
  if (options === undefined) return false;
  const pending: object[] = [payload];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const source = pending.pop();
    if (source === undefined || seen.has(source)) continue;
    seen.add(source);
    for (const key of Object.keys(source)) {
      if (source === payload && requestExceptions.has(key)) continue;
      const value: unknown = Object.getOwnPropertyDescriptor(source, key)?.value;
      if (value === options && (source !== payload || key !== 'providerOptions')) return true;
      if (typeof value === 'object' && value !== null) pending.push(value);
    }
  }
  return false;
}

/**
 * A cap exception belongs only to its provider-options slot. If the options container is also
 * ordinary payload, own its COMPLETE inert data graph instead: discarding/projecting a cap on
 * that shared container would silently rewrite a tool result, schema or future request field.
 * The first traversal detects and validates such aliases; the full capture keeps one final memo.
 */
function captureRequestData(request: LlmRequest, inspected: LlmRequest): LlmRequest {
  const omissions = new Map<object, ReadonlySet<string>>([[request, requestExceptions]]);
  const edges = new Map<object, { readonly parent: object; readonly key: string }>();
  const aliases = new Set<object>();
  if (inspected.providerOptions !== undefined) {
    omissions.set(inspected.providerOptions, capOmissions(inspected.providerOptions));
    edges.set(inspected.providerOptions, { parent: request, key: 'providerOptions' });
  }
  const payload: LlmRequest = { model: '', messages: [] };
  const live = Object.hasOwn(inspected, 'signal') ? { signal: inspected.signal } : {};
  const additions = new Map([[request, live]]);
  copyInertDataInto(request, payload, true, omissions, additions, edges, aliases);
  if (inspected.providerOptions === undefined || !aliases.has(inspected.providerOptions))
    return payload;
  const complete: LlmRequest = { model: '', messages: [] };
  copyInertDataInto(request, complete, true, new Map([[request, requestExceptions]]), additions);
  return complete;
}

/**
 * Only an exact immutable factory request may use an accepted generic captured-options view.
 * The native cap projection remains in its genuine plan; public metadata/spreads cannot transfer
 * this association. Model, canonical cap, provider, endpoint and owned-view identity still bind.
 */
function assertOwnedRequestBinding(
  request: LlmRequest,
  provider: ProviderId,
  endpoint: EndpointKind,
): PreparedOutputCapPlan {
  const owned = ownedRequests.get(request);
  if (owned === undefined) throw new InvalidOutputCapPlanError();
  const outcome = candidateOutcome(owned.state, { model: request.model, provider, endpoint });
  const plan = outcome.plan;
  if (plan === undefined || outcome !== owned.outcome) throw new InvalidOutputCapPlanError();
  if (owned.state.optionsAliased) {
    if (
      !isPreparedOutputCapPlan(plan) ||
      !sameCandidate(plan, outcome.candidate) ||
      !Object.is(request.maxTokens, plan.maxTokens) ||
      request.providerOptions !== owned.state.payload.providerOptions
    )
      throw new InvalidOutputCapPlanError();
  } else {
    assertOutputCapPlanMatches(plan, {
      model: request.model,
      maxTokens: request.maxTokens,
      providerOptions: request.providerOptions,
      provider,
      endpoint,
    });
  }
  return plan;
}

/**
 * Own all non-cap fields and eagerly capture every configured candidate before the first await.
 * Incoming plans are checked against ORIGINAL controls before any captured projection is installed.
 * Candidate-local failures remain private until selection (including quote selection) requires them.
 */
export function ownLlmRequest(
  request: LlmRequest,
  candidates: readonly RequestCandidate[],
): OwnedLlmRequest {
  const prior = ownedRequests.get(request);
  if (prior !== undefined) {
    for (const candidate of candidates) candidateOutcome(prior.state, candidate);
    return handleFor(prior.state);
  }
  const inspected = requestDescriptors(request);
  // Repeated chain entries retain their attempt policy outside ownership, but one identity has
  // one captured construction. In particular a stateful serializer is not recaptured for it.
  const configured: RequestCandidate[] = [];
  for (const candidate of candidates) {
    if (configured.some((existing) => sameCandidate(existing, candidate))) continue;
    configured.push(
      Object.freeze({
        model: candidate.model,
        provider: candidate.provider,
        endpoint: candidate.endpoint,
      }),
    );
  }
  const plans = incomingPlans(inspected);
  for (const plan of plans) {
    const candidate = configured.find((item) => sameCandidate(item, plan));
    if (candidate === undefined || plans.filter((item) => sameCandidate(item, plan)).length !== 1)
      throw new InvalidOutputCapPlanError();
    assertOutputCapPlanMatches(plan, {
      ...candidate,
      maxTokens: inspected.maxTokens,
      providerOptions: inspected.providerOptions,
    });
  }
  const payload = captureRequestData(request, inspected);
  // A public captured projection cannot reconstruct the controls discarded by another dialect.
  // Only our private association can carry the other already-captured candidate plans across it.
  const hasOriginalControls = plans.every((plan) => originalControlsMatch(plan, inspected));
  const outcomes = configured.map((candidate): CandidateOutcome => {
    const measured = plans.find((plan) => sameCandidate(candidate, plan));
    if (measured !== undefined) return { candidate, plan: measured };
    if (!hasOriginalControls) return { candidate, plan: undefined };
    try {
      return {
        candidate,
        plan: prepareOutputCapPlan({
          ...candidate,
          maxTokens: payload.maxTokens,
          providerOptions: inspected.providerOptions,
        }),
      };
    } catch {
      return { candidate, plan: undefined };
    }
  });
  return handleFor(requestState(payload, outcomes));
}

/** Cap JSON was already serialized at its real property key; copying must not reinterpret it. */
function mutableCapData(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const create = (source: object): object => {
    const target: object = Array.isArray(source) ? [] : {};
    Object.setPrototypeOf(target, null);
    return target;
  };
  const root = create(value);
  const pending = [{ source: value, target: root }];
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === undefined) break;
    for (const key of Object.keys(item.source)) {
      const child: unknown = Object.getOwnPropertyDescriptor(item.source, key)?.value;
      const target = typeof child === 'object' && child !== null ? create(child) : child;
      Object.defineProperty(item.target, key, {
        value: target,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      if (
        typeof child === 'object' &&
        child !== null &&
        typeof target === 'object' &&
        target !== null
      )
        pending.push({ source: child, target });
    }
  }
  return root;
}

/** SDK-only working controls; reconciliation still belongs to the single cap authority. */
export function mutableOutputCapNativeOptions(
  plan: PreparedOutputCapPlan,
  options: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  const merged = outputCapNativeOptions(plan, options);
  if (merged === undefined) return undefined;
  // Non-cap references already belong to one mutable request graph. Keep those aliases while
  // copying the separately serialized cap values, rather than reinstalling frozen SDK inputs.
  Object.setPrototypeOf(merged, null);
  for (const field of CAP_FIELDS) {
    if (Object.hasOwn(plan.nativeOptions ?? {}, field)) {
      Object.defineProperty(merged, field, {
        value: mutableCapData(plan.nativeOptions?.[field]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return merged;
}

function projectRequest(
  payload: LlmRequest,
  outcome: CandidateOutcome,
  freeze: boolean,
  sharePayload: boolean = false,
  preserveOptions: boolean = false,
): LlmRequest {
  const plan = outcome.plan;
  if (plan === undefined) throw new InvalidOutputCapPlanError();
  const root: LlmRequest = { model: '', messages: [] };
  const omissions = new Map<object, ReadonlySet<string>>([[payload, requestExceptions]]);
  const additions = new Map<object, Readonly<Record<string, unknown>>>();
  const preparedOutputCaps = [plan];
  Object.defineProperty(preparedOutputCaps, 'toJSON', { value: undefined, enumerable: false });
  preparedPlanArrays.add(preparedOutputCaps);
  Object.freeze(preparedOutputCaps);
  if (sharePayload && freeze && !Array.isArray(payload.providerOptions)) {
    const request: LlmRequest = { ...payload, model: outcome.candidate.model, preparedOutputCaps };
    Object.setPrototypeOf(request, null);
    if (payload.providerOptions !== undefined && !preserveOptions) {
      const options = { ...payload.providerOptions, ...plan.providerOptions };
      Object.setPrototypeOf(options, null);
      request.providerOptions = Object.freeze(options);
    }
    return Object.freeze(request);
  }
  additions.set(payload, {
    model: outcome.candidate.model,
    preparedOutputCaps,
    ...(Object.hasOwn(payload, 'signal') ? { signal: payload.signal } : {}),
  });
  if (payload.providerOptions !== undefined && !preserveOptions) {
    omissions.set(payload.providerOptions, capOmissions(payload.providerOptions));
    const caps: Record<string, unknown> = {};
    Object.setPrototypeOf(caps, null);
    for (const field of CAP_FIELDS) {
      if (Object.hasOwn(plan.providerOptions ?? {}, field))
        caps[field] = freeze
          ? plan.providerOptions?.[field]
          : mutableCapData(plan.providerOptions?.[field]);
    }
    additions.set(payload.providerOptions, caps);
  }
  copyInertDataInto(payload, root, freeze, omissions, additions);
  return root;
}

/** Quote callers must select every applicable configured candidate; a failure is not a skip. */
export function selectOwnedRequest(
  source: OwnedLlmRequest | LlmRequest,
  candidate: RequestCandidate,
): { readonly request: LlmRequest; readonly plan: PreparedOutputCapPlan } {
  const state = ownedState(source);
  const outcome = candidateOutcome(state, candidate);
  const plan = outcome.plan;
  if (plan === undefined) throw new InvalidOutputCapPlanError();
  const existing = state.projections.get(outcome);
  if (existing !== undefined) return { request: existing, plan };
  const request = projectRequest(state.payload, outcome, true, true, state.optionsAliased);
  ownedRequests.set(request, { state, outcome });
  assertOwnedRequestBinding(request, candidate.provider, candidate.endpoint);
  state.projections.set(outcome, request);
  return { request, plan };
}

/** Direct-adapter boundary: discover the model by descriptor, before any ordinary caller read. */
export function prepareOwnedRequest(
  request: LlmRequest,
  provider: ProviderId,
  endpoint: EndpointKind,
): { readonly request: LlmRequest; readonly plan: PreparedOutputCapPlan } {
  const inspected = requestDescriptors(request);
  const candidate = { model: inspected.model, provider, endpoint };
  return selectOwnedRequest(ownLlmRequest(request, [candidate]), candidate);
}

/**
 * Each SDK receives a private mutable graph, without the frozen request's private association.
 * Resolve/validate the plan on the selected frozen request FIRST, then pass that exact plan to
 * native lowering alongside this copy. A generic copied cap object is not original/captured cap
 * identity, and must not acquire accepted-view authority merely by carrying public plan metadata.
 */
export function mutableOwnedRequest(request: LlmRequest): LlmRequest {
  const owned = ownedRequests.get(request);
  if (owned === undefined) throw new InvalidOutputCapPlanError();
  return projectRequest(request, owned.outcome, false, false, owned.state.optionsAliased);
}

/** Trusted live overlay preserves candidate authority without transferring it through spread. */
export function withOwnedRequestSignal(
  request: LlmRequest,
  signal: LlmRequest['signal'],
): LlmRequest {
  const owned = ownedRequests.get(request);
  if (owned === undefined) throw new InvalidOutputCapPlanError();
  const payload: LlmRequest = { ...owned.state.payload, signal };
  Object.setPrototypeOf(payload, null);
  Object.freeze(payload);
  const state = requestState(payload, owned.state.outcomes);
  const selected: LlmRequest = { ...request, signal };
  Object.setPrototypeOf(selected, null);
  Object.freeze(selected);
  ownedRequests.set(selected, { state, outcome: owned.outcome });
  state.projections.set(owned.outcome, selected);
  return selected;
}

/** The existing model-tier policy chooses when this trusted omission is applicable. */
export function withoutOwnedRequestEffort(request: LlmRequest): LlmRequest {
  const owned = ownedRequests.get(request);
  if (owned === undefined) throw new InvalidOutputCapPlanError();
  const payload: LlmRequest = { ...owned.state.payload };
  delete payload.reasoningEffort;
  Object.setPrototypeOf(payload, null);
  Object.freeze(payload);
  const state = requestState(payload, owned.state.outcomes);
  const selected: LlmRequest = { ...request };
  delete selected.reasoningEffort;
  Object.setPrototypeOf(selected, null);
  Object.freeze(selected);
  ownedRequests.set(selected, { state, outcome: owned.outcome });
  state.projections.set(owned.outcome, selected);
  return selected;
}

/**
 * Internal handoff from the existing reasoning/media transformation authorities. They operate on
 * the selected owned messages and change only their approved slots; this helper neither chooses
 * those transformations nor accepts replacement cap/options/model controls. A new tool-result
 * round must go through ownLlmRequest and fresh admission instead.
 */
export function deriveOwnedRequestMessages(
  request: LlmRequest,
  change: { readonly route: 'reasoning' | 'media'; readonly messages: LlmRequest['messages'] },
): LlmRequest {
  const owned = ownedRequests.get(request);
  if (owned === undefined) throw new InvalidOutputCapPlanError();
  const source: LlmRequest = { ...request, messages: change.messages };
  const payload = captureRequestData(source, source);
  return selectOwnedRequest(
    handleFor(requestState(payload, owned.state.outcomes)),
    owned.outcome.candidate,
  ).request;
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
