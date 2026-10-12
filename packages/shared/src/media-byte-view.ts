import { MediaAdmissionError } from './media-admission.js';
// TypedArray intrinsics ignore subclass length/iterator/slice overrides and reject Proxy wrappers.
const typedArrayPrototype: unknown = Object.getPrototypeOf(Uint8Array.prototype);
const byteLengthDescriptor =
  typeof typedArrayPrototype === 'object' && typedArrayPrototype !== null
    ? Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')
    : undefined;
export function mediaByteLength(bytes: Uint8Array): number {
  if (!(bytes instanceof Uint8Array) || byteLengthDescriptor?.get === undefined)
    throw new MediaAdmissionError('invalid_format');
  try {
    const length: unknown = byteLengthDescriptor.get.call(bytes);
    if (typeof length !== 'number') throw new MediaAdmissionError('invalid_format');
    return length;
  } catch {
    throw new MediaAdmissionError('invalid_format');
  }
}
export function ownMediaBytes(bytes: Uint8Array, length = mediaByteLength(bytes)): Uint8Array {
  const copy = new Uint8Array(length);
  Uint8Array.prototype.set.call(copy, bytes);
  return copy;
}
