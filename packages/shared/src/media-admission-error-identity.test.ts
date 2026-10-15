import { describe, expect, it } from 'vitest';

import { MediaAdmissionError } from './media-admission.js';

const privateMessage = 'PRIVATE source credential and exception text';

describe('fixed media admission error reconstruction', () => {
  it('returns a fresh local fixed diagnostic even for a mutated local error', () => {
    const original = new MediaAdmissionError('invalid_format');
    original.message = privateMessage;
    const owned = MediaAdmissionError.from(original);
    expect(owned).toBeInstanceOf(MediaAdmissionError);
    expect(owned).not.toBe(original);
    expect(owned).toMatchObject({
      name: 'MediaAdmissionError',
      code: 'invalid_format',
      message: 'Media structure is unsupported or incomplete.',
    });
    expect(Object.hasOwn(owned ?? {}, 'cause')).toBe(false);
  });

  it('accepts matching inert classification data without implying trusted provenance', () => {
    let calls = 0;
    const foreign = { name: 'MediaAdmissionError', code: 'source_unavailable' };
    for (const key of ['message', 'cause']) {
      Object.defineProperty(foreign, key, {
        get() {
          calls++;
          throw new Error(privateMessage);
        },
      });
    }
    expect(MediaAdmissionError.from(foreign)).toMatchObject({
      code: 'source_unavailable',
      message: 'Media source requires a streaming host.',
    });
    expect(calls).toBe(0);
  });

  it.each(['unknown', '__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    'rejects %s outside the canonical message map',
    (code) =>
      expect(MediaAdmissionError.from({ name: 'MediaAdmissionError', code })).toBeUndefined(),
  );

  it('rejects missing, inherited, wrong-name and nonobject discriminants', () => {
    const inherited: unknown = Object.create({
      name: 'MediaAdmissionError',
      code: 'invalid_format',
    });
    for (const error of [
      undefined,
      null,
      false,
      0,
      'invalid_format',
      () => undefined,
      {},
      { name: 'MediaAdmissionError' },
      { code: 'invalid_format' },
      { name: 'AnotherError', code: 'invalid_format' },
      inherited,
    ])
      expect(MediaAdmissionError.from(error)).toBeUndefined();
  });

  it('refuses accessors and descriptor reflection faults without evaluating getters', () => {
    let calls = 0;
    for (const key of ['name', 'code']) {
      const error = { name: 'MediaAdmissionError', code: 'invalid_format' };
      Object.defineProperty(error, key, {
        get() {
          calls++;
          throw new Error(privateMessage);
        },
      });
      expect(MediaAdmissionError.from(error)).toBeUndefined();
    }
    const fault = new MediaAdmissionError('invalid_format');
    fault.message = privateMessage;
    expect(
      MediaAdmissionError.from(
        new Proxy(
          {},
          {
            getOwnPropertyDescriptor() {
              throw fault;
            },
          },
        ),
      ),
    ).toBeUndefined();
    expect(calls).toBe(0);
  });

  it('does not inspect prototypes or invoke property reads for inert discriminants', () => {
    let calls = 0;
    const error = new Proxy(
      { name: 'MediaAdmissionError', code: 'invalid_format' },
      {
        getPrototypeOf() {
          calls++;
          throw new Error(privateMessage);
        },
        get() {
          calls++;
          throw new Error(privateMessage);
        },
      },
    );
    expect(MediaAdmissionError.from(error)).toMatchObject({
      code: 'invalid_format',
      message: 'Media structure is unsupported or incomplete.',
    });
    expect(calls).toBe(0);
  });
});
