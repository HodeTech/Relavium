/** Direct hostile-boundary controls for the private VM result channel (ADR-0113). */
import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { SandboxError } from '../errors.js';
import {
  decodeExpressionPayload,
  decodeThrownPayload,
  readPrivateExpressionTransport,
} from './transport.js';

const MEMORY = 16 * 1024 * 1024;
const CANARY = 'hostile-transport-canary';

function decode(text: string, bound = MEMORY): unknown {
  const transport = readPrivateExpressionTransport(text, bound);
  return transport.kind === 'success' ? decodeExpressionPayload(transport) : transport;
}

function expectFailure(
  text: string,
  reason: 'runtime' | 'memory' = 'runtime',
  bound = MEMORY,
): void {
  try {
    decode(text, bound);
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxError);
    if (!(error instanceof SandboxError)) throw error;
    expect(error).toMatchObject({
      code: 'sandbox_error',
      reason,
      retryable: false,
      message:
        reason === 'memory'
          ? 'the expression result exceeded its transport limit'
          : 'the expression returned invalid private result transport',
    });
    expect(error.detail).toBeUndefined();
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(CANARY);
    return;
  }
  throw new Error('expected malformed transport to fail');
}

describe('closed private transport arms', () => {
  it.each<[string, unknown]>([
    ['{"name":"SyntaxError","message":"clean"}', { name: 'SyntaxError', message: 'clean' }],
    ['"primitive failure"', 'primitive failure'],
    ['null', null],
    ['42', 42],
  ])('decodes already-bounded thrown payload %s', (payload, expected) => {
    const arm = readPrivateExpressionTransport(
      JSON.stringify({ version: 1, kind: 'failure', stage: 'evaluation', payloadJson: payload }),
      MEMORY,
    );
    expect(arm.kind).toBe('failure');
    if (arm.kind !== 'failure' || arm.stage !== 'evaluation')
      throw new Error('missing evaluation failure arm');
    expect(decodeThrownPayload(arm.payloadJson)).toEqual(expected);
  });

  it('refuses malformed thrown JSON without echoing content', () => {
    let caught: unknown;
    try {
      decodeThrownPayload(CANARY);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SandboxError);
    if (!(caught instanceof SandboxError)) throw caught;
    expect(caught).toMatchObject({
      code: 'sandbox_error',
      reason: 'runtime',
      message: 'the expression returned invalid private result transport',
    });
    expect(caught.detail).toBeUndefined();
    expect(caught.cause).toBeUndefined();
  });

  it.each([
    { version: 1, kind: 'denied' },
    {
      version: 1,
      kind: 'failure',
      stage: 'evaluation',
      payloadJson: '{"name":"TypeError","message":"authored message"}',
    },
    { version: 1, kind: 'failure', stage: 'serialization', originalType: 'object' },
  ])('accepts the exact $kind arm', (arm) => {
    expect(readPrivateExpressionTransport(JSON.stringify(arm), MEMORY)).toEqual(arm);
  });

  it.each([
    null,
    [],
    true,
    1,
    CANARY,
    {},
    { version: 2, kind: 'denied' },
    { version: '1', kind: 'denied' },
    { version: 1, kind: 'unknown' },
    { version: 1, kind: 'denied', extra: CANARY },
    { version: 1, kind: 'denied', payloadJson: 'true' },
    { version: 1, kind: 'failure', stage: 'unknown' },
    { version: 1, kind: 'failure', stage: 'evaluation', name: 'Error' },
    { version: 1, kind: 'failure', stage: 'evaluation', name: 42, message: CANARY },
    {
      version: 1,
      kind: 'failure',
      stage: 'evaluation',
      name: 'Error',
      message: CANARY,
      extra: true,
    },
    { version: 1, kind: 'failure', stage: 'serialization', originalType: 'unknown' },
    {
      version: 1,
      kind: 'failure',
      stage: 'serialization',
      originalType: 'object',
      message: CANARY,
    },
    { version: 1, kind: 'success', originalType: 'string', payloadJson: 42 },
    { version: 1, kind: 'success', originalType: 'string' },
    { version: 1, kind: 'success', originalType: 'unknown', payloadJson: 'null' },
    { version: 1, kind: 'success', originalType: 'string', payloadJson: '"ok"', extra: CANARY },
    {
      version: 1,
      kind: 'success',
      originalType: 'number',
      payloadJson: 'null',
      numberTag: 'unknown',
    },
    { version: 1, kind: 'success', originalType: 'number', payloadJson: 'null', numberTag: 0 },
  ])('rejects malformed arm %# with fixed content-free diagnostics', (arm) =>
    expectFailure(JSON.stringify(arm)),
  );

  it.each(['', '{', CANARY, '{"version":1,"kind":"denied"} trailing'])(
    'refuses malformed JSON %#',
    (text) => expectFailure(text),
  );

  it('rejects own prototype-shaped extras', () => {
    expectFailure('{"version":1,"kind":"denied","__proto__":{"polluted":true}}');
  });
});

describe('typed payload and numeric tags', () => {
  it.each<[string, string, unknown]>([
    ['boolean', 'true', true],
    ['string', '"value"', 'value'],
    ['number', '42', 42],
    ['object', '{"nested":[1,null]}', { nested: [1, null] }],
    ['object', 'null', null],
    ['undefined', 'null', null],
    ['function', 'null', null],
    ['symbol', 'null', null],
    ['bigint', 'null', null],
  ])(
    'decodes %s independently of evaluation-kind validation',
    (originalType, payloadJson, expected) => {
      expect(
        decode(JSON.stringify({ version: 1, kind: 'success', originalType, payloadJson })),
      ).toEqual(expected);
    },
  );

  it.each<[string, number]>([
    ['nan', Number.NaN],
    ['positive_infinity', Number.POSITIVE_INFINITY],
    ['negative_infinity', Number.NEGATIVE_INFINITY],
    ['negative_zero', -0],
  ])('preserves exact %s tag', (numberTag, expected) => {
    expect(
      decode(
        JSON.stringify({
          version: 1,
          kind: 'success',
          originalType: 'number',
          payloadJson: 'null',
          numberTag,
        }),
      ),
    ).toBe(expected);
  });

  it.each([
    ['boolean', '"true"'],
    ['string', 'false'],
    ['number', 'null'],
    ['number', '"42"'],
    ['number', '1e400'],
    ['undefined', '{}'],
    ['function', 'false'],
    ['symbol', '[]'],
    ['bigint', '1'],
    ['object', CANARY],
    ['string', '{'],
  ])('refuses inconsistent %s payload %s', (originalType, payloadJson) => {
    expectFailure(JSON.stringify({ version: 1, kind: 'success', originalType, payloadJson }));
  });

  it.each(['nan', 'positive_infinity', 'negative_infinity', 'negative_zero'])(
    'rejects %s on wrong type or non-null payload',
    (numberTag) => {
      expectFailure(
        JSON.stringify({
          version: 1,
          kind: 'success',
          originalType: 'object',
          payloadJson: 'null',
          numberTag,
        }),
      );
      expectFailure(
        JSON.stringify({
          version: 1,
          kind: 'success',
          originalType: 'number',
          payloadJson: '0',
          numberTag,
        }),
      );
    },
  );
});

describe('active transport byte cap', () => {
  it.each(['ascii', 'é', '漢', '😀', '\ud800', 'mixed-é-漢-😀'])(
    'accepts exact UTF-8 capacity and rejects one byte below: %s',
    (value) => {
      const text = JSON.stringify({
        version: 1,
        kind: 'success',
        originalType: 'string',
        payloadJson: JSON.stringify(value.repeat(16)),
      });
      // Independent platform reference; do not derive the expected cap with the implementation helper.
      const bytes = Buffer.byteLength(text, 'utf8');
      expect(decode(text, bytes)).toBe(value.repeat(16));
      expectFailure(text, 'memory', bytes - 1);
    },
  );

  it('refuses ASCII length overflow before parsing malformed transport', () => {
    const text = CANARY.repeat(8);
    expect(text.length).toBe(Buffer.byteLength(text, 'utf8'));
    expectFailure(text, 'memory', text.length - 1);
  });

  it('counts multibyte transport after the cheap character-length screen passes', () => {
    const text = JSON.stringify({
      version: 1,
      kind: 'success',
      originalType: 'string',
      payloadJson: JSON.stringify('😀'.repeat(128)),
    });
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(text.length);
    expectFailure(text, 'memory', text.length);
  });
});
