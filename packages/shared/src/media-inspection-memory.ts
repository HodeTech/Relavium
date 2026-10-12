import { MAX_MEDIA_INSPECTION_BYTES, MediaAdmissionError } from './media-admission.js';
/** Internal allocation authority. No body-dependent retained allocations bypass this budget. */
export class MediaInspectionMemory {
  #allocated = 0;
  readonly #observe: ((buffer: Uint8Array) => void) | undefined;
  constructor(observe?: (buffer: Uint8Array) => void) {
    this.#observe = observe;
  }
  allocate(bytes: number): Uint8Array {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > MAX_MEDIA_INSPECTION_BYTES - this.#allocated
    )
      throw new MediaAdmissionError('inspection_limit');
    this.#allocated += bytes;
    const buffer = new Uint8Array(bytes);
    this.#observe?.(buffer);
    return buffer;
  }
}
