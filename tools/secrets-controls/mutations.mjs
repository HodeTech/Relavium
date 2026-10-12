/** Step 3's independent production mechanisms and completed named semantic witnesses. */
const reader = 'apps/cli/src/secrets/read-secret.ts';
const readerCases = ['apps/cli/src/secrets/read-secret.test.ts'];
const llmError = 'packages/llm/src/llm-error.ts';
const overlapFiles = [
  'packages/llm/src/llm-error.test.ts',
  'apps/cli/src/render/sanitize.test.ts',
  'apps/cli/src/process/render-error.test.ts',
];
const overlapNames = [
  'client_secret',
  'refresh_token',
  'id_token',
  'auth_token',
  'session_token',
  'api_secret',
  'access_key',
  'secret_key',
];
const overlapMarker = 'SECRETS_CAUSAL_OVERLAP_ORDER';
function control(id, path, before, after, files, expectedTests, target, marker, witnesses = []) {
  return { id, path, before, after, files, expectedTests, target, marker, witnesses };
}
function overlapWitnesses(shape) {
  return [
    ...overlapNames.map((name) => ({
      target: `${overlapMarker} protects ${name} ${shape} before query redaction`,
      marker: overlapMarker,
    })),
    ...overlapNames.flatMap((name) =>
      ['multiline', 'inline'].map((label) => ({
        target: `${overlapMarker} protects '${name}' '${shape}' query values: '${label}'`,
        marker: overlapMarker,
      })),
    ),
    ...['human', 'human verbose', 'JSON', 'JSON verbose'].map((label) => ({
      target: `${overlapMarker} protects '${shape}' query values in '${label}' diagnostics`,
      marker: overlapMarker,
    })),
    {
      target: `${overlapMarker} protects a pre-scrubbed ${shape} in a verbose stack`,
      marker: overlapMarker,
    },
  ];
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
    98,
    'SECRETS_CAUSAL_QUERY_NAMES masks each added family without another credential shape',
    'SECRETS_CAUSAL_QUERY_NAMES',
  ),
  control(
    'diagnostic-residual-scrub',
    'apps/cli/src/render/sanitize.ts',
    '  const scrubbed = scrubSecrets(normalized);',
    `  const scrubbed = scrubSecrets(normalized);
  if (scrubbed !== normalized) return scrubbed;`,
    ['apps/cli/src/render/sanitize.test.ts', 'apps/cli/src/process/render-error.test.ts'],
    161,
    "SECRETS_CAUSAL_RESIDUAL_SCRUB protects 'client_secret' beside a split credential: 'multiline'",
    'SECRETS_CAUSAL_RESIDUAL_SCRUB',
    [
      ...[
        'client_secret',
        'refresh_token',
        'id_token',
        'auth_token',
        'session_token',
        'api_secret',
        'access_key',
        'secret_key',
      ].flatMap((name) =>
        ['multiline', 'inline']
          .filter((label) => name !== 'client_secret' || label !== 'multiline')
          .map((label) => ({
            target: `SECRETS_CAUSAL_RESIDUAL_SCRUB protects '${name}' beside a split credential: '${label}'`,
            marker: 'SECRETS_CAUSAL_RESIDUAL_SCRUB',
          })),
      ),
      ...['human', 'human verbose', 'JSON', 'JSON verbose'].map((label) => ({
        target: `SECRETS_CAUSAL_RESIDUAL_SCRUB protects mixed credentials in '${label}' diagnostics`,
        marker: 'SECRETS_CAUSAL_RESIDUAL_SCRUB',
      })),
      {
        target:
          'SECRETS_CAUSAL_RESIDUAL_SCRUB protects a mixed-credential verbose stack with a benign message',
        marker: 'SECRETS_CAUSAL_RESIDUAL_SCRUB',
      },
    ],
  ),
  control(
    'prefix-before-redaction',
    'packages/llm/src/llm-error.ts',
    "    const joined = remaining.replace(/\\s+/g, '');",
    '    const joined = remaining;',
    [
      'packages/llm/src/llm-error.test.ts',
      'apps/cli/src/render/sanitize.test.ts',
      'apps/cli/src/process/render-error.test.ts',
    ],
    259,
    'SECRETS_CAUSAL_PREFIX_ORDER protects client_secret before overlapping query redaction',
    'SECRETS_CAUSAL_PREFIX_ORDER',
    [
      ...[
        'refresh_token',
        'id_token',
        'auth_token',
        'session_token',
        'api_secret',
        'access_key',
        'secret_key',
      ].map((name) => ({
        target: `SECRETS_CAUSAL_PREFIX_ORDER protects ${name} before overlapping query redaction`,
        marker: 'SECRETS_CAUSAL_PREFIX_ORDER',
      })),
      ...[
        'client_secret',
        'refresh_token',
        'id_token',
        'auth_token',
        'session_token',
        'api_secret',
        'access_key',
        'secret_key',
      ].flatMap((name) =>
        ['multiline', 'inline'].map((label) => ({
          target: `SECRETS_CAUSAL_PREFIX_ORDER protects '${name}' query values: '${label}'`,
          marker: 'SECRETS_CAUSAL_PREFIX_ORDER',
        })),
      ),
      ...['human', 'human verbose', 'JSON', 'JSON verbose'].map((label) => ({
        target: `SECRETS_CAUSAL_PREFIX_ORDER protects overlapping query values in '${label}' diagnostics`,
        marker: 'SECRETS_CAUSAL_PREFIX_ORDER',
      })),
      {
        target:
          'SECRETS_CAUSAL_PREFIX_ORDER protects a pre-scrubbed overlapping query in a verbose stack',
        marker: 'SECRETS_CAUSAL_PREFIX_ORDER',
      },
      ...overlapWitnesses('URL userinfo'),
    ],
  ),
  control(
    'normalized-secret-probe',
    llmError,
    '  return stripTerminalControls(text);',
    '  return text;',
    overlapFiles,
    259,
    `${overlapMarker} protects client_secret normalized key before query redaction`,
    overlapMarker,
    overlapWitnesses('normalized key').filter(
      (witness) =>
        witness.target !==
        `${overlapMarker} protects client_secret normalized key before query redaction`,
    ),
  ),
  control(
    'non-query-before-query',
    llmError,
    '  return scrubQuerySecrets(scrubNonQuerySecrets(text));',
    '  return scrubNonQuerySecrets(scrubQuerySecrets(text));',
    overlapFiles,
    259,
    `${overlapMarker} protects client_secret Bearer before query redaction`,
    overlapMarker,
    [
      ...overlapWitnesses('Bearer').filter(
        (witness) =>
          witness.target !==
          `${overlapMarker} protects client_secret Bearer before query redaction`,
      ),
      ...overlapWitnesses('Basic'),
    ],
  ),
];
