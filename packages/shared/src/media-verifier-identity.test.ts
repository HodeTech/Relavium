import { expect, it } from 'vitest';

import { MediaAdmissionError } from './media-admission.js';
import { ambiguousVideoIdentities } from './media-identity-vectors.js';
import { mp4Video, webmVideo } from './media-test-vectors.js';
import { createMediaVerifier } from './media-verifier.js';

it.each(ambiguousVideoIdentities)('refuses ambiguous identity: $name', ({ mimeType, bytes }) => {
  for (let split = 0; split <= bytes.length; split++) {
    expect(
      () => {
        const verifier = createMediaVerifier(mimeType);
        verifier.push(bytes.subarray(0, split));
        verifier.push(bytes.subarray(split));
        verifier.finish();
      },
      mimeType === 'video/webm' ? 'MEDIA_WEBM_SINGULAR_IDENTITY' : 'MEDIA_MP4_SINGULAR_IDENTITY',
    ).toThrowError(new MediaAdmissionError('invalid_format'));
  }
});

it.each([
  { mimeType: 'video/webm', bytes: webmVideo() },
  { mimeType: 'video/mp4', bytes: mp4Video() },
])('retains single-identity late container control: $mimeType', ({ mimeType, bytes }) => {
  for (let split = 0; split <= bytes.length; split++) {
    const verifier = createMediaVerifier(mimeType);
    verifier.push(bytes.subarray(0, split));
    verifier.push(bytes.subarray(split));
    expect(verifier.finish()).toMatchObject({ mimeType, byteLength: bytes.length });
  }
});
