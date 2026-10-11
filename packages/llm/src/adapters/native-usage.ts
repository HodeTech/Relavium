/** Presence-aware native accounting. Raw SDK objects never cross the evidence boundary. */
import {
  ownUsageEvidence,
  type KnownUsageQuantities,
  type UsageEvidence,
  type UsageEvidenceReason,
} from '@relavium/shared';
import type { LlmRequest } from '../types.js';

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

class Observation {
  readonly known: KnownUsageQuantities = {};
  reason: UsageEvidenceReason | undefined;
  count(value: unknown): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      this.reason = 'invalid_fields';
      return undefined;
    }
    return value;
  }
  contradiction(): void {
    this.reason = 'contradictory_fields';
  }
  sum(a: number, b: number): number | undefined {
    return this.count(a + b);
  }
  finish(complete: boolean, authoritative = true): UsageEvidence {
    const { inputTokens, outputTokens, reasoningTokens } = this.known;
    if (
      reasoningTokens !== undefined &&
      outputTokens !== undefined &&
      reasoningTokens > outputTokens
    ) {
      delete this.known.reasoningTokens;
      this.contradiction();
    }
    if (
      complete &&
      authoritative &&
      this.reason === undefined &&
      inputTokens !== undefined &&
      outputTokens !== undefined
    ) {
      return ownUsageEvidence({
        kind: 'complete',
        usage: { ...this.known, inputTokens, outputTokens },
      });
    }
    const reason = this.reason ?? (authoritative ? 'missing_fields' : 'interrupted');
    return Object.keys(this.known).length > 0
      ? ownUsageEvidence({ kind: 'partial', known: this.known, reason })
      : ownUsageEvidence({ kind: 'missing', reason });
  }
}

export const missingUsage = (): UsageEvidence =>
  ownUsageEvidence({ kind: 'missing', reason: 'not_reported' });
export function interruptedUsage(evidence: UsageEvidence, authoritative: boolean): UsageEvidence {
  if (authoritative || evidence.kind !== 'complete') return evidence;
  const known = { ...evidence.usage };
  delete known.costMicrocents;
  return ownUsageEvidence({ kind: 'partial', known, reason: 'interrupted' });
}

/** Cumulative frames replace reported quantities, but incomplete frames cannot erase earlier observations. */
export function retainUsageObservation(
  previous: UsageEvidence,
  current: UsageEvidence,
): UsageEvidence {
  if (current.kind === 'complete' || previous.kind === 'missing') return current;
  const before = previous.kind === 'complete' ? previous.usage : previous.known;
  const after = current.kind === 'partial' ? current.known : {};
  const { costMicrocents, ...quantities } =
    previous.kind === 'complete'
      ? previous.usage
      : { ...previous.known, costMicrocents: undefined };
  void costMicrocents;
  const known: KnownUsageQuantities = { ...quantities, ...after };
  const beforeMedia = before.mediaUnits;
  const afterMedia = after.mediaUnits;
  if (beforeMedia !== undefined && afterMedia !== undefined) {
    known.mediaUnits = [
      ...beforeMedia.filter(
        (prior) =>
          !afterMedia.some(
            (next) => next.modality === prior.modality && next.direction === prior.direction,
          ),
      ),
      ...afterMedia,
    ];
  }
  // Do not combine a newly observed subtotal with an older incompatible total (or vice versa).
  if (
    known.reasoningTokens !== undefined &&
    known.outputTokens !== undefined &&
    known.reasoningTokens > known.outputTokens
  ) {
    if (after.outputTokens === undefined) delete known.outputTokens;
    else delete known.reasoningTokens;
  }
  return ownUsageEvidence({ kind: 'partial', known, reason: current.reason });
}

/** Native media presence is accounting evidence even when content projection ignores the field. */
export function nativeFieldPresent(value: unknown, key: string): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && (!('value' in descriptor) || descriptor.value != null);
}

/** Newly observed media can invalidate completeness after the last native usage frame. */
export function requireMediaUsage(
  evidence: UsageEvidence,
  applicable: UsageApplicability,
): UsageEvidence {
  if (evidence.kind !== 'complete') return evidence;
  const media = evidence.usage.mediaUnits ?? [];
  const missing =
    applicable.unreportedMedia ||
    (applicable.inputAudio &&
      !media.some((entry) => entry.modality === 'audio' && entry.direction === 'input')) ||
    (applicable.outputAudio &&
      !media.some((entry) => entry.modality === 'audio' && entry.direction === 'output'));
  if (!missing) return evidence;
  const known = { ...evidence.usage };
  delete known.costMicrocents;
  return ownUsageEvidence({ kind: 'partial', known, reason: 'missing_fields' });
}

export interface UsageApplicability {
  readonly thinking?: boolean;
  readonly toolPrompt?: boolean;
  readonly inputAudio?: boolean;
  readonly outputAudio?: boolean;
  readonly unreportedMedia?: boolean;
}
/** Inline output has its own billing axis; an absent native counter is never invented. */
export function usageApplicability(req: LlmRequest, thinking = false): UsageApplicability {
  const inputAudio = req.messages.some((message) =>
    message.content.some((part) => part.type === 'media' && part.mimeType.startsWith('audio/')),
  );
  return {
    thinking,
    toolPrompt:
      (req.tools?.length ?? 0) > 0 ||
      req.providerOptions?.['tools'] !== undefined ||
      req.messages.some((message) => message.content.some((part) => part.type === 'tool_result')),
    inputAudio,
    outputAudio: req.outputModalities?.includes('audio') === true,
    unreportedMedia:
      req.outputModalities?.some((modality) => modality === 'image' || modality === 'video') ===
      true,
  };
}

export function openAiUsage(
  raw: unknown,
  deepseek = false,
  applicable: UsageApplicability = {},
): UsageEvidence {
  if (raw === undefined || raw === null) return missingUsage();
  const o = new Observation();
  const gross = o.count(field(raw, 'prompt_tokens'));
  const details = field(raw, 'prompt_tokens_details');
  const outputDetails = field(raw, 'completion_tokens_details');
  const alias = o.count(field(details, 'cached_tokens'));
  let hit = deepseek ? o.count(field(raw, 'prompt_cache_hit_tokens')) : alias;
  let miss = deepseek ? o.count(field(raw, 'prompt_cache_miss_tokens')) : undefined;
  let validSplit = true;
  if (deepseek && alias !== undefined) {
    if (hit !== undefined && hit !== alias) {
      o.contradiction();
      validSplit = false;
    } else hit = alias;
  }
  if (gross !== undefined && hit !== undefined && hit > gross) {
    o.contradiction();
    validSplit = false;
  }
  if (gross !== undefined && miss !== undefined && miss > gross) {
    o.contradiction();
    validSplit = false;
  }
  if (gross !== undefined && hit !== undefined && miss !== undefined && gross !== hit + miss) {
    o.contradiction();
    validSplit = false;
  }
  if (validSplit) {
    if (gross !== undefined && hit !== undefined && miss === undefined) miss = gross - hit;
    if (gross !== undefined && miss !== undefined && hit === undefined) hit = gross - miss;
    if (miss !== undefined) o.known.inputTokens = miss;
    if (hit !== undefined) o.known.cacheReadTokens = hit;
  }
  const output = o.count(field(raw, 'completion_tokens'));
  if (output !== undefined) o.known.outputTokens = output;
  const reasoning = o.count(field(outputDetails, 'reasoning_tokens'));
  if (reasoning !== undefined) o.known.reasoningTokens = reasoning;
  const inputAudio = o.count(field(details, 'audio_tokens'));
  const outputAudio = o.count(field(outputDetails, 'audio_tokens'));
  const media = [];
  if (inputAudio !== undefined)
    media.push({
      modality: 'audio' as const,
      direction: 'input' as const,
      units: inputAudio,
      unit: 'count' as const,
    });
  if (outputAudio !== undefined)
    media.push({
      modality: 'audio' as const,
      direction: 'output' as const,
      units: outputAudio,
      unit: 'count' as const,
    });
  if (media.length > 0) o.known.mediaUnits = media;
  return o.finish(
    validSplit &&
      hit !== undefined &&
      miss !== undefined &&
      (!applicable.inputAudio || inputAudio !== undefined) &&
      (!applicable.outputAudio || outputAudio !== undefined) &&
      !applicable.unreportedMedia,
  );
}

/** Keep the last trustworthy observation per cumulative field, without legitimizing a bad final frame. */
export class AnthropicUsageAccumulator {
  readonly #values: Record<string, unknown> = {};
  readonly #invalid = new Set<string>();
  observe(raw: unknown, authoritative: boolean): UsageEvidence {
    let currentOutputObserved = false;
    for (const key of [
      'input_tokens',
      'output_tokens',
      'cache_read_input_tokens',
      'cache_creation_input_tokens',
      'thinking_tokens',
    ]) {
      const value =
        key === 'thinking_tokens'
          ? field(field(raw, 'output_tokens_details'), key)
          : field(raw, key);
      if (value === undefined || value === null) continue;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        this.#invalid.add(key);
        continue;
      }
      this.#invalid.delete(key);
      if (key === 'output_tokens') currentOutputObserved = true;
      if (key === 'thinking_tokens')
        this.#values['output_tokens_details'] = { thinking_tokens: value };
      else this.#values[key] = value;
    }
    const evidence = anthropicUsage(this.#values, authoritative && currentOutputObserved);
    if (this.#invalid.size === 0) return evidence;
    if (evidence.kind === 'missing')
      return ownUsageEvidence({ kind: 'missing', reason: 'invalid_fields' });
    const known = evidence.kind === 'complete' ? evidence.usage : evidence.known;
    return ownUsageEvidence({ kind: 'partial', known, reason: 'invalid_fields' });
  }
}
export function anthropicUsage(raw: unknown, authoritative = true): UsageEvidence {
  if (raw === undefined || raw === null) return missingUsage();
  const o = new Observation();
  for (const [native, canonical] of [
    ['input_tokens', 'inputTokens'],
    ['output_tokens', 'outputTokens'],
    ['cache_read_input_tokens', 'cacheReadTokens'],
    ['cache_creation_input_tokens', 'cacheWriteTokens'],
  ] as const) {
    const value = o.count(field(raw, native));
    if (value !== undefined) o.known[canonical] = value;
  }
  const reasoning = o.count(field(field(raw, 'output_tokens_details'), 'thinking_tokens'));
  if (reasoning !== undefined) o.known.reasoningTokens = reasoning;
  return o.finish(
    o.known.cacheReadTokens !== undefined && o.known.cacheWriteTokens !== undefined,
    authoritative,
  );
}

export function geminiUsage(
  raw: unknown,
  applicable: UsageApplicability = {},
  authoritative = true,
): UsageEvidence {
  if (raw === undefined || raw === null) return missingUsage();
  const o = new Observation();
  const gross = o.count(field(raw, 'promptTokenCount'));
  const cached = o.count(field(raw, 'cachedContentTokenCount'));
  const candidates = o.count(field(raw, 'candidatesTokenCount'));
  const thoughts = o.count(field(raw, 'thoughtsTokenCount'));
  const tool = o.count(field(raw, 'toolUsePromptTokenCount'));
  if (cached !== undefined) o.known.cacheReadTokens = cached;
  if (thoughts !== undefined) o.known.reasoningTokens = thoughts;
  if (gross !== undefined && cached !== undefined) {
    if (cached > gross) {
      o.contradiction();
      delete o.known.cacheReadTokens;
    } else if (tool !== undefined || !applicable.toolPrompt) {
      const input = o.sum(gross - cached, tool ?? 0);
      if (input !== undefined) o.known.inputTokens = input;
    }
  }
  if (candidates !== undefined && (thoughts !== undefined || !applicable.thinking)) {
    const output = o.sum(candidates, thoughts ?? 0);
    if (output !== undefined) o.known.outputTokens = output;
  }
  return o.finish(
    !applicable.inputAudio && !applicable.outputAudio && !applicable.unreportedMedia,
    authoritative,
  );
}
