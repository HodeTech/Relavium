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

function expectCredentialDiagnostic(value: unknown) {
  return expect(value, 'SECRETS_B2_LLM_DIAGNOSTIC');
}

describe('PR95 B2 split provider/header and malformed userinfo diagnostics', () => {
  it('masks every LF/TAB split including a complete-looking first key fragment', () => {
    for (const prefix of ['sk-', 'sk-proj-', 'sk-svcacct-', 'sk-ant-', 'AIza']) {
      const credential = `${prefix}${'A'.repeat(32)}_${'B'.repeat(32)}`;
      for (const separator of ['\n', '\t']) {
        for (let index = 1; index < credential.length; index += 1) {
          const input = `provider rejected ${credential.slice(0, index)}${separator}${credential.slice(index)}; retry later`;
          expectCredentialDiagnostic(scrubSecrets(input)).toBe('[REDACTED]');
          const error = makeLlmError({
            provider: 'openai',
            kind: 'auth',
            message: input,
            code: input,
          });
          expectCredentialDiagnostic(error.message).toBe('[REDACTED]');
          expectCredentialDiagnostic(error.code).toBe('[REDACTED]');
        }
      }
    }
  });

  it('masks each split position in the finite API header names', () => {
    for (const name of ['api-key', 'x-api-key', 'x-goog-api-key']) {
      for (const separator of ['\n', '\t']) {
        for (let index = 1; index < name.length; index += 1) {
          const input = `header ${name.slice(0, index)}${separator}${name.slice(index)}: opaque-Z29; retry later`;
          expectCredentialDiagnostic(scrubSecrets(input)).toBe('[REDACTED]');
        }
      }
    }
  });

  it.each(['?', '#'])(
    'masks raw %s in userinfo while retaining host contact queries',
    (separator) => {
      expectCredentialDiagnostic(
        scrubSecrets(`https://alice:pa${separator}ss@provider.invalid/v1`),
      ).toBe('https://[REDACTED]@provider.invalid/v1');
      for (const host of ['provider.invalid', 'provider.invalid:8443', '[::1]:8443']) {
        const input = `https://${host}${separator}contact=alice@example.invalid`;
        expectCredentialDiagnostic(scrubSecrets(input)).toBe(input);
      }
    },
  );

  it('scrubs admitted-scale key and URL values without consuming the RegExp stack', () => {
    const body = 'A'.repeat(8 * 1024 * 1024 - 256);
    expectCredentialDiagnostic(scrubSecrets(`provider rejected sk-proj-${body}; retry`)).toBe(
      'provider rejected [REDACTED]; retry',
    );
    const url = scrubSecrets(`https://alice:${body}?ss@provider.invalid/v1`);
    // A removed recognizer must fail without serializing an admitted-size credential into evidence.
    expectCredentialDiagnostic(url.length).toBe('https://[REDACTED]@provider.invalid/v1'.length);
    expectCredentialDiagnostic(url).toBe('https://[REDACTED]@provider.invalid/v1');
  });
});

describe('PR95 B2 finite joined-view boundaries', () => {
  it.each([
    ['sk-proj-', '\n'],
    ['sk-proj-', '\t'],
    ['AIza', '\n'],
    ['AIza', '\t'],
  ])('keeps the original boundary after an embedded greedy prefix %s (%j)', (prefix, separator) => {
    const input = `word${prefix}${'A'.repeat(32)}${separator}${prefix}${'B'.repeat(32)}${separator}${'C'.repeat(32)}; public=A`;
    expect(scrubSecrets(input), 'SECRETS_B2_ORIGINAL_BOUNDARY').toBe('[REDACTED]');
    const error = makeLlmError({ provider: 'openai', kind: 'auth', message: input, code: input });
    expect(error.message, 'SECRETS_B2_ORIGINAL_BOUNDARY').toBe('[REDACTED]');
    expect(error.code, 'SECRETS_B2_ORIGINAL_BOUNDARY').toBe('[REDACTED]');
  });

  it('bounds admitted-size embedded prefixes before a valid original boundary', () => {
    const fragment = `wordsk-proj-${'A'.repeat(52)}\n`;
    const publicPrefix = fragment.repeat(Math.floor((8 * 1024 * 1024 - 256) / fragment.length));
    const input = `${publicPrefix}sk-proj-${'B'.repeat(32)}\t${'C'.repeat(32)}; public=A`;
    const started = performance.now();
    const output = scrubSecrets(input);
    // Keep removal evidence bounded: a regression must not serialize eight MiB into its report.
    expect(output.length, 'SECRETS_B2_ORIGINAL_BOUNDARY').toBe('[REDACTED]'.length);
    expect(output, 'SECRETS_B2_ORIGINAL_BOUNDARY').toBe('[REDACTED]');
    expect(performance.now() - started, 'SECRETS_B2_ORIGINAL_BOUNDARY').toBeLessThan(5_000);
  });

  it('does not invent a key boundary in a public word with a separate newline', () => {
    const input = `wordsk-proj-${'A'.repeat(32)};\nordinary`;
    expectCredentialDiagnostic(scrubSecrets(input)).toBe(input);
    const splitEmbedded = `wordsk-proj-${'A'.repeat(32)}\n${'B'.repeat(32)}; retry`;
    expectCredentialDiagnostic(scrubSecrets(splitEmbedded)).toBe(splitEmbedded);
    expectCredentialDiagnostic(
      scrubSecrets(`rejected\nsk-proj-AAA\t${'B'.repeat(32)}; retry`),
    ).toBe('[REDACTED]');
  });

  it.each(['?', '#'])(
    'preserves public %s tails after userinfo and masks raw password assignments',
    (separator) => {
      expectCredentialDiagnostic(
        scrubSecrets(`https://u:password@host.invalid${separator}contact=a@example.invalid`),
      ).toBe(`https://[REDACTED]@host.invalid${separator}contact=a@example.invalid`);
      expectCredentialDiagnostic(
        scrubSecrets(`https://u:pa${separator}ss=value@host.invalid/v1`),
      ).toBe('https://[REDACTED]@host.invalid/v1');
    },
  );

  it('treats LF/TAB token-character continuations as credential material even after a complete first fragment', () => {
    expectCredentialDiagnostic(
      scrubSecrets(`sk-proj-${'A'.repeat(32)}\nrequest; retry later`),
    ).toBe('[REDACTED]');
    expectCredentialDiagnostic(
      scrubSecrets(`sk-proj-${'A'.repeat(32)}\n request; retry later`),
    ).toBe('[REDACTED]\n request; retry later');
  });
});
