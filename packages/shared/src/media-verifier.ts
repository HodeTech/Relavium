import { MediaInspectionMemory } from './media-inspection-memory.js';
import { mediaByteLength } from './media-byte-view.js';
import { mediaModalityOf, type DurableMediaMeta } from './content.js';
import {
  canonicalMediaMimeType,
  MAX_MEDIA_OBJECT_BYTES,
  MediaAdmissionError,
  mediaMimeTypesCompatible,
  type CanonicalMediaMimeType,
} from './media-admission.js';
import { gif, jpeg, png, webp } from './media-verifier-images.js';
import { aac, mpeg, wav } from './media-verifier-audio.js';
import { ogg } from './media-verifier-ogg.js';
import { flac } from './media-verifier-flac.js';
import { mp4 } from './media-verifier-mp4.js';
import { webm } from './media-verifier-webm.js';
import { PdfVerifier } from './media-verifier-pdf.js';
import { ParserReader } from './media-verifier-reader.js';
export interface MediaVerifier {
  push(chunk: Uint8Array): void;
  finish(): Readonly<Pick<DurableMediaMeta, 'mimeType' | 'modality' | 'byteLength'>>;
}
function recognizer(type: CanonicalMediaMimeType): ParserReader | PdfVerifier | undefined {
  const memory = new MediaInspectionMemory();
  switch (type) {
    case 'image/png':
      return new ParserReader(png());
    case 'image/jpeg':
      return new ParserReader(jpeg());
    case 'image/gif':
      return new ParserReader(gif());
    case 'image/webp':
      return new ParserReader(webp());
    case 'audio/wav':
      return new ParserReader(wav());
    case 'audio/mpeg':
      return new ParserReader(mpeg());
    case 'audio/aac':
      return new ParserReader(aac());
    case 'audio/ogg':
    case 'audio/opus':
      return new ParserReader(ogg(memory), memory);
    case 'audio/flac':
      return new ParserReader(flac());
    case 'audio/L16':
      return undefined;
    case 'video/mp4':
      return new ParserReader(mp4());
    case 'video/webm':
      return new ParserReader(webm());
    case 'application/pdf':
      return new PdfVerifier();
  }
}
/** Synchronously consumes borrowed chunks; keeps no body references and requires finish before publication. */
export function createMediaVerifier(declaredMimeType: string): MediaVerifier {
  const declared = canonicalMediaMimeType(declaredMimeType),
    parser = recognizer(declared);
  let total = 0,
    state: 'open' | 'finished' | 'failed' = 'open';
  return {
    push(chunk: Uint8Array): void {
      if (state !== 'open') throw new MediaAdmissionError('verifier_state');
      try {
        const length = mediaByteLength(chunk);
        if (length > MAX_MEDIA_OBJECT_BYTES - total) throw new MediaAdmissionError('object_limit');
        total += length;
        parser?.push(chunk);
      } catch (error) {
        state = 'failed';
        throw error;
      }
    },
    finish() {
      if (state !== 'open') throw new MediaAdmissionError('verifier_state');
      state = 'failed';
      if (total === 0 || (declared === 'audio/L16' && total % 2 !== 0))
        throw new MediaAdmissionError('invalid_format');
      const mimeType = parser?.finish() ?? declared;
      if (!mediaMimeTypesCompatible(declared, mimeType))
        throw new MediaAdmissionError('invalid_format');
      const modality = mediaModalityOf(mimeType);
      if (modality === undefined) throw new MediaAdmissionError('invalid_format');
      state = 'finished';
      return Object.freeze({ mimeType, modality, byteLength: total });
    },
  };
}
