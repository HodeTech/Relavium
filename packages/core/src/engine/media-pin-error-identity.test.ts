import { MediaAdmissionError } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { NodeMediaPinError } from './media-pin-error.js';

const privateMessage = 'PRIVATE signed credential and provider payload';
const where = 'node `work` produced media that could not be re-hosted';
const fixedFormatMessage = `${where}: Media structure is unsupported or incomplete.`;

// A distinct constructor models the inert error shape emitted by another loaded shared copy.
// This classification fixture does not register iterators or bridge their private ownership domains.
class ForeignAdmissionError extends Error {
  readonly code = 'invalid_format';
  constructor() {
    super(privateMessage);
    this.name = 'MediaAdmissionError';
  }
}

function expectInternal(error: unknown): void {
  expect(NodeMediaPinError.from(error, 'work', false).failure).toEqual({
    code: 'internal',
    message: `${where} (internal)`,
    retryable: false,
  });
}

describe('media pin inert error classification', () => {
  it('classifies a distinct admission constructor using fixed local wording', () => {
    const foreign = new ForeignAdmissionError();
    expect(foreign).not.toBeInstanceOf(MediaAdmissionError);
    expect(NodeMediaPinError.from(foreign, 'work', false).failure).toEqual({
      code: 'validation',
      message: fixedFormatMessage,
      retryable: false,
    });
  });

  it('reconstructs a mutated local admission message instead of reflecting it', () => {
    const error = new MediaAdmissionError('invalid_format');
    error.message = privateMessage;
    expect(NodeMediaPinError.from(error, 'work', false).failure).toEqual({
      code: 'validation',
      message: fixedFormatMessage,
      retryable: false,
    });
  });

  it('classifies matching own data only, without reading message or cause', () => {
    let calls = 0;
    const foreign = { name: 'MediaAdmissionError', code: 'store_contract' };
    for (const key of ['message', 'cause']) {
      Object.defineProperty(foreign, key, {
        get() {
          calls++;
          throw new Error(privateMessage);
        },
      });
    }
    expect(NodeMediaPinError.from(foreign, 'work', false).failure).toEqual({
      code: 'internal',
      message: `${where}: Media store validation did not establish matching evidence.`,
      retryable: false,
    });
    expect(calls).toBe(0);
  });

  it.each(['unknown', '__proto__', 'constructor', 'toString'])(
    'does not classify the unknown admission code %s',
    (code) => expectInternal({ name: 'MediaAdmissionError', code, message: privateMessage }),
  );

  it('does not classify a wrong name or inherited admission discriminants', () => {
    expectInternal({ name: 'AnotherError', code: 'invalid_format', message: privateMessage });
    const inherited: unknown = Object.create({
      name: 'MediaAdmissionError',
      code: 'invalid_format',
    });
    expectInternal(inherited);
  });

  it('refuses accessor discriminants without invoking them', () => {
    let calls = 0;
    for (const key of ['name', 'code']) {
      const error = { name: 'MediaAdmissionError', code: 'invalid_format' };
      Object.defineProperty(error, key, {
        get() {
          calls++;
          return key === 'name' ? 'MediaAdmissionError' : 'network';
        },
      });
      expectInternal(error);
    }
    expect(calls).toBe(0);
  });

  it('contains descriptor and prototype reflection faults with fixed internal wording', () => {
    for (const error of [
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw new Error(privateMessage);
          },
        },
      ),
      new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new MediaAdmissionError('invalid_format');
          },
        },
      ),
    ])
      expectInternal(error);
  });

  it.each([
    ['blocked_host', 'validation'],
    ['too_large', 'validation'],
    ['network', 'provider_unavailable'],
    ['timeout', 'provider_unavailable'],
  ])('preserves inert own egress code %s as %s without reading getters', (code, expectedCode) => {
    let calls = 0;
    const error = new Proxy(
      { code },
      {
        get() {
          calls++;
          throw new Error(privateMessage);
        },
      },
    );
    const failure = NodeMediaPinError.from(error, 'work', false).failure;
    expect(failure).toMatchObject({ code: expectedCode, retryable: false });
    expect(failure.message).toContain(`(${code})`);
    expect(failure.message).not.toContain(privateMessage);
    expect(calls).toBe(0);
  });

  it('does not adopt an inherited egress code or execute its getter', () => {
    let calls = 0;
    const prototype = Object.defineProperty({}, 'code', {
      get() {
        calls++;
        return 'network';
      },
    });
    const error: unknown = Object.create(prototype);
    expectInternal(error);
    expect(calls).toBe(0);
  });

  it('retains cancellation before any caller reflection', () => {
    let calls = 0;
    const error = new Proxy(
      {},
      {
        getPrototypeOf() {
          calls++;
          throw new Error(privateMessage);
        },
        getOwnPropertyDescriptor() {
          calls++;
          throw new Error(privateMessage);
        },
      },
    );
    expect(NodeMediaPinError.from(error, 'work', true).failure).toEqual({
      code: 'cancelled',
      message: 'the run was cancelled',
      retryable: false,
    });
    expect(calls).toBe(0);
  });

  it('retains an existing local pin failure after the cancellation gate', () => {
    const error = new NodeMediaPinError('fixed existing pin failure', 'validation');
    expect(NodeMediaPinError.from(error, 'work', false)).toBe(error);
    expect(NodeMediaPinError.from(error, 'work', true).failure.code).toBe('cancelled');
  });
});
