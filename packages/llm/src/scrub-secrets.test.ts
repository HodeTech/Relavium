import { afterEach, describe, expect, it, vi } from 'vitest';

import { toFixedPoint } from './fixed-point.js';
import { scrubSecrets as rootScrubSecrets } from './index.js';
import { makeLlmError, scrubSecrets as errorScrubSecrets } from './llm-error.js';
import { scrubSecrets } from './scrub-secrets.js';

// Observe the scrubber's bounded fixed point, retaining its actual implementation, so one case can
// make it fail and see which value the scrubber fails closed with.
vi.mock('./fixed-point.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fixed-point.js')>();
  return { ...actual, toFixedPoint: vi.fn(actual.toFixedPoint) };
});

// The observation must not keep admitted-size inputs and outputs alive for the whole file.
afterEach(() => {
  vi.mocked(toFixedPoint).mockClear();
});

// Synthetic credentials assembled from fragments, never real provider material.
const key = ['sk-', 'ant-', 'api03-', 'AbCdEf0123456789xyz'].join('');
const googleKey = ['AI', 'za', 'SyA1234567890abcdefghijklmnopqrstuv'].join('');

/**
 * Eight-MiB cases take about a second. Their bound is this case deadline, far below the minutes a
 * quadratic scan would need, rather than a wall-clock assertion that a loaded runner can trip. It is
 * also the largest case budget the secrets causal-control phases admit (`CAUSAL_TIMEOUT_BUDGET`).
 */
const ADMITTED_SIZE_CASE_TIMEOUT_MS = 15_000;

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
    // A scheme glued to a preceding word character: the pre-PR matcher masked it for http(s), and a `\b` on
    // the rule let it through (PR #95 review, MEDIUM-1). ws/wss/ftp/ftps are this PR's additions and get
    // the same word-adjacency, so those cases pin new behaviour, not parity. Adjacent and LF/TAB-split
    // forms are both pinned.
    ...['http', 'https', 'ws', 'wss', 'ftp', 'ftps'].flatMap((scheme) => [
      {
        input: `x${scheme}://alice:opaque-password@provider.invalid/v1`,
        expected: `x${scheme}://[REDACTED]@provider.invalid/v1`,
      },
      {
        input: `1${scheme.toUpperCase()}://opaque-user@provider.invalid/v1`,
        expected: `1${scheme.toUpperCase()}://[REDACTED]@provider.invalid/v1`,
      },
    ]),
    ...['\n', '\t'].map((separator) => ({
      input: `xhttps://ali${separator}ce:opaque-password@provider.invalid/v1`,
      expected: '[REDACTED]',
    })),
    // A glued, split credential that also contains a raw `@` used to leave a partial mask with the rest
    // of the credential visible: the scanner skipped starts preceded by a word character (security
    // sitting, PR #95 post-merge review). A clean-prefix twin was already redacted whole.
    {
      input: 'x\u0000https://u@e.com:pw\nxyz@provider.invalid/v1',
      expected: '[REDACTED]',
    },
    {
      input: 'xhttps://user:p@ss\tword@provider.invalid/v1',
      expected: '[REDACTED]',
    },
    {
      input: '_https://alice:opaque-password@provider.invalid/v1',
      expected: '_https://[REDACTED]@provider.invalid/v1',
    },
    {
      input: 'xht\ntps://alice:opaque-password@provider.invalid/v1',
      expected: '[REDACTED]',
    },
    {
      input: 'a http://u1:p1@h1.invalid/x and xhttps://u2:p2@h2.invalid/y',
      expected: 'a http://[REDACTED]@h1.invalid/x and xhttps://[REDACTED]@h2.invalid/y',
    },
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
        expected: `Bear${separator}er [REDACTED] rejected`,
      },
      {
        input: `Bas${separator}ic dXNlcjpwYXNz rejected`,
        expected: `Bas${separator}ic [REDACTED] rejected`,
      },
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

  // Documents, and does not endorse, two consequences of a URL rule with no word boundary. Both fail
  // closed: they blank or widen a diagnostic rather than reveal one. The whitespace-stripped residual probe
  // glues the prose before a URL to its scheme, and an unlisted longer scheme name matches by its suffix.
  it.each([
    {
      input: 'Error: ECONNREFUSED http://127.0.0.1:11434 contact admin@corp',
      expected: '[REDACTED]',
    },
    {
      input: 'MCP server at ws://127.0.0.1:8080 refused; email support@vendor.com',
      expected: '[REDACTED]',
    },
    {
      input: 'Error: connect ECONNREFUSED postgres://db.example:5432 contact dba@corp',
      expected: '[REDACTED]',
    },
    { input: 'gftp://scm@code.example/x', expected: 'gftp://[REDACTED]@code.example/x' },
  ])('fails closed on the documented trade-off $input', ({ input, expected }) => {
    expect(scrubSecrets(input)).toBe(expected);
  });

  it('protects each internal LF/TAB split position in the finite Bearer/Basic labels', () => {
    for (const label of ['Bearer', 'Basic']) {
      for (const separator of ['\n', '\t', '\n\t']) {
        for (let position = 1; position < label.length; position += 1) {
          const split = `${label.slice(0, position)}${separator}${label.slice(position)}`;
          expect(scrubSecrets(`${split} opaque-header-Z29`)).toBe(`${split} [REDACTED]`);
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
          // JSON-encoded JSON; the inner mask keeps the whitespace-stripped residual from answering.
          const escaped = `{\\"${name.slice(0, index)}${separator}${name.slice(index)}\\":\\"[REDACTED]opaque-Z29\\"}`;
          expectCredentialDiagnostic(scrubSecrets(escaped)).toBe('[REDACTED]');
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
    ['x-', '\n', '\t'],
    ['x-', '\t', '\n'],
    ['x-goog-', '\n', '\t'],
    ['x-goog-', '\t', '\n'],
  ])(
    'recovers the original finite header boundary after embedded %s (%j)',
    (prefix, boundary, split) => {
      for (const publicTail of ['A', 'B']) {
        const input = `word${prefix}${boundary}api-${split}key: opaque-Z29; public=${publicTail}`;
        expect(scrubSecrets(input), 'SECRETS_B2_HEADER_ORIGINAL_BOUNDARY').toBe('[REDACTED]');
        const error = makeLlmError({
          provider: 'openai',
          kind: 'auth',
          message: input,
          code: input,
        });
        expect(error.message, 'SECRETS_B2_HEADER_ORIGINAL_BOUNDARY').toBe('[REDACTED]');
        expect(error.code, 'SECRETS_B2_HEADER_ORIGINAL_BOUNDARY').toBe('[REDACTED]');
        const embedded = `word${prefix}api-${split}key: opaque-Z29; public=${publicTail}`;
        expect(scrubSecrets(embedded), 'SECRETS_B2_HEADER_ORIGINAL_BOUNDARY').toBe(embedded);
        expect(
          scrubSecrets(`api-key: opaque-Z29; public=${publicTail}`),
          'SECRETS_B2_HEADER_ORIGINAL_BOUNDARY',
        ).toBe(`api-key: [REDACTED]; public=${publicTail}`);
      }
    },
  );

  it(
    'bounds admitted-size failed header and URL preparation',
    () => {
      for (const fragment of ['wordx-\tapi-\nkey ', 'https:\n//provider.invalid/']) {
        const input = fragment.repeat(Math.floor((8 * 1024 * 1024 - 256) / fragment.length));
        const output = scrubSecrets(input);
        expect(output.length, 'SECRETS_B2_HEADER_PREPARATION').toBe(input.length);
        expect(output === input, 'SECRETS_B2_HEADER_PREPARATION').toBe(true);
      }
    },
    ADMITTED_SIZE_CASE_TIMEOUT_MS,
  );

  it(
    'reaches the split URL scan over admitted-size letter-heavy text',
    () => {
      const letters = 8 * 1024 * 1024 - 256;
      for (const filler of ['a', 'hwf']) {
        const tail = filler.repeat(Math.floor(letters / filler.length));
        for (const [input, expected] of [
          [`a\nhttps://u@h ${tail}`, `a\nhttps://[REDACTED]@h ${tail}`],
          [`${tail}\nhttps://u@h`, `${tail}\nhttps://[REDACTED]@h`],
        ] as const) {
          const output = scrubSecrets(input);
          // Bounded evidence: a regression must not serialize eight MiB into its report.
          expect(output.length, 'SECRETS_B2_URL_SCAN').toBe(expected.length);
          expect(output === expected, 'SECRETS_B2_URL_SCAN').toBe(true);
        }
      }
    },
    ADMITTED_SIZE_CASE_TIMEOUT_MS,
  );

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

  it(
    'bounds admitted-size embedded prefixes before a valid original boundary',
    () => {
      const fragment = `wordsk-proj-${'A'.repeat(52)}\n`;
      const publicPrefix = fragment.repeat(Math.floor((8 * 1024 * 1024 - 256) / fragment.length));
      const input = `${publicPrefix}sk-proj-${'B'.repeat(32)}\t${'C'.repeat(32)}; public=A`;
      const output = scrubSecrets(input);
      // Keep removal evidence bounded: a regression must not serialize eight MiB into its report.
      expect(output.length, 'SECRETS_B2_ORIGINAL_BOUNDARY').toBe('[REDACTED]'.length);
      expect(output, 'SECRETS_B2_ORIGINAL_BOUNDARY').toBe('[REDACTED]');
    },
    ADMITTED_SIZE_CASE_TIMEOUT_MS,
  );

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

const COLONLESS_SCHEMES = ['http', 'https', 'ws', 'wss', 'ftp', 'ftps'];
const CONNECTION_SCHEMES = [
  'postgres',
  'postgresql',
  'mysql',
  'mariadb',
  'redis',
  'rediss',
  'mongodb',
  'mongodb+srv',
  'amqp',
  'amqps',
  'ssh',
  'sftp',
  'ldap',
  'ldaps',
  'smtp',
  'smtps',
];

describe('PR95 header values that begin with a Bearer/Basic label', () => {
  const token = ['abcdef', 'ghijkl', '123456'].join('');
  const headerSchemeLabel = (value: unknown) => expect(value, 'SECRETS_B2_HEADER_SCHEME_LABEL');

  it.each(['api-key', 'x-api-key', 'x-goog-api-key', 'X-Api-Key'])(
    'masks the token after a scheme label in the %s header',
    (name) => {
      for (const label of ['Bearer', 'Basic', 'bearer', 'BASIC']) {
        for (const [input, expected] of [
          [`${name}:${label} ${token}`, `${name}:${label} [REDACTED]`],
          [
            `header ${name}: ${label} ${token} rejected`,
            `header ${name}: ${label} [REDACTED] rejected`,
          ],
          [`${name}:\t${label}\t${token}`, `${name}:\t${label}\t[REDACTED]`],
          // An opaque value after a label ends only at whitespace, so in compact JSON it fails closed
          // to the end of the run, exactly as a standalone `"authorization":"Bearer …"` does.
          [
            `{"${name}":"${label} ${token}","ordinary":"kept"}`,
            `{"${name}":"${label} [REDACTED]"}`,
          ],
        ] as const) {
          const output = scrubSecrets(input);
          headerSchemeLabel(output).toBe(expected);
          headerSchemeLabel(output.includes(token)).toBe(false);
        }
      }
    },
  );

  it('masks every LF/TAB split position inside a scheme label after a header', () => {
    for (const label of ['Bearer', 'Basic']) {
      for (const separator of ['\n', '\t', '\n\t']) {
        for (let position = 1; position < label.length; position += 1) {
          const split = `${label.slice(0, position)}${separator}${label.slice(position)}`;
          headerSchemeLabel(scrubSecrets(`api-key:${split} ${token}`)).toBe(
            `api-key:${split} [REDACTED]`,
          );
        }
      }
    }
  });

  it('masks the next token, failing closed, when a scheme label ends the line', () => {
    headerSchemeLabel(scrubSecrets('api-key: Bearer\nrequest failed')).toBe(
      'api-key: Bearer\n[REDACTED] failed',
    );
    // A bare label is no token: it stays visible rather than become the masked value.
    expect(scrubSecrets('api-key: Bearer')).toBe('api-key: Bearer');
  });

  it('keeps a token masked when the scheme label precedes the header name', () => {
    expect(scrubSecrets(`Bearer api-key: ${token}`)).toBe('Bearer [REDACTED] [REDACTED]');
  });
});

describe('PR95 raw ?/# userinfo: public only after a host-shaped prefix and an assignment', () => {
  const userinfoContact = (value: unknown) => expect(value, 'SECRETS_B2_USERINFO_CONTACT');

  it.each([
    ['https://us?er:TOKEN@h.example/', 'https://[REDACTED]@h.example/'],
    ['http://#TOKEN@h.example', 'http://[REDACTED]@h.example'],
    ['https://us?er=1:TOKEN@h.example/', 'https://[REDACTED]@h.example/'],
  ])('masks userinfo whose raw ?/# follows no host-shaped prefix: %s', (input, expected) => {
    userinfoContact(scrubSecrets(input)).toBe(expected);
  });

  it.each([
    ['https://my.user:1234?TOKEN@h.example/', 'https://[REDACTED]@h.example/'],
    ['https://host.example#sec@x.example', 'https://[REDACTED]@x.example'],
  ])('masks a host-shaped prefix that no assignment follows: %s', (input, expected) => {
    userinfoContact(scrubSecrets(input)).toBe(expected);
  });

  it.each(['?', '#'])('retains public %s contact text after a host-shaped prefix', (separator) => {
    for (const host of [
      'provider.invalid',
      'provider.invalid:8443',
      'provider.invalid.',
      '10.0.0.1',
      'localhost:3000',
      '[::1]',
      '[::1]:8443',
      '[::ffff:10.0.0.1]',
    ]) {
      const input = `connect https://${host}${separator}contact=alice@example.invalid failed`;
      expect(scrubSecrets(input)).toBe(input);
    }
  });

  it('masks a single-label host query, failing closed', () => {
    expect(scrubSecrets('https://intranet?contact=alice@example.invalid')).toBe(
      'https://[REDACTED]@example.invalid',
    );
  });

  it.each(['\n', '\t'])('keeps the predicate across an LF/TAB split (%j)', (separator) => {
    userinfoContact(scrubSecrets(`https://us?e${separator}r:TOKEN@h.example/`)).toBe('[REDACTED]');
    const contact = `https://provider.invalid?con${separator}tact=alice@example.invalid`;
    expect(scrubSecrets(contact)).toBe(contact);
  });
});

describe('PR95 connection-string URL schemes', () => {
  const connectionScheme = (value: unknown) => expect(value, 'SECRETS_B2_CONNECTION_SCHEME');

  it.each(CONNECTION_SCHEMES)('masks colon-bearing %s userinfo and keeps a bare user', (scheme) => {
    for (const spelling of [scheme, scheme.toUpperCase()]) {
      connectionScheme(scrubSecrets(`connect ${spelling}://user:opaque@db.example/x failed`)).toBe(
        `connect ${spelling}://[REDACTED]@db.example/x failed`,
      );
      connectionScheme(scrubSecrets(`${spelling}://:opaque@db.example`)).toBe(
        `${spelling}://[REDACTED]@db.example`,
      );
      connectionScheme(scrubSecrets(`x${spelling}://user:opaque@db.example/x`)).toBe(
        `x${spelling}://[REDACTED]@db.example/x`,
      );
      const bareUser = `${spelling}://admin@db.example/x`;
      expect(scrubSecrets(bareUser)).toBe(bareUser);
    }
  });

  it('masks a multi-host connection string and keeps a git+ssh user', () => {
    connectionScheme(scrubSecrets('mongodb://user:opaque@h1.example,h2.example/db')).toBe(
      'mongodb://[REDACTED]@h1.example,h2.example/db',
    );
    expect(scrubSecrets('git+ssh://git@github.com/org/repo')).toBe(
      'git+ssh://git@github.com/org/repo',
    );
  });

  it('keeps masking colonless userinfo for the original schemes', () => {
    for (const scheme of COLONLESS_SCHEMES) {
      expect(scrubSecrets(`${scheme}://opaque@provider.invalid/x`)).toBe(
        `${scheme}://[REDACTED]@provider.invalid/x`,
      );
    }
  });
});

describe('PR95 joined-view and glued-scheme witnesses', () => {
  // An inner pre-masked span splits the whitespace-stripped residual probe, so only the joined
  // scanner can see each split credential below.
  it.each([...COLONLESS_SCHEMES, ...CONNECTION_SCHEMES])(
    'masks a split %s credential around an inner masked span',
    (scheme) => {
      for (const separator of ['\n', '\t']) {
        expect(
          scrubSecrets(`${scheme}://u${separator}ser:pa[REDACTED]ss@h.example/x`),
          'SECRETS_B2_URL_JOINED',
        ).toBe('[REDACTED]');
      }
    },
  );

  it.each(['?', '#'])(
    'masks a split credential holding a raw %s and an inner masked span',
    (raw) => {
      for (const separator of ['\n', '\t']) {
        expect(
          scrubSecrets(`https://u${separator}ser:pa${raw}ss[REDACTED]x@h.example/v1`),
          'SECRETS_B2_URL_JOINED',
        ).toBe('[REDACTED]');
      }
    },
  );

  it.each(['\n', '\t'])(
    'masks a glued scheme whose split credential holds a raw @ (%j)',
    (separator) => {
      for (const scheme of ['https', 'postgres']) {
        expect(
          scrubSecrets(`x${scheme}://user:p@ss${separator}word@provider.invalid/v1`),
          'SECRETS_B2_URL_GLUED_SCHEME',
        ).toBe('[REDACTED]');
      }
    },
  );
});

describe('PR95 review round 1: label stacking, host bounds and masked userinfo', () => {
  const token = ['abcdef', 'ghijkl', '123456'].join('');
  const headerSchemeLabel = (value: unknown) => expect(value, 'SECRETS_B2_HEADER_SCHEME_LABEL');
  const userinfoContact = (value: unknown) => expect(value, 'SECRETS_B2_USERINFO_CONTACT');

  it('masks the token after stacked or quoted scheme labels in a header value', () => {
    for (const [input, expected] of [
      [`api-key: Bearer Bearer ${token}`, 'api-key: Bearer Bearer [REDACTED]'],
      [`x-api-key: Basic Bearer ${token}`, 'x-api-key: Basic Bearer [REDACTED]'],
      [`{"x-api-key":"Bearer Bearer ${token}"}`, '{"x-api-key":"Bearer Bearer [REDACTED]"}'],
      [`x-goog-api-key: Bearer\nBearer ${token}`, 'x-goog-api-key: Bearer\nBearer [REDACTED]'],
      [`api-key:Bearer B\tearer ${token}`, 'api-key:Bearer B\tearer [REDACTED]'],
      [`api-key: Bearer "${token}"`, 'api-key: Bearer "[REDACTED]"'],
      [`api-key: Basic '${token}'`, "api-key: Basic '[REDACTED]'"],
    ] as const) {
      const output = scrubSecrets(input);
      headerSchemeLabel(output).toBe(expected);
      headerSchemeLabel(output.includes(token)).toBe(false);
    }
  });

  it('masks the token after more than one whitespace character following a scheme label', () => {
    for (const [input, expected] of [
      [`api-key: Bearer  ${token} rejected`, 'api-key: Bearer  [REDACTED] rejected'],
      [`x-api-key:Basic \t${token}`, 'x-api-key:Basic \t[REDACTED]'],
      [`api-key:Bearer \r\n${token}`, 'api-key:Bearer \r\n[REDACTED]'],
    ] as const) {
      const output = scrubSecrets(input);
      headerSchemeLabel(output).toBe(expected);
      headerSchemeLabel(output.includes(token)).toBe(false);
    }
  });

  it('masks the token after stacked labels in a standalone scheme value', () => {
    // The last label masks the token: no label is taken as another label's token.
    for (const [input, expected] of [
      [
        `Authorization: Bearer Bearer ${token} rejected`,
        'Authorization: Bearer Bearer [REDACTED] rejected',
      ],
      [`Authorization: Basic Basic ${token}`, 'Authorization: Basic Basic [REDACTED]'],
      [`Authorization: Bearer Basic ${token}`, 'Authorization: Bearer Basic [REDACTED]'],
      [`Authorization: Bearer B\nearer ${token}`, 'Authorization: Bearer B\nearer [REDACTED]'],
    ] as const) {
      expect(scrubSecrets(input)).toBe(expected);
    }
    expect(scrubSecrets('Authorization: Bearer Bearerish rejected')).toBe(
      'Authorization: Bearer [REDACTED] rejected',
    );
  });

  it.each([
    'https://john.doe:s3cret?x=1@h.example/',
    'https://localhostuser:pw?a=b@h.example/',
    'https://user:pw.evil.com?x=1@h.example/',
    'https://h.example:123456?x=1@h.example/',
  ])('masks userinfo whose prefix only resembles a host: %s', (input) => {
    userinfoContact(scrubSecrets(input)).toBe('https://[REDACTED]@h.example/');
  });

  it('retains a public contact after a host with a five-digit port', () => {
    const input = 'connect https://h.example:65535?contact=alice@example.invalid failed';
    expect(scrubSecrets(input)).toBe(input);
  });

  it(
    'masks an admitted-size dotted userinfo prefix without exhausting the RegExp stack',
    () => {
      const labels = 'a.'.repeat(Math.floor((8 * 1024 * 1024 - 256 - 64) / 2));
      const input = `upstream said https://${labels}a?x=1@h.example failed`;
      let output = '';
      expect(() => {
        output = scrubSecrets(input);
      }, 'SECRETS_B2_USERINFO_HOST_LENGTH').not.toThrow();
      expect(
        output === 'upstream said https://[REDACTED]@h.example failed',
        'SECRETS_B2_USERINFO_HOST_LENGTH',
      ).toBe(true);
    },
    ADMITTED_SIZE_CASE_TIMEOUT_MS,
  );

  it('keeps colonless connection-string userinfo visible even with a raw ?/#', () => {
    for (const input of ['redis://#TOKEN@h.example', 'postgres://us?er@db.example/x']) {
      expect(scrubSecrets(input)).toBe(input);
    }
  });

  it('leaves already-masked userinfo as a fixed point and masks a literal around a mask', () => {
    for (const input of [
      'postgres://app:[REDACTED]@db.example/app',
      'redis://:[REDACTED]@cache.example:6379',
      'https://[REDACTED]:[REDACTED]@h.example/',
      'https://:[REDACTED]@h.example/',
    ]) {
      expect(scrubSecrets(input)).toBe(input);
    }
    expect(scrubSecrets('https://app:[REDACTED]@h.example/')).toBe('https://[REDACTED]@h.example/');
    expect(scrubSecrets('postgres://app:pa[REDACTED]ss@db.example')).toBe(
      'postgres://[REDACTED]@db.example',
    );
    // Only an exactly masked password is kept: text glued after the marker, or an empty password, is not.
    for (const [input, expected] of [
      ['postgres://app:[REDACTED]tail@db.example/x', 'postgres://[REDACTED]@db.example/x'],
      ['redis://:[REDACTED]SECRETTAIL@cache:6379', 'redis://[REDACTED]@cache:6379'],
      ['https://:[REDACTED]tail@h.example/', 'https://[REDACTED]@h.example/'],
      ['https://[REDACTED]:@h.example/', 'https://[REDACTED]@h.example/'],
    ] as const) {
      expect(scrubSecrets(input), 'SECRETS_B5_MASKED_USERINFO').toBe(expected);
    }
  });
});

describe('PR95 review round 2: quoted labels, unbounded stacking and fixed points', () => {
  const token = ['abcdef', 'ghijkl', '123456'].join('');
  const stacked = (value: unknown) => expect(value, 'SECRETS_B2_STACKED_LABEL');

  it('masks quoted and escaped tokens beside header scheme labels', () => {
    for (const [input, expected] of [
      [
        `request headers: {'x-api-key': '"Bearer ${token}"'}`,
        `request headers: {'x-api-key': '"Bearer [REDACTED]"'}`,
      ],
      [`{"x-api-key":"Bearer \\"${token}\\""}`, '{"x-api-key":"Bearer \\"[REDACTED]\\""}'],
      [
        `{"x-goog-api-key":"Basic Basic \\"${token}\\""}`,
        '{"x-goog-api-key":"Basic Basic \\"[REDACTED]\\""}',
      ],
      [
        `{"x-api-key":"\\\\\\"Bearer ${token}\\\\\\""}`,
        '{"x-api-key":"\\\\\\"Bearer [REDACTED]\\\\\\""}',
      ],
      [`{"x-api-key":"\\"${token}\\""}`, '{"x-api-key":"\\"[REDACTED]\\""}'],
      // A delimiter-led token after a label: the whitespace-stripped residual probe blanks it all.
      [`api-key: Bearer ,${token}`, '[REDACTED]'],
    ] as const) {
      const output = scrubSecrets(input);
      expect(output, 'SECRETS_B2_HEADER_SCHEME_LABEL').toBe(expected);
      expect(output.includes(token), 'SECRETS_B2_HEADER_SCHEME_LABEL').toBe(false);
    }
  });

  it('masks a header token after up to eight stacked labels and fails closed beyond them', () => {
    for (let count = 1; count <= 12; count += 1) {
      const labels = Array.from({ length: count }, (_, index) => (index % 2 ? 'Basic' : 'Bearer'));
      const output = scrubSecrets(`api-key: ${labels.join(' ')} ${token}`);
      stacked(output).toBe(count <= 8 ? `api-key: ${labels.join(' ')} [REDACTED]` : '[REDACTED]');
    }
  });

  it('masks the token after any number of stacked standalone labels', () => {
    for (let count = 1; count <= 12; count += 1) {
      for (const label of ['Bearer', 'Basic']) {
        const kept = `${label} `.repeat(count - 1);
        stacked(scrubSecrets(`Authorization: ${kept}${label} ${token}`)).toBe(
          `Authorization: ${kept}${label} [REDACTED]`,
        );
      }
    }
  });

  it(
    'keeps admitted-size label runs linear and fails closed',
    () => {
      const run = 'Bearer '.repeat(Math.floor((8 * 1024 * 1024 - 256 - 64) / 7));
      let header = '';
      let standalone = '';
      expect(() => {
        header = scrubSecrets(`api-key: ${run}${token}`);
        standalone = scrubSecrets(`Authorization: ${run}${token}`);
      }, 'SECRETS_B2_HEADER_LABEL_BOUND').not.toThrow();
      expect(header === '[REDACTED]', 'SECRETS_B2_HEADER_LABEL_BOUND').toBe(true);
      expect(
        standalone.endsWith('Bearer [REDACTED]') && !standalone.includes(token),
        'SECRETS_B2_HEADER_LABEL_BOUND',
      ).toBe(true);
    },
    ADMITTED_SIZE_CASE_TIMEOUT_MS,
  );

  it('keeps already-masked scheme tokens as fixed points', () => {
    for (const input of [
      'x-api-key: Bearer [REDACTED]',
      'x-api-key: Basic [REDACTED]',
      '{"x-api-key":"Bearer [REDACTED]"}',
      '{"x-api-key":"Basic [REDACTED]"}',
      "{'api-key': 'Bearer [REDACTED]'}",
      'Authorization: Bearer "[REDACTED]"',
      // Round 3: quoted and backslash-escaped masked tokens after a label or a header separator.
      'x-api-key: Bearer "[REDACTED]"',
      "x-api-key: Basic '[REDACTED]'",
      'api-key: \\"[REDACTED]\\"',
      'api-key: Bearer \\"[REDACTED]\\"',
      '{"x-api-key":"Bearer \\"[REDACTED]\\""}',
    ]) {
      expect(scrubSecrets(input), 'SECRETS_B2_MASKED_FIXED_POINT').toBe(input);
    }
  });

  it('bounds the host-shaped prefix at exactly 260 characters, case-insensitively', () => {
    const host = (length: number) => `${'a'.repeat(length - 2)}.b`;
    const retained = `connect https://${host(260)}?contact=alice@example.invalid failed`;
    expect(scrubSecrets(retained), 'SECRETS_B2_USERINFO_HOST_LENGTH').toBe(retained);
    expect(
      scrubSecrets(`https://${host(261)}?contact=alice@example.invalid`),
      'SECRETS_B2_USERINFO_HOST_LENGTH',
    ).toBe('https://[REDACTED]@example.invalid');
    const upper = 'connect https://PROVIDER.INVALID:8443?contact=alice@example.invalid failed';
    expect(scrubSecrets(upper)).toBe(upper);
  });
});

describe('PR95 review round 3: merged masking, glued labels and nested headers', () => {
  const token = ['abcdef', 'ghijkl', '123456'].join('');
  const cases = (marker: string, pairs: readonly (readonly [string, string])[]) => {
    for (const [input, expected] of pairs) {
      const output = scrubSecrets(input);
      expect(output, marker).toBe(expected);
      expect(output.includes(token) || output.includes('SECRET'), marker).toBe(false);
      expect(scrubSecrets(output), marker).toBe(output);
    }
  };

  it("masks a tail glued to a masked token, including the scrubber's own masks", () => {
    cases('SECRETS_B3_MASKED_TAIL', [
      [
        'Authorization: Bearer sk-abcdefghijklmnopqrstuv;TENANTSECRET99',
        'Authorization: Bearer [REDACTED]',
      ],
      [
        'Authorization: Basic AIzaSyABCDEFGHIJKLMNOPQRSTUVWX,TAILSECRET',
        'Authorization: Basic [REDACTED]',
      ],
      ["Authorization: Bearer [REDACTED]'TAILSECRET", 'Authorization: Bearer [REDACTED]'],
      ['Authorization: Bearer [REDACTED]TAILSECRET', 'Authorization: Bearer [REDACTED]'],
      ["Authorization: Basic [REDACTED]'TAILSECRET", 'Authorization: Basic [REDACTED]'],
      ['Authorization: Basic [REDACTED]TAILSECRET', 'Authorization: Basic [REDACTED]'],
      [
        '{"authorization":"Bearer sk-proj-abcdefghijklmnopqrst","api_key":"SECRETVALUE77"}',
        '{"authorization":"Bearer [REDACTED]"}',
      ],
      // A header token continues through a backslash, so a marker glued to it is no fixed point.
      ['api-key: [REDACTED]\\TAILSECRET', 'api-key: [REDACTED]'],
      ['api-key: sk-abcdefghijklmnopqrstuv\\TAILSECRET', 'api-key: [REDACTED]'],
    ]);
  });

  it('masks the token after a label glued behind punctuation or inside another token', () => {
    cases('SECRETS_B3_GLUED_LABEL', [
      [`api-key: \\"(Bearer ${token}`, 'api-key: \\"(Bearer [REDACTED]'],
      [`x-api-key:""(Bearer ${token}`, 'x-api-key:""(Bearer [REDACTED]'],
      [`api-key: \\"=Basic ${token}`, 'api-key: \\"=Basic [REDACTED]'],
      [`api-key: \\"[REDACTED]Bearer ${token}`, 'api-key: \\"[REDACTED] [REDACTED]'],
      [
        `Authorization: Bearer Bearer (Bearer ${token}`,
        'Authorization: Bearer Bearer (Bearer [REDACTED]',
      ],
      [`api-key: abc(Bearer ${token}`, 'api-key: [REDACTED] [REDACTED]'],
      [`Bearer x"Bearer ${token}`, 'Bearer [REDACTED]"Bearer [REDACTED]'],
      [`Authorization: Basic x(Basic ${token}`, 'Authorization: Basic [REDACTED]Basic [REDACTED]'],
      [`Authorization: Basic (Basic ${token}`, 'Authorization: Basic (Basic [REDACTED]'],
      [`Basic x"Basic ${token}`, 'Basic [REDACTED]"Basic [REDACTED]'],
      // A terminal control inside the run makes the raw and normalized views disagree: fail closed.
      [`Bearer \u001b[0m""Bearer \n${token}`, '[REDACTED]'],
    ]);
  });

  it('masks the token after a label closed by its own quote', () => {
    cases('SECRETS_B3_QUOTED_LABEL', [
      [`x-api-key: "Bearer" ${token}`, 'x-api-key: "Bearer" [REDACTED]'],
      [`api-key: 'Bearer' ${token}`, "api-key: 'Bearer' [REDACTED]"],
      [`{"x-api-key": "Bearer" "${token}"}`, '{"x-api-key": "Bearer" "[REDACTED]"}'],
      [`Authorization: Bearer "Bearer" ${token}`, 'Authorization: Bearer "Bearer" [REDACTED]'],
      [`Authorization: Bearer "Basic" ${token}`, 'Authorization: Bearer "Basic" [REDACTED]'],
      [
        `Authorization: Basic \\"Bearer\\" ${token}`,
        'Authorization: Basic \\"Bearer\\" [REDACTED]',
      ],
      [`Authorization: "Basic" ${token}`, 'Authorization: "Basic" [REDACTED]'],
      [`Authorization: Bearer 'Basic' ${token}`, "Authorization: Bearer 'Basic' [REDACTED]"],
    ]);
    // A word that only begins with a label is a token; a label at the end of the text has none.
    expect(scrubSecrets('Authorization: Basic Basicx'), 'SECRETS_B3_QUOTED_LABEL').toBe(
      'Authorization: Basic [REDACTED]',
    );
    expect(scrubSecrets('Authorization: Basic Basic'), 'SECRETS_B3_QUOTED_LABEL').toBe(
      'Authorization: Basic Basic',
    );
  });

  it('masks a header token after any run of quotes or escapes, also in JSON-encoded JSON', () => {
    cases('SECRETS_B3_HEADER_ESCAPES', [
      [`x-api-key: '""${token}`, `x-api-key: '""[REDACTED]`],
      [`{"x-api-key":"\\"\\"${token}"}`, '{"x-api-key":"\\"\\"[REDACTED]"}'],
      [`{"x-api-key":"\\\\\\"${token}\\\\\\""}`, '{"x-api-key":"\\\\\\"[REDACTED]\\\\\\""}'],
      [
        `{"body":"{\\"x-api-key\\":\\"${token}\\"}"}`,
        '{"body":"{\\"x-api-key\\":\\"[REDACTED]\\"}"}',
      ],
      [
        `{"body":"{\\"x-api-key\\":\\"Bearer ${token}\\"}"}`,
        '{"body":"{\\"x-api-key\\":\\"Bearer [REDACTED]\\"}"}',
      ],
    ]);
  });

  it('keeps every header value and label token apart from a nested header name', () => {
    cases('SECRETS_B3_NESTED_HEADER', [
      [`api-key:""api-key":${token}`, 'api-key:""api-key":[REDACTED]'],
      [`api-key: x(api-key: ${token}`, 'api-key: [REDACTED]api-key: [REDACTED]'],
      [`api-key:(api-key:[REDACTED]${token}`, 'api-key:[REDACTED]api-key:[REDACTED]'],
      [`Bearer api-key: ${token}`, 'Bearer [REDACTED] [REDACTED]'],
      [`Bearer api-key:,${token}`, 'Bearer [REDACTED]'],
    ]);
  });

  it('treats a whitespace-separated labels-only header value alike in every context', () => {
    for (const input of ['api-key: Bearer Bearer', 'x api-key: Bearer Bearer', 'api-key: Basic']) {
      expect(scrubSecrets(input), 'SECRETS_B3_LABEL_CONTEXT').toBe(input);
    }
    const masked = scrubSecrets('sk-proj-ABCDEFGHIJKLMNOPQRSTUV api-key: Bearer Bearer');
    expect(masked, 'SECRETS_B3_LABEL_CONTEXT').toBe('[REDACTED] api-key: Bearer Bearer');
    expect(scrubSecrets(masked), 'SECRETS_B3_LABEL_CONTEXT').toBe(masked);
  });

  it(
    'keeps admitted-size escape and concatenated-label runs linear and total',
    () => {
      const size = 8 * 1024 * 1024 - 256 - 64;
      const escapes = `api-key: ${'\\\\'.repeat(size)}`;
      const quoted = `api-key: ${'"Bearer'.repeat(Math.floor(size / 7))} ${token}`;
      const standalone = `Bearer ${'"Bearer'.repeat(Math.floor(size / 7))} ${token}`;
      const basic = `Basic ${'"Basic'.repeat(Math.floor(size / 6))} ${token}`;
      let results: string[] = [];
      expect(() => {
        results = [escapes, quoted, standalone, basic].map((input) => scrubSecrets(input));
      }, 'SECRETS_B3_ADMITTED_RUNS').not.toThrow();
      // A run of escapes holds no token, and a glued-label run past eight labels blanks it all.
      expect(results[0] === escapes, 'SECRETS_B3_ADMITTED_RUNS').toBe(true);
      expect(results.slice(1), 'SECRETS_B3_ADMITTED_RUNS').toEqual(Array(3).fill('[REDACTED]'));
    },
    ADMITTED_SIZE_CASE_TIMEOUT_MS,
  );
});

describe('PR95 review round 4: concatenated labels, ambiguous authorities and a fixed point', () => {
  const token = ['abcdef', 'ghijkl', '123456'].join('');
  const cases = (marker: string, pairs: readonly (readonly [string, string])[]) => {
    for (const [input, expected] of pairs) {
      const output = scrubSecrets(input);
      expect(output, marker).toBe(expected);
      expect(output.includes(token) || output.includes('SECRET'), marker).toBe(false);
      expect(scrubSecrets(output), marker).toBe(output);
    }
  };
  const kept = (marker: string, inputs: readonly string[]) => {
    for (const input of inputs) expect(scrubSecrets(input), marker).toBe(input);
  };

  it('masks the token after a concatenated label run in every context', () => {
    cases('SECRETS_B4_CONCAT_LABEL', [
      [
        `Authorization: Bearer BearerBearer ${token}`,
        'Authorization: Bearer BearerBearer [REDACTED]',
      ],
      [`Authorization: BearerBearer ${token}`, 'Authorization: BearerBearer [REDACTED]'],
      [`Authorization: BasicBearer ${token}`, 'Authorization: BasicBearer [REDACTED]'],
      [`Authorization: Bearer BasicBasic ${token}`, 'Authorization: Bearer BasicBasic [REDACTED]'],
      [`Basic bearerbasic ${token}`, 'Basic bearerbasic [REDACTED]'],
      [
        `Authorization: Bearer\tBearerBearer ${token}`,
        'Authorization: Bearer\tBearerBearer [REDACTED]',
      ],
      [`Authorization: B\nearerBasic ${token}`, 'Authorization: B\nearerBasic [REDACTED]'],
      [
        `Authorization: Bearer "BearerBearer" ${token}`,
        'Authorization: Bearer "BearerBearer" [REDACTED]',
      ],
      [
        `{"authorization":"Bearer BearerBearer ${token}"}`,
        '{"authorization":"Bearer BearerBearer [REDACTED]"}',
      ],
      [`api-key: BearerBearer ${token}`, 'api-key: BearerBearer [REDACTED]'],
      [`see api-key: BearerBearer ${token}`, 'see api-key: BearerBearer [REDACTED]'],
      [`curl -H x-api-key: BearerBearer ${token}`, 'curl -H x-api-key: BearerBearer [REDACTED]'],
      [`api-key: BearerBearer [REDACTED]${token}`, 'api-key: BearerBearer [REDACTED]'],
      [`x-api-key: }Bearer BearerBearer ${token}`, 'x-api-key: }Bearer BearerBearer [REDACTED]'],
      // A token ends before a concatenated run glued to it behind punctuation.
      [
        `Authorization: Bearer x(BasicBearer ${token}`,
        'Authorization: Bearer [REDACTED]BasicBearer [REDACTED]',
      ],
      [
        `Authorization: Basic x(BearerBasic ${token}`,
        'Authorization: Basic [REDACTED]BearerBasic [REDACTED]',
      ],
      // A terminal control inside the header name reveals the value only once normalized.
      [`-H X\u0007-API-KEY: BearerBearer ${token}`, '[REDACTED]'],
    ]);
    // A concatenated run is never a token: labels alone stay visible.
    kept('SECRETS_B4_CONCAT_LABEL', [
      'Authorization: Bearer BearerBearer',
      'Authorization: Basic BasicBasic',
      'Authorization: BearerBearer',
      'api-key: BearerBearer',
    ]);
  });

  it('fails closed on nine concatenated labels and keeps eight in place', () => {
    const bound = (value: unknown) => expect(value, 'SECRETS_B4_LABEL_RUN_BOUND');
    for (let count = 1; count <= 12; count += 1) {
      for (const label of ['Bearer', 'Basic']) {
        const run = label.repeat(count);
        bound(scrubSecrets(`Authorization: Bearer ${run} ${token}`)).toBe(
          count <= 8 ? `Authorization: Bearer ${run} [REDACTED]` : '[REDACTED]',
        );
        bound(scrubSecrets(`api-key: ${run} ${token}`)).toBe(
          count <= 8 ? `api-key: ${run} [REDACTED]` : '[REDACTED]',
        );
      }
    }
    // Quotes or escapes between the labels still join them, and a run with no token fails alike.
    for (const input of [
      `Authorization: ${'"Bearer'.repeat(9)} ${token}`,
      `Authorization: ${'\\"Basic'.repeat(9)} ${token}`,
      `Authorization: Bearer ${'Basic'.repeat(9)}`,
    ]) {
      bound(scrubSecrets(input)).toBe('[REDACTED]');
    }
    // Any case, and labels split by LF or TAB, count alike.
    for (const label of ['bearer', 'BASIC', 'B\nearer', 'B\tasic']) {
      for (const count of [8, 9]) {
        const run = label.repeat(count);
        bound(scrubSecrets(`Authorization: Bearer ${run} ${token}`)).toBe(
          count <= 8 ? `Authorization: Bearer ${run} [REDACTED]` : '[REDACTED]',
        );
        bound(scrubSecrets(`api-key: ${run} ${token}`)).toBe(
          count <= 8 ? `api-key: ${run} [REDACTED]` : '[REDACTED]',
        );
      }
    }
  });

  it(
    'keeps admitted-size label runs total, concatenated or separate',
    () => {
      const size = 8 * 1024 * 1024 - 256 - 64;
      const concatenated = `Authorization: Bearer ${'Bearer'.repeat(Math.floor(size / 6))} ${token}`;
      const separate = `Authorization: ${'Basic '.repeat(Math.floor(size / 6))}${token}`;
      let results: string[] = [];
      expect(() => {
        results = [concatenated, separate].map((input) => scrubSecrets(input));
      }, 'SECRETS_B4_LABEL_RUN_BOUND').not.toThrow();
      expect(results[0] === '[REDACTED]', 'SECRETS_B4_LABEL_RUN_BOUND').toBe(true);
      expect(
        results[1]?.endsWith('Basic [REDACTED]') === true && !results[1].includes(token),
        'SECRETS_B4_LABEL_RUN_BOUND',
      ).toBe(true);
    },
    ADMITTED_SIZE_CASE_TIMEOUT_MS,
  );

  it('ends a header token at a closing quote or brace', () => {
    cases('SECRETS_B4_HEADER_STOP', [
      [`{api-key:${token}}`, '{api-key:[REDACTED]}'],
      [`api-key: ${token}}`, 'api-key: [REDACTED]}'],
      [`{'api-key':'${token}'}`, "{'api-key':'[REDACTED]'}"],
      [`{'x-api-key': '${token}', 'b': 1}`, "{'x-api-key': '[REDACTED]', 'b': 1}"],
    ]);
  });

  it('masks a quoted standalone token after either label', () => {
    cases('SECRETS_B4_LABEL_LEAD', [
      [`Authorization: Bearer "${token}"`, 'Authorization: Bearer "[REDACTED]"'],
      [`Authorization: Bearer '${token}'`, "Authorization: Bearer '[REDACTED]'"],
      [`{"authorization":"Bearer \\"${token}\\""}`, '{"authorization":"Bearer \\"[REDACTED]\\""}'],
      [`Authorization: Basic "${token}"`, 'Authorization: Basic "[REDACTED]"'],
      [`Authorization: Basic '${token}'`, "Authorization: Basic '[REDACTED]'"],
      [`{"authorization":"Basic \\"${token}\\""}`, '{"authorization":"Basic \\"[REDACTED]\\""}'],
    ]);
  });

  it('masks the whole of a range that contains a later one', () => {
    // A later pass re-masks a truncated range wherever its rule matches again; behind an ambiguous
    // authority no `@` is left, so only the merged extent keeps a key's neighbour masked.
    cases('SECRETS_B4_MERGE_EXTENT', [
      ['https://svc?a=b@.sk-abcdefghijklmnopqrstuv.TAILSECRET', 'https://[REDACTED]'],
      [
        'https://svc?a=b@.AIzaSyA1234567890abcdefghijklmn.TAILSECRET failed',
        'https://[REDACTED] failed',
      ],
      ['{"u":"https://svc#x@.sk-abcdefghijklmnopqrstuv.TAILSECRET"}', '{"u":"https://[REDACTED]"}'],
      [
        `https://user:sk-abcdefghijklmnopqrstuv:more${token}@h.example/`,
        'https://[REDACTED]@h.example/',
      ],
      [`postgres://u:AIzaSyA1234567890abcdefghijklmn:${token}@db/x`, 'postgres://[REDACTED]@db/x'],
    ]);
  });

  it('keeps the documented edges of the label and header rules', () => {
    cases('SECRETS_B4_RULE_EDGES', [[`api-key : ${token} retry`, 'api-key : [REDACTED] retry']]);
    // A label glued to a preceding word character is no label.
    kept('SECRETS_B4_RULE_EDGES', [`xBearer ${token}`, `xBasic ${token}`]);
  });

  it('masks a literal query value in the same pass as every other rule', () => {
    cases('SECRETS_B4_QUERY_MERGE', [
      [
        '{\\"x-api-key\\":\\"https://h.example/cb?token=abc;SECRETTAIL\\"}',
        '{\\"x-api-key\\":\\"[REDACTED]',
      ],
      ['x-api-key: https://h.example/cb?token=abc;SECRETTAIL', 'x-api-key: [REDACTED]'],
    ]);
  });

  it('masks a secret query value that holds a raw @ after a single-label host', () => {
    for (const [input, expected, tail] of [
      [
        'request to https://svc?password=P@ssw0rd123 failed',
        'request to https://[REDACTED] failed',
        'ssw0rd123',
      ],
      ['https://gateway?api_key=Ab3@Zx9QrT7', 'https://[REDACTED]', 'Zx9QrT7'],
      ['postgres://db?options=a:b&password=P@ssw0rd99', 'postgres://[REDACTED]', 'ssw0rd99'],
      ['https://svc?token=abc@def&x=1', 'https://[REDACTED]', 'def'],
    ] as const) {
      const output = scrubSecrets(input);
      expect(output, 'SECRETS_B4_AMBIGUOUS_QUERY').toBe(expected);
      expect(output.includes(tail), 'SECRETS_B4_AMBIGUOUS_QUERY').toBe(false);
    }
  });

  it('masks an ambiguous authority through its end unless a host follows its last @', () => {
    cases('SECRETS_B4_AUTHORITY_REST', [
      ['https://svc?opaque=P@SECRETTAIL1 failed', 'https://[REDACTED] failed'],
      ['https://svc#frag@SECRETTAIL1 x', 'https://[REDACTED] x'],
      ['{"url":"https://svc?code=ab@SECRETTAIL1","n":1}', '{"url":"https://[REDACTED]","n":1}'],
      ['https://us?er:TOKEN@h/', 'https://[REDACTED]/'],
    ]);
    // A raw ?/# in a password does not hide the host it connects to.
    for (const [input, expected] of [
      ['https://alice:pa?ss@provider.invalid/v1', 'https://[REDACTED]@provider.invalid/v1'],
      ['https://u:p?w@[::1]:8443/x', 'https://[REDACTED]@[::1]:8443/x'],
      ['https://u:p?w@localhost:3000/x', 'https://[REDACTED]@localhost:3000/x'],
    ] as const) {
      expect(scrubSecrets(input), 'SECRETS_B4_AUTHORITY_REST').toBe(expected);
    }
  });

  it(
    'bounds the host test after an ambiguous authority at admitted size',
    () => {
      const labels = 'a.'.repeat(Math.floor((8 * 1024 * 1024 - 256 - 64) / 2));
      const input = `upstream said https://svc?x=1@${labels}a failed`;
      let output = '';
      expect(() => {
        output = scrubSecrets(input);
      }, 'SECRETS_B4_REST_LENGTH').not.toThrow();
      expect(output === 'upstream said https://[REDACTED] failed', 'SECRETS_B4_REST_LENGTH').toBe(
        true,
      );
    },
    ADMITTED_SIZE_CASE_TIMEOUT_MS,
  );

  it('reads a word glued before sftp as part of an sftp scheme', () => {
    // Every whitespace-joined probe glues prose to a scheme the same way, so `to sftp://` must stay.
    kept('SECRETS_B4_GLUED_SFTP', [
      'statusftp://deploy@h.example',
      'upload to sftp://deploy@files.example failed',
    ]);
    expect(scrubSecrets('statusftp://deploy:pw@h.example'), 'SECRETS_B4_GLUED_SFTP').toBe(
      'statusftp://[REDACTED]@h.example',
    );
  });

  it('reaches a fixed point', () => {
    for (const [input, expected] of [
      ['api-key: https://"@host.example', 'api-key: [REDACTED]'],
      ['{"x-api-key":"https://\\"@h.example"}', '{"x-api-key":"[REDACTED]"}'],
      ['x-api-key: Bearer abc"=Bearer xyz', 'x-api-key: Bearer [REDACTED] [REDACTED]'],
      ['x-api-key: Bearer abc"(Bearer xyz12345', 'x-api-key: Bearer [REDACTED] [REDACTED]'],
      ['api-key:Bearer S":BEAReR', 'api-key:Bearer [REDACTED]'],
      ['x:sk-proj-abcdefghijklmnopqrst  api-key\\":\\" :', '[REDACTED]'],
      ['&key=H X-GOOG-API-KEY:basic |BasiC', '[REDACTED]'],
      ['http://i.b#@=\n@', '[REDACTED]'],
      ['[REDACTED]', '[REDACTED]'],
    ] as const) {
      const output = scrubSecrets(input);
      expect(output, 'SECRETS_B4_FIXED_POINT').toBe(expected);
      expect(scrubSecrets(output), 'SECRETS_B4_FIXED_POINT').toBe(output);
    }
  });

  it(
    'keeps quote and escape runs after a label or header token linear at admitted size',
    () => {
      // Pinned by this case deadline only: a quadratic scan here still finishes, just too late.
      const size = 8 * 1024 * 1024 - 256 - 64;
      const quotes = '"'.repeat(size);
      const inputs = [
        `Bearer ${quotes}`,
        `Basic ${quotes}`,
        `api-key: ${token}${'\\'.repeat(size)}x`,
      ];
      let results: string[] = [];
      expect(() => {
        results = inputs.map((input) => scrubSecrets(input));
      }, 'SECRETS_B4_ADMITTED_RUNS').not.toThrow();
      expect(results[0] === inputs[0], 'SECRETS_B4_ADMITTED_RUNS').toBe(true);
      expect(results[1] === inputs[1], 'SECRETS_B4_ADMITTED_RUNS').toBe(true);
      expect(results[2] === 'api-key: [REDACTED]', 'SECRETS_B4_ADMITTED_RUNS').toBe(true);
    },
    ADMITTED_SIZE_CASE_TIMEOUT_MS,
  );
});

describe('PR95 review round 5: label pieces, a split ftp credential and the repeated residual', () => {
  const token = ['abcdef', 'ghijkl', '123456'].join('');
  const cases = (marker: string, pairs: readonly (readonly [string, string])[]) => {
    for (const [input, expected] of pairs) {
      const output = scrubSecrets(input);
      expect(output, marker).toBe(expected);
      expect(output.includes(token) || output.includes('SECRET'), marker).toBe(false);
      expect(scrubSecrets(output), marker).toBe(output);
    }
  };

  it('ends a standalone token before a trailing delimiter, a quote-closed label or a concatenated run', () => {
    cases('SECRETS_B5_LABEL_PIECES', [
      [`Authorization: Bearer ${token}; retry`, 'Authorization: Bearer [REDACTED]; retry'],
      [`Authorization: Bearer ${token}, retry`, 'Authorization: Bearer [REDACTED], retry'],
      [`Authorization: Basic ${token}; retry`, 'Authorization: Basic [REDACTED]; retry'],
      [`Authorization: Basic ${token}, retry`, 'Authorization: Basic [REDACTED], retry'],
      [
        `Authorization: Bearer x("Bearer" ${token}`,
        'Authorization: Bearer [REDACTED]"Bearer" [REDACTED]',
      ],
      [
        `Authorization: Bearer x(${'Bearer'.repeat(8)} ${token}`,
        `Authorization: Bearer [REDACTED]${'Bearer'.repeat(8)} [REDACTED]`,
      ],
    ]);
  });

  it('blanks an LF/TAB-split ftp credential after a line that ends in s', () => {
    cases('SECRETS_B5_SPLIT_SFTP', [
      ['Uploading files\nftp://deploySECRET\n1234@host.example/x', '[REDACTED]'],
      ['Uploading files\n\tftp://deploySECRET\n1234@host.example/x', '[REDACTED]'],
      ['files\nf\ntp://TOKENSECRET@host', '[REDACTED]'],
    ]);
    // A real sftp scheme keeps its colonless user, also when the user is split.
    for (const input of [
      'files\nsftp://deploy\nuser@host',
      'connect to sftp://deploy@files.example',
    ]) {
      expect(scrubSecrets(input), 'SECRETS_B5_SPLIT_SFTP').toBe(input);
    }
  });

  it('blanks a diagnostic whose key prefix reaches its length across spaces after a mask', () => {
    // The repeat reads another rule's mask as a segment start for the whitespace-stripped residual.
    for (const input of [
      'Authorization: Bearer xyz sk-ant api key invalid for this org',
      'x-api-key: abc AIza prefix keys are restricted here',
    ]) {
      expect(scrubSecrets(input), 'SECRETS_B5_RESIDUAL_AFTER_MASK').toBe('[REDACTED]');
    }
  });
});

describe('PR95 review round 6: the label bound behind a terminal sequence, fragments and failing closed', () => {
  it('fails closed on nine labels behind a terminal sequence', () => {
    const bound = (value: unknown) => expect(value, 'SECRETS_B4_LABEL_RUN_BOUND');
    // Normalization reads `ESC [` plus the run's first letter as one terminal sequence.
    for (const label of ['Bearer', 'Basic']) {
      for (const lead of ['Authorization: Bearer ', 'x-api-key: ', '']) {
        bound(scrubSecrets(`${lead}\u001b[${label.repeat(9)} opaqueTOKEN123`)).toBe('[REDACTED]');
      }
    }
  });

  it('fails closed on nine labels that only the normalized view joins', () => {
    const bound = (value: unknown) => expect(value, 'SECRETS_B4_LABEL_RUN_BOUND');
    // A terminal sequence normalization removes splits the raw run into four and five labels.
    for (const label of ['Bearer', 'Basic']) {
      for (const lead of ['Authorization: Bearer ', 'x-api-key: ', '']) {
        bound(
          scrubSecrets(`${lead}${label.repeat(4)}\u001b[0m${label.repeat(5)} opaqueTOKEN123`),
        ).toBe('[REDACTED]');
      }
    }
  });

  it('masks a literal secret query name in a fragment', () => {
    const fragment = (value: unknown) => expect(value, 'SECRETS_B6_QUERY_FRAGMENT');
    fragment(scrubSecrets('https://[::1]#id_token=Zk81Pq0aLm3nB7xY@127.0.0.1/cb')).toBe(
      'https://[::1]#id_token=[REDACTED]',
    );
    fragment(
      scrubSecrets(
        'redirect https://app.example/cb#access_token=Zk81Pq0aLm3nB7xYt2Rw&token_type=bearer',
      ),
    ).toBe('redirect https://app.example/cb#access_token=[REDACTED]&token_type=bearer');
    // A name that only begins like one, and an empty value, stay.
    for (const kept of ['see https://docs.example/page#tokenizer=fast', 'page#token= next']) {
      fragment(scrubSecrets(kept)).toBe(kept);
    }
  });

  it('fails closed with its own mask when the scrub does not settle', () => {
    vi.mocked(toFixedPoint).mockImplementationOnce((_pass, _text, failed) => failed);
    expect(scrubSecrets('public text'), 'SECRETS_B6_FAIL_CLOSED').toBe('[REDACTED]');
  });
});
