import { createMediaVerifier } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { fetchMediaBytes, type MediaEgressDeps } from './media-egress.js';

// Independent finite ADTS AAC frame; no socket, provider, credential or user data.
const AAC = [255, 241, 80, 128, 1, 191, 252, 33, 16, 4, 96, 140, 28];

class BorrowedView extends Uint8Array {}

describe('whole-buffer media ownership', () => {
  it.each(['Uint8Array', 'Buffer', 'subclass'])(
    'MEDIA_WHOLE_BUFFER_OWNERSHIP: owns reused %s before the next pull',
    async (kind) => {
      let sliceCalls = 0;
      let iteratorCalls = 0;
      const borrowed =
        kind === 'Buffer'
          ? Buffer.from(AAC)
          : kind === 'subclass'
            ? new BorrowedView(AAC)
            : new Uint8Array(AAC);
      if (kind === 'subclass') {
        Object.defineProperty(borrowed, 'slice', {
          value: () => {
            sliceCalls += 1;
            return borrowed;
          },
        });
        Object.defineProperty(borrowed, Symbol.iterator, {
          value: () => {
            iteratorCalls += 1;
            throw new Error('fixture iterator must not be called');
          },
        });
      }
      let disposed = 0;
      let reused = false;
      const deps: MediaEgressDeps = {
        resolveHost: () => Promise.resolve(['203.0.113.10']),
        openConnection: () =>
          Promise.resolve({
            status: 200,
            headers: { 'content-type': 'audio/aac' },
            location: undefined,
            body: (async function* () {
              await Promise.resolve();
              yield borrowed;
              borrowed.fill(0);
              reused = true;
            })(),
            dispose: () => {
              disposed += 1;
            },
          }),
      };
      const returned = await fetchMediaBytes(
        'https://fixture.invalid/audio',
        { mimeType: 'audio/aac', maxBytes: AAC.length },
        deps,
      );
      expect(reused).toBe(true);
      expect(borrowed.every((byte) => byte === 0)).toBe(true);
      expect(disposed).toBe(1);
      expect([...returned], 'MEDIA_WHOLE_BUFFER_OWNERSHIP').toEqual(AAC);
      expect(returned.buffer).not.toBe(borrowed.buffer);
      expect(sliceCalls).toBe(0);
      expect(iteratorCalls).toBe(0);
      const verifier = createMediaVerifier('audio/aac');
      verifier.push(returned);
      expect(verifier.finish()).toMatchObject({ mimeType: 'audio/aac', byteLength: AAC.length });
    },
  );
});
