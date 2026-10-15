import { describe, expect, it } from 'vitest';

import { MediaAdmissionError } from './media-admission.js';
import { collectMediaForAdmission, snapshotMediaValue } from './media-publication.js';

const privateMessage = 'PRIVATE signed URL and raw reflection payload';
function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('expected media publication refusal');
}
function reflectionFailure(error: unknown): object {
  return new Proxy(
    {},
    {
      getPrototypeOf() {
        throw error;
      },
    },
  );
}

const boundaries = [
  { name: 'snapshot', run: (value: unknown) => snapshotMediaValue(value) },
  { name: 'collector', run: (value: unknown) => collectMediaForAdmission(value) },
];

describe.each(boundaries)('$name fixed admission diagnostics', ({ run }) => {
  it('reconstructs a mutated local admission error thrown by reflection', () => {
    const original = new MediaAdmissionError('invalid_format');
    original.message = privateMessage;
    const error = caught(() => run(reflectionFailure(original)));
    expect(error).toBeInstanceOf(MediaAdmissionError);
    expect(error).not.toBe(original);
    expect(error).toMatchObject({
      code: 'unsafe_value',
      message: 'Media publication requires inert data.',
    });
  });

  it('refuses a recognized foreign reflection failure as fixed unsafe_value', () => {
    const foreign = {
      name: 'MediaAdmissionError',
      code: 'inspection_limit',
      message: privateMessage,
    };
    const error = caught(() => run(reflectionFailure(foreign)));
    expect(error).toBeInstanceOf(MediaAdmissionError);
    expect(error).toMatchObject({
      code: 'unsafe_value',
      message: 'Media publication requires inert data.',
    });
  });

  it('normalizes unrecognized or unreadable reflection failures to fixed unsafe_value', () => {
    let calls = 0;
    const accessor = Object.defineProperty({ name: 'MediaAdmissionError' }, 'code', {
      get() {
        calls++;
        throw new Error(privateMessage);
      },
    });
    const unreadable = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error(privateMessage);
        },
      },
    );
    for (const failure of [
      { name: 'MediaAdmissionError', code: 'unknown', message: privateMessage },
      new Error(privateMessage),
      accessor,
      unreadable,
    ]) {
      expect(caught(() => run(reflectionFailure(failure)))).toMatchObject({
        code: 'unsafe_value',
        message: 'Media publication requires inert data.',
      });
    }
    expect(calls).toBe(0);
  });
});

it('keeps full-graph unsafe-value refusal ahead of a remembered descriptor refusal', () => {
  const invalidMedia = {
    type: 'media',
    source: { kind: 'handle', ref: 'invalid' },
    mimeType: 'audio/L16',
    byteLength: 2,
  };
  const reflectionError = new MediaAdmissionError('invalid_format');
  reflectionError.message = privateMessage;
  const reflection = new Proxy(
    {},
    {
      ownKeys() {
        throw reflectionError;
      },
    },
  );
  for (const unsafe of [() => undefined, { kind: 'base64', data: 'AAA=' }, reflection]) {
    expect(caught(() => collectMediaForAdmission([invalidMedia, unsafe]))).toMatchObject({
      code: 'unsafe_value',
      message: 'Media publication requires inert data.',
    });
  }
  expect(caught(() => collectMediaForAdmission(invalidMedia))).toMatchObject({
    code: 'invalid_descriptor',
    message: 'Media descriptor is invalid.',
  });
});

it('preserves pure collector MIME and reconciliation failure codes after safe preflight', () => {
  const handle = `media://sha256-${'a'.repeat(64)}`;
  const media = {
    type: 'media',
    source: { kind: 'handle', ref: handle },
    mimeType: 'audio/L16',
    byteLength: 2,
  };
  expect(caught(() => collectMediaForAdmission({ ...media, mimeType: 'unknown' }))).toMatchObject({
    code: 'unsupported_mime',
    message: 'Media type is not supported.',
  });
  expect(
    caught(() => collectMediaForAdmission([media, { ...media, byteLength: 4 }])),
  ).toMatchObject({
    code: 'descriptor_conflict',
    message: 'Media descriptors disagree.',
  });
});
