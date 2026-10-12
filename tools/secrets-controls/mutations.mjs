/** Step 3's independent production mechanisms and completed named semantic witnesses. */
const reader = 'apps/cli/src/secrets/read-secret.ts';
const readerCases = ['apps/cli/src/secrets/read-secret.test.ts'];
function control(id, path, before, after, files, expectedTests, target, marker, witnesses = []) {
  return { id, path, before, after, files, expectedTests, target, marker, witnesses };
}
export const mutations = [
  control(
    'stdin-cap',
    reader,
    'const MAX_SECRET_BYTES = 65_536;',
    'const MAX_SECRET_BYTES = 131_072;',
    readerCases,
    31,
    'admits exact capacity and refuses aggregate overflow: single Buffer',
    'secrets-stdin-aggregate-cap',
    [
      ...['single string', 'mixed chunks'].map((label) => ({
        target: `admits exact capacity and refuses aggregate overflow: ${label}`,
        marker: 'secrets-stdin-aggregate-cap',
      })),
      ...['single Buffer', 'single string', 'whitespace'].map((label) => ({
        target: `refuses a single oversized chunk before copying or scanning: ${label}`,
        marker: 'secrets-stdin-single-cap',
      })),
    ],
  ),
  control(
    'stdin-ownership',
    reader,
    `owned = Buffer.allocUnsafe(size);
          // Native set reads the Buffer's internal bytes, never its iterator/valueOf/index getters.
          Uint8Array.prototype.set.call(owned, chunk);`,
    'owned = chunk;',
    readerCases,
    31,
    'owns admitted Buffer bytes before advancing a source that reuses them',
    'secrets-stdin-buffer-ownership',
  ),
  control(
    'stdin-zero-retention',
    reader,
    'if (size === 0) continue;',
    'void size;',
    readerCases,
    31,
    'skips zero-byte chunks without retaining or copying them',
    'secrets-stdin-zero-copy',
  ),
  control(
    'stdin-cleanup',
    reader,
    'await iterator.return?.();',
    'void iterator.return?.()?.catch(() => {});',
    readerCases,
    31,
    'awaits early cleanup exactly once with its receiver and does not pull after overflow',
    'secrets-stdin-cleanup-awaited',
  ),
  control(
    'stdin-source-error',
    reader,
    "'could not read secret input from stdin.'",
    'cause instanceof Error ? cause.message : String(cause)',
    readerCases,
    31,
    'normalizes every foreign failure at isTTY to a fresh fixed error',
    'secrets-stdin-source-error',
    [
      'factory-get',
      'factory-call',
      'next-get',
      'next-call',
      'next-reject',
      'done',
      'value',
      'buffer-size',
    ].map((boundary) => ({
      target: `normalizes every foreign failure at ${boundary} to a fresh fixed error`,
      marker: 'secrets-stdin-source-error',
    })),
  ),
  ...[
    ['get', 'OS keychain is unavailable.'],
    ['set', 'could not write to the OS keychain.'],
    ['delete', 'could not access the OS keychain.'],
  ].map(([operation, message]) =>
    control(
      `keychain-${operation}`,
      'apps/cli/src/secrets/os-keychain.ts',
      `'${message}'`,
      'err instanceof Error ? err.message : String(err)',
      ['apps/cli/src/secrets/os-keychain.test.ts'],
      50,
      `SECRETS_CAUSAL_KEYCHAIN_${operation.toUpperCase()} ${operation} wraps constructor Error with opaque content without inspecting it`,
      `SECRETS_CAUSAL_KEYCHAIN_${operation.toUpperCase()}`,
      [
        {
          target: `SECRETS_CAUSAL_KEYCHAIN_${operation.toUpperCase()} ${operation} wraps method Error with opaque content without inspecting it`,
          marker: `SECRETS_CAUSAL_KEYCHAIN_${operation.toUpperCase()}`,
        },
      ],
    ),
  ),
  control(
    'query-names',
    'packages/llm/src/llm-error.ts',
    String.raw`/([?&](?:(?:x[-_])?api[-_]?key|api[-_]?secret|(?:access|secret)[-_]?key|(?:access|refresh|id|auth|session)[-_]?token|client[-_]?secret|key|token|auth|password|secret)=)[^&\s#]+/gi`,
    String.raw`/([?&](?:(?:x[-_])?api[-_]?key|key|token|access[-_]?token|auth|password|secret)=)[^&\s#]+/gi`,
    ['packages/llm/src/llm-error.test.ts'],
    52,
    'SECRETS_CAUSAL_QUERY_NAMES masks each added family without another credential shape',
    'SECRETS_CAUSAL_QUERY_NAMES',
  ),
];
