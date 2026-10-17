import { describe, expect, it } from 'vitest';

import { scrubSecrets as rootScrubSecrets } from './index.js';
import { makeLlmError, scrubSecrets as errorScrubSecrets } from './llm-error.js';
import { scrubSecrets } from './scrub-secrets.js';

// Synthetic credentials assembled from fragments, never real provider material.
const key = ['sk-', 'ant-', 'api03-', 'AbCdEf0123456789xyz'].join('');
const googleKey = ['AI', 'za', 'SyA1234567890abcdefghijklmnopqrstuv'].join('');

const compatibleDiagnostics = [
  { input: `invalid ${key}; retry later`, expected: 'invalid [REDACTED]; retry later' },
  { input: `invalid ${googleKey}; retry later`, expected: 'invalid [REDACTED]; retry later' },
  {
    input: 'https://user:opaque@provider.invalid/x',
    expected: 'https://[REDACTED]@provider.invalid/x',
  },
  { input: 'https://opaque@provider.invalid/x', expected: 'https://[REDACTED]@provider.invalid/x' },
  {
    input: 'Authorization: Bearer opaque-value rejected',
    expected: 'Authorization: Bearer [REDACTED] rejected',
  },
  {
    input: 'Authorization: Basic dXNlcjpwYXNz rejected',
    expected: 'Authorization: Basic [REDACTED] rejected',
  },
  {
    input: '?client_secret=opaque&ordinary=kept#visible',
    expected: '?client_secret=[REDACTED]&ordinary=kept#visible',
  },
  { input: key.slice(0, 12) + '\u0001' + key.slice(12), expected: '[REDACTED]' },
  { input: key.slice(0, 12) + '\n\t' + key.slice(12), expected: '[REDACTED]' },
  { input: `?api_secret=sk-ant-api03-\nAbCdEf0123456789xyz`, expected: '[REDACTED]' },
  { input: `?token=opaque; https://u\nser:opaque@provider.invalid/x`, expected: '[REDACTED]' },
  { input: `?token=opaque; Bear\u202eer opaque-value`, expected: '[REDACTED]' },
  // Literal query names, word boundaries and masked spans retain their finite scope.
  { input: '?api%5fkey=opaque', expected: '?api%5fkey=opaque' },
  { input: '?client_secret_hint=ordinary', expected: '?client_secret_hint=ordinary' },
  { input: '?api_\nkey=opaque', expected: '?api_\nkey=opaque' },
  { input: 'sk-short', expected: 'sk-short' },
  {
    input: 'ordinary prompt prose with an opaque value',
    expected: 'ordinary prompt prose with an opaque value',
  },
  {
    input: '\u001b[31mrate limited\u001b[0m\nretry after 30s',
    expected: '\u001b[31mrate limited\u001b[0m\nretry after 30s',
  },
  { input: '', expected: '' },
];

describe('pure scrub-secrets leaf compatibility', () => {
  it('preserves the source root and llm-error function identities', () => {
    expect(errorScrubSecrets).toBe(scrubSecrets);
    expect(rootScrubSecrets).toBe(scrubSecrets);
  });

  it.each(compatibleDiagnostics)('preserves exact redaction for $input', ({ input, expected }) => {
    expect(scrubSecrets(input)).toBe(expected);
    const error = makeLlmError({ provider: 'openai', kind: 'auth', message: input, code: input });
    expect(error.message).toBe(expected);
    expect(error.code).toBe(expected);
  });
});

describe('finite diagnostic credential backstop regressions (PR #95 M2)', () => {
  const protectedDiagnostics = [
    {
      input: 'connect https://alice:opaque@password@provider.invalid/v1 failed',
      expected: 'connect https://[REDACTED]@provider.invalid/v1 failed',
    },
    {
      input: 'connect https://alice:opaque:password@@provider.invalid/v1 failed',
      expected: 'connect https://[REDACTED]@provider.invalid/v1 failed',
    },
    ...['http', 'https', 'ws', 'wss', 'ftp', 'ftps'].flatMap((scheme) => [
      {
        input: `connect ${scheme}://alice:opaque-password@provider.invalid/v1 failed`,
        expected: `connect ${scheme}://[REDACTED]@provider.invalid/v1 failed`,
      },
      {
        input: `connect ${scheme.toUpperCase()}://opaque-user@provider.invalid/v1 failed`,
        expected: `connect ${scheme.toUpperCase()}://[REDACTED]@provider.invalid/v1 failed`,
      },
    ]),
    ...['api-key', 'x-api-key', 'x-goog-api-key'].flatMap((name) => [
      {
        input: `header ${name}: opaque-header-Z29 rejected`,
        expected: `header ${name}: [REDACTED] rejected`,
      },
      {
        input: `header ${name.toUpperCase()}: opaque-header-Z29 rejected`,
        expected: `header ${name.toUpperCase()}: [REDACTED] rejected`,
      },
      {
        input: `{"${name}":"opaque-header-Z29","ordinary":"kept"}`,
        expected: `{"${name}":"[REDACTED]","ordinary":"kept"}`,
      },
    ]),
    ...['\n', '\t'].flatMap((separator) => [
      {
        input: `Bear${separator}er opaque-header-Z29 rejected`,
        expected: 'Bearer [REDACTED] rejected',
      },
      { input: `Bas${separator}ic dXNlcjpwYXNz rejected`, expected: 'Basic [REDACTED] rejected' },
      {
        input: `wss://ali${separator}ce:opaque@password@provider.invalid/v1`,
        expected: '[REDACTED]',
      },
      {
        input: `https://alice:opaque@pass${separator}word@provider.invalid/v1`,
        expected: '[REDACTED]',
      },
    ]),
    {
      input: 'header x-api-\u0001key: opaque-header-Z29 rejected',
      expected: '[REDACTED]',
    },
    {
      input: '?token=opaque; w\u0001ss://alice:opaque-password@provider.invalid/v1',
      expected: '[REDACTED]',
    },
  ];

  it.each(protectedDiagnostics)('protects the finite diagnostic $input', ({ input, expected }) => {
    expect(scrubSecrets(input)).toBe(expected);
    const error = makeLlmError({ provider: 'openai', kind: 'auth', message: input, code: input });
    expect(error.message).toBe(expected);
    expect(error.code).toBe(expected);
  });

  it('protects each internal LF/TAB split position in the finite Bearer/Basic labels', () => {
    for (const label of ['Bearer', 'Basic']) {
      for (const separator of ['\n', '\t', '\n\t']) {
        for (let position = 1; position < label.length; position += 1) {
          const input = `${label.slice(0, position)}${separator}${label.slice(position)} opaque-header-Z29`;
          expect(scrubSecrets(input)).toBe(`${label} [REDACTED]`);
        }
      }
    }
  });

  it('retains independent prefixed-key evidence before a new header can erase its prefix', () => {
    const input = `x-api-key: ${key.slice(0, 12)}\n${key.slice(12)}`;
    expect(scrubSecrets(input)).toBe('[REDACTED]');
    const error = makeLlmError({ provider: 'openai', kind: 'auth', message: input, code: input });
    expect(error.message).toBe('[REDACTED]');
    expect(error.code).toBe('[REDACTED]');
  });

  it.each([
    'connect wss://provider.invalid/v1 failed',
    'connect https://provider.invalid/user@public failed',
    'connect https://provider.invalid/?contact=alice@example.invalid failed',
    'connect https://provider.invalid/#contact=alice@example.invalid failed',
    'api-key-hint: ordinary',
    'prefix-api-key: ordinary',
    'x-api-key-count: ordinary',
    'x-api-key=ordinary',
    '{"api-key-hint":"ordinary"}',
    'Authorization: Bearer [REDACTED]\nrequest failed retry later',
    'Authorization: Basic [REDACTED]\nrequest failed retry later',
    'x-api-key: [REDACTED]\nrequest failed retry later',
  ])('preserves benign or already masked diagnostics %s', (input) => {
    expect(scrubSecrets(input)).toBe(input);
  });

  it.each(['Bearer opaque-header-Z29', 'Basic dXNlcjpwYXNz', 'x-api-key: opaque-header-Z29'])(
    'preserves separate following diagnostic prose after %s',
    (credential) => {
      const input = `${credential}\nrequest failed retry later`;
      const expected = `${credential.split(' ')[0]} [REDACTED]\nrequest failed retry later`;
      expect(scrubSecrets(input)).toBe(expected);
    },
  );
});
