import type { DurableMediaMeta, MediaReferencePort, MediaStore } from '@relavium/shared';

/** Pure engine accounting fixture. Native byte identity and SQLite admission are tested by hosts. */
export function accountingMediaPorts(expected: DurableMediaMeta): {
  readonly mediaStore: MediaStore;
  readonly mediaReferences: MediaReferencePort;
} {
  let validated = false;
  const check = (actual: DurableMediaMeta): void => {
    if (
      actual.handle !== expected.handle ||
      actual.mimeType !== expected.mimeType ||
      actual.modality !== expected.modality ||
      actual.byteLength !== expected.byteLength ||
      actual.durationMs !== expected.durationMs
    ) {
      throw new Error('unexpected accounting media descriptor');
    }
  };
  return {
    mediaStore: {
      validateMedia: (handle, descriptor) => {
        if (descriptor.byteLength !== undefined && descriptor.byteLength !== expected.byteLength) {
          return Promise.reject(new Error('unexpected accounting media byte claim'));
        }
        const actual = { ...descriptor, handle, byteLength: expected.byteLength };
        return Promise.resolve().then(() => {
          check(actual);
          validated = true;
          return Object.freeze(actual);
        });
      },
      put: () => Promise.reject(new Error('unexpected accounting media put')),
      get: () => Promise.reject(new Error('unexpected accounting media get')),
      resolveForEgress: () => Promise.reject(new Error('unexpected accounting media egress')),
      readRange: () => Promise.reject(new Error('unexpected accounting media range')),
    },
    mediaReferences: {
      admitProducedMedia: (batch) => {
        if (batch.length > 0 && !validated) {
          throw new Error('accounting media admitted before validation');
        }
        for (const item of batch) check(item);
      },
      recordRunMedia: (item) => check(item),
      reclaimRun: () => undefined,
    },
  };
}

export function accountingImagePorts(digestDigit: string): ReturnType<typeof accountingMediaPorts> {
  return accountingMediaPorts({
    handle: `media://sha256-${digestDigit.repeat(64)}`,
    mimeType: 'image/png',
    modality: 'image',
    byteLength: 4,
  });
}
