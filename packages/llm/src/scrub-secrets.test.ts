import { describe, expect, it } from 'vitest';

import { scrubSecrets as rootScrubSecrets } from './index.js';
import { makeLlmError, scrubSecrets as errorScrubSecrets } from './llm-error.js';
import { scrubSecrets } from './scrub-secrets.js';

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
          [`${name}:${label} ${token}`, `${name}:[REDACTED]`],
          [`header ${name}: ${label} ${token} rejected`, `header ${name}: [REDACTED] rejected`],
          [`${name}:\t${label}\t${token}`, `${name}:\t[REDACTED]`],
          [
            `{"${name}":"${label} ${token}","ordinary":"kept"}`,
            `{"${name}":"[REDACTED]","ordinary":"kept"}`,
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
          const input = `api-key:${label.slice(0, position)}${separator}${label.slice(position)} ${token}`;
          headerSchemeLabel(scrubSecrets(input)).toBe('api-key:[REDACTED]');
        }
      }
    }
  });

  it('masks the next token, failing closed, when a scheme label ends the line', () => {
    headerSchemeLabel(scrubSecrets('api-key: Bearer\nrequest failed')).toBe(
      'api-key: [REDACTED] failed',
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
      [`api-key: Bearer Bearer ${token}`, 'api-key: [REDACTED]'],
      [`x-api-key: Basic Bearer ${token}`, 'x-api-key: [REDACTED]'],
      [`{"x-api-key":"Bearer Bearer ${token}"}`, '{"x-api-key":"[REDACTED]"}'],
      [`x-goog-api-key: Bearer\nBearer ${token}`, 'x-goog-api-key: [REDACTED]'],
      [`api-key:Bearer B\tearer ${token}`, 'api-key:[REDACTED]'],
      [`api-key: Bearer "${token}"`, 'api-key: [REDACTED]"'],
      [`api-key: Basic '${token}'`, "api-key: [REDACTED]'"],
    ] as const) {
      const output = scrubSecrets(input);
      headerSchemeLabel(output).toBe(expected);
      headerSchemeLabel(output.includes(token)).toBe(false);
    }
  });

  it('masks the token after more than one whitespace character following a scheme label', () => {
    for (const [input, expected] of [
      [`api-key: Bearer  ${token} rejected`, 'api-key: [REDACTED] rejected'],
      [`x-api-key:Basic \t${token}`, 'x-api-key:[REDACTED]'],
      [`api-key:Bearer \r\n${token}`, 'api-key:[REDACTED]'],
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
      [`Authorization: Bearer B\nearer ${token}`, 'Authorization: Bearer Bearer [REDACTED]'],
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
      const input = `upstream said https://${labels}a?x=1@h failed`;
      let output = '';
      expect(() => {
        output = scrubSecrets(input);
      }, 'SECRETS_B2_USERINFO_HOST_LENGTH').not.toThrow();
      expect(
        output === 'upstream said https://[REDACTED]@h failed',
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
  });
});

describe('PR95 review round 2: quoted labels, unbounded stacking and fixed points', () => {
  const token = ['abcdef', 'ghijkl', '123456'].join('');
  const stacked = (value: unknown) => expect(value, 'SECRETS_B2_STACKED_LABEL');

  it('masks quoted and escaped tokens beside header scheme labels', () => {
    for (const [input, expected] of [
      [
        `request headers: {'x-api-key': '"Bearer ${token}"'}`,
        `request headers: {'x-api-key': '[REDACTED]"'}`,
      ],
      [`{"x-api-key":"Bearer \\"${token}\\""}`, '{"x-api-key":"[REDACTED]""}'],
      [`{"x-goog-api-key":"Basic Basic \\"${token}\\""}`, '{"x-goog-api-key":"[REDACTED]""}'],
      [`{"x-api-key":"\\\\\\"Bearer ${token}\\\\\\""}`, '{"x-api-key":"[REDACTED]""}'],
      [`{"x-api-key":"\\"${token}\\""}`, '{"x-api-key":"[REDACTED]""}'],
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
      stacked(output).toBe(count <= 8 ? 'api-key: [REDACTED]' : '[REDACTED]');
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
