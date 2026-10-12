import { MEDIA_HANDLE_PATTERN, mediaModalityOf, type DurableMediaMeta } from './content.js';

export const MAX_MEDIA_OBJECT_BYTES = 25 * 1024 * 1024;
export const MAX_MEDIA_INSPECTION_BYTES = 64 * 1024;
export type CanonicalMediaMimeType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp'
  | 'audio/wav'
  | 'audio/mpeg'
  | 'audio/flac'
  | 'audio/ogg'
  | 'audio/opus'
  | 'audio/aac'
  | 'audio/L16'
  | 'video/mp4'
  | 'video/webm'
  | 'application/pdf';
export type MediaAdmissionErrorCode =
  | 'unsupported_mime'
  | 'invalid_descriptor'
  | 'descriptor_conflict'
  | 'invalid_format'
  | 'inspection_limit'
  | 'object_limit'
  | 'inline_limit'
  | 'unsafe_value'
  | 'store_unavailable'
  | 'store_contract'
  | 'source_unavailable'
  | 'source_failed'
  | 'stream_incomplete'
  | 'verifier_state';
const MESSAGES: Readonly<Record<MediaAdmissionErrorCode, string>> = {
  unsupported_mime: 'Media type is not supported.',
  invalid_descriptor: 'Media descriptor is invalid.',
  descriptor_conflict: 'Media descriptors disagree.',
  invalid_format: 'Media structure is unsupported or incomplete.',
  inspection_limit: 'Media structure exceeds the inspection limit.',
  object_limit: 'Media exceeds the object byte limit.',
  inline_limit: 'Media exceeds the inline carrier limit.',
  unsafe_value: 'Media publication requires inert data.',
  store_unavailable: 'Media publication requires a media store.',
  store_contract: 'Media store validation did not establish matching evidence.',
  source_unavailable: 'Media source requires a streaming host.',
  source_failed: 'Media source did not satisfy its contract.',
  stream_incomplete: 'Media store did not consume the complete stream.',
  verifier_state: 'Media verifier is already finished or failed.',
};
export class MediaAdmissionError extends Error {
  readonly code: MediaAdmissionErrorCode;
  constructor(code: MediaAdmissionErrorCode) {
    super(MESSAGES[code]);
    this.name = 'MediaAdmissionError';
    this.code = code;
  }
}
export function canonicalMediaMimeType(input: string): CanonicalMediaMimeType {
  if (typeof input !== 'string') throw new MediaAdmissionError('unsupported_mime');
  switch (input.toLowerCase()) {
    case 'image/png':
      return 'image/png';
    case 'image/jpeg':
    case 'image/jpg':
      return 'image/jpeg';
    case 'image/gif':
      return 'image/gif';
    case 'image/webp':
      return 'image/webp';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'audio/wav';
    case 'audio/mpeg':
      return 'audio/mpeg';
    case 'audio/flac':
    case 'audio/x-flac':
      return 'audio/flac';
    case 'audio/ogg':
      return 'audio/ogg';
    case 'audio/opus':
      return 'audio/opus';
    case 'audio/aac':
      return 'audio/aac';
    case 'audio/l16':
      return 'audio/L16';
    case 'video/mp4':
      return 'video/mp4';
    case 'video/webm':
      return 'video/webm';
    case 'application/pdf':
      return 'application/pdf';
    default:
      throw new MediaAdmissionError('unsupported_mime');
  }
}
/** `actual` must come from independent byte evidence, never metadata-only relabelling. */
export function mediaMimeTypesCompatible(declared: string, actual: string): boolean {
  const wanted = canonicalMediaMimeType(declared);
  const observed = canonicalMediaMimeType(actual);
  return wanted === observed || (wanted === 'audio/ogg' && observed === 'audio/opus');
}
/** Own data only; reflection failures never expose arbitrary exception text. */
export function mediaDataField(input: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined) return undefined;
    if (!('value' in descriptor)) throw new MediaAdmissionError('unsafe_value');
    const value: unknown = descriptor.value;
    return value;
  } catch {
    throw new MediaAdmissionError('unsafe_value');
  }
}
export function mediaHasField(input: object, key: string): boolean {
  try {
    return Object.getOwnPropertyDescriptor(input, key) !== undefined;
  } catch {
    throw new MediaAdmissionError('unsafe_value');
  }
}
export function admitMediaDescriptor(input: unknown): DurableMediaMeta {
  if (typeof input !== 'object' || input === null)
    throw new MediaAdmissionError('invalid_descriptor');
  const handle = mediaDataField(input, 'handle');
  const mime = mediaDataField(input, 'mimeType');
  const modality = mediaDataField(input, 'modality');
  const byteLength = mediaDataField(input, 'byteLength');
  const durationMs = mediaDataField(input, 'durationMs');
  if (
    typeof handle !== 'string' ||
    !MEDIA_HANDLE_PATTERN.test(handle) ||
    typeof mime !== 'string' ||
    typeof byteLength !== 'number' ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0
  ) {
    throw new MediaAdmissionError('invalid_descriptor');
  }
  const mimeType = canonicalMediaMimeType(mime);
  const actualModality = mediaModalityOf(mimeType);
  if (actualModality === undefined || modality !== actualModality)
    throw new MediaAdmissionError('invalid_descriptor');
  if (
    mediaHasField(input, 'durationMs') &&
    (typeof durationMs !== 'number' ||
      !Number.isSafeInteger(durationMs) ||
      durationMs <= 0 ||
      (modality !== 'audio' && modality !== 'video'))
  )
    throw new MediaAdmissionError('invalid_descriptor');
  return Object.freeze({
    handle,
    mimeType,
    modality: actualModality,
    byteLength,
    ...(typeof durationMs === 'number' ? { durationMs } : {}),
  });
}
export function reconcileMediaDescriptors(
  items: readonly DurableMediaMeta[],
): readonly DurableMediaMeta[] {
  const result = new Map<string, DurableMediaMeta>();
  if (!Array.isArray(items)) throw new MediaAdmissionError('unsafe_value');
  const length = mediaDataField(items, 'length');
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0)
    throw new MediaAdmissionError('unsafe_value');
  const owned: DurableMediaMeta[] = [];
  for (let i = 0; i < length; i++) {
    if (!mediaHasField(items, String(i))) throw new MediaAdmissionError('unsafe_value');
    owned.push(admitMediaDescriptor(mediaDataField(items, String(i))));
  }
  for (const next of owned) {
    const previous = result.get(next.handle);
    if (previous !== undefined) {
      if (
        previous.mimeType !== next.mimeType ||
        previous.modality !== next.modality ||
        previous.byteLength !== next.byteLength ||
        (previous.durationMs !== undefined &&
          next.durationMs !== undefined &&
          previous.durationMs !== next.durationMs)
      ) {
        throw new MediaAdmissionError('descriptor_conflict');
      }
      if (previous.durationMs !== undefined) continue;
    }
    result.set(next.handle, next);
  }
  return Object.freeze([...result.values()]);
}
