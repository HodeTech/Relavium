import { MediaAdmissionError } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { NodeMediaPinError } from './media-pin-error.js';

const privateMessage = 'PRIVATE signed URL and host failure';
const fixedInternal = 'node `work` produced media that could not be re-hosted (internal)';
const fixedFormat =
  'node `work` produced media that could not be re-hosted: Media structure is unsupported or incomplete.';

function expectInternal(error: NodeMediaPinError): void {
  expect(error.failure).toEqual({ code: 'internal', message: fixedInternal, retryable: false });
  expect(NodeMediaPinError.failureOf(error, 'work')).toEqual(error.failure);
}

describe('private media pin capture and finite templates', () => {
  it('does not register a direct JavaScript constructor call with arbitrary failure fields', () => {
    // TypeScript privacy is not a runtime brand; even Reflect.construct must remain untrusted.
    const direct: unknown = Reflect.construct(NodeMediaPinError, [
      { code: 'validation', message: privateMessage, retryable: true },
    ]);
    expect(NodeMediaPinError.failureOf(direct, 'work')).toBeUndefined();
    expectInternal(NodeMediaPinError.from(direct, 'work', false));
  });

  it('captures frozen finite fields for exactly the originating node despite public mutations', () => {
    const original = NodeMediaPinError.from(
      new MediaAdmissionError('invalid_format'),
      'work',
      false,
    );
    const capture = NodeMediaPinError.failureOf(original, 'work');
    expect(capture).toEqual({ code: 'validation', message: fixedFormat, retryable: false });
    expect(Object.isFrozen(capture)).toBe(true);
    Object.defineProperty(original, 'message', { value: privateMessage });
    Object.defineProperty(original, 'failure', {
      value: { code: 'validation', message: privateMessage, retryable: true },
    });
    Object.defineProperty(original, 'code', { value: 'network' });
    expect(NodeMediaPinError.failureOf(original, 'work')).toBe(capture);
    expect(NodeMediaPinError.failureOf(original, 'other')).toBeUndefined();
    const reconstructed = NodeMediaPinError.from(original, 'work', false);
    expect(reconstructed).not.toBe(original);
    expect(reconstructed.failure).toEqual(capture);
    expect(NodeMediaPinError.failureOf(reconstructed, 'work')).toEqual(capture);
    expect(NodeMediaPinError.from(original, 'other', false).failure).toEqual({
      code: 'internal',
      message: 'node `other` produced media that could not be re-hosted (internal)',
      retryable: false,
    });
  });

  it('does not inspect forged prototypes, public failure accessors or proxies while querying capture', () => {
    let reads = 0;
    const forged = new Error(privateMessage);
    Object.setPrototypeOf(forged, NodeMediaPinError.prototype);
    Object.defineProperty(forged, 'failure', {
      get() {
        reads++;
        throw new Error(privateMessage);
      },
    });
    const proxy = new Proxy(forged, {
      getPrototypeOf() {
        reads++;
        throw new Error(privateMessage);
      },
      getOwnPropertyDescriptor() {
        reads++;
        throw new Error(privateMessage);
      },
      get() {
        reads++;
        throw new Error(privateMessage);
      },
    });
    for (const value of [forged, proxy]) {
      expect(NodeMediaPinError.failureOf(value, 'work')).toBeUndefined();
      expect(NodeMediaPinError.failureOf(value, 'other')).toBeUndefined();
    }
    expect(reads).toBe(0);
    expectInternal(NodeMediaPinError.from(forged, 'work', false));
    expect(reads).toBe(0);
  });

  it('retains the exact per-node and per-run limit wording and nonretryable classification', () => {
    const perNode = NodeMediaPinError.partsExceeded('work', 33, 0);
    expect(perNode.failure).toEqual({
      code: 'validation',
      message: 'node `work` produced 33 media parts to re-host, over its limit of 32',
      retryable: false,
    });
    expect(NodeMediaPinError.failureOf(perNode, 'work')).toEqual(perNode.failure);
    const perRun = NodeMediaPinError.partsExceeded('work', 1, 256);
    expect(perRun.failure).toEqual({
      code: 'validation',
      message:
        'this run has re-hosted 256 media parts and node `work` adds 1, over the run limit of 256',
      retryable: false,
    });
    expect(NodeMediaPinError.failureOf(perRun, 'work')).toEqual(perRun.failure);
    // Calling the factory at exact capacity or below cannot invent a validation refusal.
    expectInternal(NodeMediaPinError.partsExceeded('work', 32, 0));
    expectInternal(NodeMediaPinError.partsExceeded('work', 1, 255));
  });

  it.each([
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    [-1, 0],
    [1.5, 0],
    [Number.MAX_SAFE_INTEGER + 1, 0],
    [1, Number.NaN],
    [1, -1],
    [1, Number.MAX_SAFE_INTEGER],
  ])('maps invalid numeric counts (%s, %s) to fixed internal', (incoming, accumulated) => {
    expectInternal(NodeMediaPinError.partsExceeded('work', incoming, accumulated));
  });

  it('keeps cancellation first without probing an opaque thrown value', () => {
    let reads = 0;
    const opaque = new Proxy(
      {},
      {
        getPrototypeOf() {
          reads++;
          throw new Error(privateMessage);
        },
        getOwnPropertyDescriptor() {
          reads++;
          throw new Error(privateMessage);
        },
        get() {
          reads++;
          throw new Error(privateMessage);
        },
      },
    );
    const cancelled = NodeMediaPinError.from(opaque, 'work', true);
    expect(cancelled.failure).toEqual({
      code: 'cancelled',
      message: 'the run was cancelled',
      retryable: false,
    });
    expect(NodeMediaPinError.failureOf(cancelled, 'work')).toEqual(cancelled.failure);
    expect(reads).toBe(0);
  });
});
