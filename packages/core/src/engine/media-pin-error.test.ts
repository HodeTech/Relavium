import { MediaAdmissionError, type MediaAdmissionErrorCode } from '@relavium/shared';
import { expect, it } from 'vitest';

import { NodeMediaPinError } from './media-pin-error.js';

it.each([
  'unsupported_mime',
  'invalid_descriptor',
  'descriptor_conflict',
  'invalid_format',
  'inspection_limit',
  'object_limit',
  'inline_limit',
  'unsafe_value',
  'source_failed',
  'stream_incomplete',
] satisfies readonly MediaAdmissionErrorCode[])(
  'classifies %s as a fixed nonretryable validation refusal',
  (code) => {
    const failure = NodeMediaPinError.from(new MediaAdmissionError(code), 'work', false).failure;
    expect(failure).toEqual({
      code: 'validation',
      retryable: false,
      message: `node \`work\` produced media that could not be re-hosted: ${new MediaAdmissionError(code).message}`,
    });
  },
);
it.each([
  'store_unavailable',
  'store_contract',
  'source_unavailable',
  'verifier_state',
] satisfies readonly MediaAdmissionErrorCode[])(
  'classifies %s as a host-contract failure',
  (code) => {
    expect(
      NodeMediaPinError.from(new MediaAdmissionError(code), 'work', false).failure,
    ).toMatchObject({ code: 'internal', retryable: false });
  },
);
it.each(['network', 'timeout'])('preserves %s without repeating paid work', (code) => {
  const failure = NodeMediaPinError.from(
    { code, message: 'PRIVATE source credential' },
    'work',
    false,
  ).failure;
  expect(failure).toMatchObject({ code: 'provider_unavailable', retryable: false });
  expect(failure.message).not.toContain('PRIVATE');
});
it('cancellation wins over a typed format refusal', () => {
  expect(
    NodeMediaPinError.from(new MediaAdmissionError('invalid_format'), 'work', true).failure,
  ).toEqual({ code: 'cancelled', message: 'the run was cancelled', retryable: false });
});
