import { describe, expect, it } from 'vitest';
import { makeLlmError } from '@relavium/llm';

import {
  sanitizeUntrusted,
  sanitizeUntrustedInline,
  stringifyJsonLine,
  stripTerminalControls,
} from './sanitize.js';

const overlapShapes = ['normalized key', 'URL userinfo', 'Bearer', 'Basic'] as const;
type OverlapShape = (typeof overlapShapes)[number];

/** Synthetic independent values for actual raw and already-normalized diagnostic paths. */
function overlapValues(shape: OverlapShape): { readonly value: string; readonly secret: string }[] {
  const separators = ['\n', '\t', ' \r\n\t '];
  if (shape === 'normalized key') {
    const controls = [
      '\u0001',
      '\u007f',
      '\u0085',
      '\u202e',
      '\u2066',
      '\x1b[31m',
      '\x1b[1 q',
      '\x1b]52;c;YWJj\x07',
      '\x1b]0;fixture\x1b\\',
      '\x1bPfixture\x07',
      '\x1bPfixture\x1b\\',
      '\x1b^fixture\x1b\\',
      '\x1b_fixture\x1b\\',
      '\x1bXfixture\x1b\\',
      '\x1bM',
      '\x1b]',
    ];
    const secret = 'AbCdEf0123456789xyzUVWXYZ';
    return controls.flatMap((control) =>
      [['sk-', control, 'ant-', 'api03-'].join(''), ['AI', control, 'za', 'SyA'].join('')].flatMap(
        (prefix) =>
          separators.map((separator) => ({ value: `${prefix}${separator}${secret}`, secret })),
      ),
    );
  }
  const secret =
    shape === 'URL userinfo'
      ? 'opaque-userinfo-P8'
      : shape === 'Bearer'
        ? 'opaque-header-Z29'
        : 'dXNlcjpvcGFxdWU=';
  return separators.map((separator) => ({
    value:
      shape === 'URL userinfo'
        ? `https://u${separator}ser:${secret}@provider.invalid/x`
        : `${shape}${separator}${secret}`,
    secret,
  }));
}

/**
 * The redacting sanitizer for text this process did NOT author (#W15-8) — a rejection message, a provider
 * response body, an MCP error, a tool result, a stack trace. Terminal-control sanitization alone printed
 * credentials verbatim on every one of those paths; the existing tests planted ANSI, never a secret.
 */
describe('sanitizeUntrusted — the failure paths carry arbitrary text (#W15-8)', () => {
  // Built at runtime so no contiguous key-shaped literal sits in source (avoids secret-scanner noise);
  // behaviour is identical to an inline literal.
  const join = (...parts: string[]): string => parts.join('');

  it('REDACTS credential shapes the terminal sanitizer never touched', () => {
    for (const text of [
      join('sk-', 'ant-', 'api03-AbCdEf0123456789xyz'),
      join('AI', 'za', 'SyA1234567890abcdefghijklmnopqrstuv'),
      'Authorization: Bearer abc.def.ghi12345',
      'Authorization: Basic dXNlcjpwYXNz',
      'https://user:p4ssw0rd@host/x',
      'GET https://api.example.com/v1?api_key=SECRET12345abc',
    ]) {
      expect(sanitizeUntrusted(text)).toContain('[REDACTED]');
    }
    expect(sanitizeUntrusted(join('sk-', 'ant-', 'api03-AbCdEf0123456789xyz'))).not.toContain(
      'AbCdEf0123456789',
    );
    expect(sanitizeUntrusted('https://user:p4ssw0rd@host/x')).not.toContain('p4ssw0rd');
  });

  it('redacts a credential even when a control byte splits it', () => {
    const split = join('sk-', 'ant-', 'api03-AbCdEf', '\u001b', '[0m', '0123456789xyz');
    expect(sanitizeUntrusted(split)).not.toContain('AbCdEf0123456789xyz');
  });

  it('redacts a credential split by a byte the STRIP removes — the case that pins the order', () => {
    // The leak the old redact-first order actually had, and that this file previously said it could not
    // construct. `U+0001` defeats the key pattern while it is present; the strip then REJOINS the halves, so
    // redacting first printed the whole key. Normalizing first sees the contiguous key and replaces it.
    const key = join('sk-', 'ant-', 'api03-', 'AbCdEf0123456789xyz');
    const split = `${key.slice(0, 12)}${String.fromCharCode(1)}${key.slice(12)}`;
    expect(sanitizeUntrusted(split)).not.toContain('0123456789xyz');
    expect(sanitizeUntrusted(split)).toContain('[REDACTED]');
  });

  it('REDACTS a credential split across a newline, which the in-place pass cannot see', () => {
    // Unlike the control bytes the strip REMOVES, a newline is display-significant and is COLLAPSED to a
    // space — so the halves never become contiguous and the in-place pass sees nothing. The public
    // `sk-ant-…` prefix was never the issue; the secret SUFFIX was, and it used to be printed.
    const key = join('sk-', 'ant-', 'api03-', 'AbCdEf0123456789xyz');
    const out = sanitizeUntrustedInline(`${key.slice(0, 12)}\n${key.slice(12)}`);
    expect(out).not.toContain('0123456789xyz'); // the part that matters
    expect(out).toContain('[REDACTED]');
  });

  it('leaves ordinary multi-word diagnostics alone — the coarse fallback must not fire on prose', () => {
    // The fallback redacts the WHOLE text when it fires, so a false positive costs a diagnostic. These are
    // the shapes that must NOT trip it.
    for (const msg of [
      'ENOENT: no such file or directory',
      'database is locked\nretrying in 250ms',
      'rate limited by the provider, retry after 30s',
      'node deploy-prod failed\n  at step 2 of 5',
    ]) {
      expect(sanitizeUntrusted(msg)).toBe(stripTerminalControls(msg));
    }
  });

  it('still removes terminal control bytes, so it is a superset of the old behaviour', () => {
    expect(sanitizeUntrusted(`a${'\u001b'}[31mb`)).toBe('ab');
    expect(sanitizeUntrustedInline('a\nb')).toBe('a b');
  });

  it('leaves ordinary diagnostic text alone', () => {
    for (const msg of ['ENOENT: no such file', 'database is locked', 'rate limited, retry later']) {
      expect(sanitizeUntrusted(msg)).toBe(msg);
    }
  });

  it.each([
    'client_secret',
    'refresh_token',
    'id_token',
    'auth_token',
    'session_token',
    'api_secret',
    'access_key',
    'secret_key',
  ])('uses the finite query-name backstop for %s in both diagnostic sanitizers', (name) => {
    const text = `request https://provider.invalid/?${name}=opaque-value-Q7&ordinary=kept`;
    const expected = `request https://provider.invalid/?${name}=[REDACTED]&ordinary=kept`;
    expect(sanitizeUntrusted(text)).toBe(expected);
    expect(sanitizeUntrustedInline(text)).toBe(expected);
  });

  it('normalizes a removed control inside a query name before secret classification', () => {
    const text = `request ?client_se${String.fromCharCode(1)}cret=opaque-value-Q7`;
    expect(sanitizeUntrusted(text)).toBe('request ?client_secret=[REDACTED]');
    expect(sanitizeUntrustedInline(text)).toBe('request ?client_secret=[REDACTED]');
    expect(sanitizeUntrusted('?client_secret_hint=ordinary')).toBe('?client_secret_hint=ordinary');
  });

  const queryNames = [
    'client_secret',
    'refresh_token',
    'id_token',
    'auth_token',
    'session_token',
    'api_secret',
    'access_key',
    'secret_key',
  ];
  it.each(
    queryNames.flatMap((name) => [
      { name, label: 'multiline', sanitize: sanitizeUntrusted },
      { name, label: 'inline', sanitize: sanitizeUntrustedInline },
    ]),
  )(
    'SECRETS_CAUSAL_RESIDUAL_SCRUB protects $name beside a split credential: $label',
    ({ name, sanitize }) => {
      for (const separator of ['\n', '\t', ' \n\t ']) {
        const query = `?${name}=opaque-query-value&ordinary=kept`;
        for (const split of [
          `?api_${separator}key=opaque-residual-query-P8`,
          `https://u${separator}ser:opaque-userinfo-P8@provider.invalid/x`,
          join('sk-', 'ant-', 'api03-', separator, 'AbCdEf0123456789xyz'),
        ]) {
          for (const text of [`${query}; credential: ${split}`, `credential: ${split}; ${query}`]) {
            expect(sanitize(text), 'SECRETS_CAUSAL_RESIDUAL_SCRUB').toBe('[REDACTED]');
          }
        }
      }
    },
  );

  it.each(
    queryNames.flatMap((name) => [
      { name, label: 'multiline', sanitize: sanitizeUntrusted },
      { name, label: 'inline', sanitize: sanitizeUntrustedInline },
    ]),
  )('SECRETS_CAUSAL_PREFIX_ORDER protects $name query values: $label', ({ name, sanitize }) => {
    const suffix = 'AbCdEf0123456789xyzUVWXYZ';
    for (const prefix of [join('sk-', 'ant-', 'api03-'), join('AI', 'za', 'SyA')]) {
      for (const separator of ['\n', '\t', ' \r\n\t ']) {
        const text = `?${name}=${prefix}${separator}${suffix}`;
        const error = makeLlmError({ provider: 'openai', kind: 'auth', message: text, code: text });
        for (const projection of [text, error.message]) {
          expect(sanitize(projection), 'SECRETS_CAUSAL_PREFIX_ORDER').toBe('[REDACTED]');
        }
        expect(error.code, 'SECRETS_CAUSAL_PREFIX_ORDER').toBe('[REDACTED]');
      }
    }
  });

  it.each(
    queryNames.flatMap((name) =>
      overlapShapes.flatMap((shape) => [
        { name, shape, label: 'multiline', sanitize: sanitizeUntrusted },
        { name, shape, label: 'inline', sanitize: sanitizeUntrustedInline },
      ]),
    ),
  )(
    'SECRETS_CAUSAL_OVERLAP_ORDER protects $name $shape query values: $label',
    ({ name, shape, sanitize }) => {
      for (const { value, secret } of overlapValues(shape)) {
        const text = `?${name}=${value}`;
        const error = makeLlmError({ provider: 'openai', kind: 'auth', message: text, code: text });
        for (const projection of [text, error.message, error.code ?? '']) {
          const output = sanitize(projection);
          expect(output, 'SECRETS_CAUSAL_OVERLAP_ORDER').not.toContain(secret);
          expect(output).toContain('[REDACTED]');
        }
      }
    },
  );

  it.each(queryNames)('preserves ordinary prose after an in-place %s redaction', (name) => {
    const text = `request ?${name}=opaque-query-value\nretrying after 30s`;
    expect(sanitizeUntrusted(text)).toBe(`request ?${name}=[REDACTED]\nretrying after 30s`);
    expect(sanitizeUntrustedInline(text)).toBe(`request ?${name}=[REDACTED] retrying after 30s`);
  });

  it('checks residual split keys beside other credential shapes without discarding benign prose', () => {
    const split = join('sk-', 'ant-', 'api03-', '\n', 'AbCdEf0123456789xyz');
    for (const [credential, redacted] of [
      ['Authorization: Bearer opaque-value', 'Authorization: Bearer [REDACTED]'],
      ['Authorization: Basic dXNlcjpwYXNz', 'Authorization: Basic [REDACTED]'],
      ['https://user:opaque-value@host/x', 'https://[REDACTED]@host/x'],
      [join('AI', 'za', 'SyA1234567890abcdefghijklmnopqrstuv'), '[REDACTED]'],
    ]) {
      for (const sanitize of [sanitizeUntrusted, sanitizeUntrustedInline]) {
        expect(sanitize(`${credential}; key: ${split}`)).toBe('[REDACTED]');
        expect(sanitize(`${credential} retry after 30s`)).toBe(`${redacted} retry after 30s`);
      }
    }
  });

  it('masks URL userinfo whose scheme is glued to a preceding word character (PR #95 MEDIUM-1)', () => {
    for (const sanitize of [sanitizeUntrusted, sanitizeUntrustedInline]) {
      expect(sanitize('xhttps://user:opaque-value@host/x')).toBe('xhttps://[REDACTED]@host/x');
      expect(sanitize('1wss://opaque-user@host/x retry after 30s')).toBe(
        '1wss://[REDACTED]@host/x retry after 30s',
      );
      for (const separator of ['\n', '\t']) {
        expect(sanitize(`xhttps://us${separator}er:opaque-value@host/x`)).toBe('[REDACTED]');
      }
      // Glued scheme + split credential + a raw `@` in the credential: no partial mask may remain.
      expect(sanitize('xhttps://user:p@ss\tword@host/x')).toBe('[REDACTED]');
      expect(sanitize('xhttps://u@e.com:pw\nxyz@host/x')).toBe('[REDACTED]');
    }
  });
});

describe('PR95 B2 complete diagnostic evidence before display normalization', () => {
  const variants = [
    { label: 'multiline', sanitize: sanitizeUntrusted },
    { label: 'inline', sanitize: sanitizeUntrustedInline },
  ];

  it.each(
    variants.flatMap((variant) => ['\n', '\t'].map((separator) => ({ ...variant, separator }))),
  )(
    'SECRETS_B2_DISPLAY_ORDER protects a complete first fragment in $label with $separator',
    ({ sanitize, separator }) => {
      for (const prefix of ['sk-proj-', 'AIza']) {
        const input = `provider rejected ${prefix}${'A'.repeat(32)}${separator}${'B'.repeat(32)}; public=Q`;
        expect(sanitize(input), 'SECRETS_B2_DISPLAY_ORDER').toBe('[REDACTED]');
        expect(sanitize('provider rejected public-label; public=Q')).toBe(
          'provider rejected public-label; public=Q',
        );
      }
    },
  );

  it.each(
    variants.flatMap((variant) =>
      ['\u0001', '\u007f', '\u0085', '\u202e'].map((separator) => ({ ...variant, separator })),
    ),
  )(
    'SECRETS_B2_DISPLAY_BOUNDARY preserves the original boundary in $label with $separator',
    ({ sanitize, separator }) => {
      for (const prefix of ['sk-proj-', 'AIza']) {
        const input = `word${separator}${prefix}${'A'.repeat(32)}; public=Q`;
        expect(sanitize(input), 'SECRETS_B2_DISPLAY_BOUNDARY').toBe('[REDACTED]');
        expect(sanitize(`word${separator}public-label; public=Q`)).toBe(
          'wordpublic-label; public=Q',
        );
      }
    },
  );
});

/**
 * `--json` is machine output that is read on a terminal as often as it is piped (#W15-10). `JSON.stringify`
 * escapes `ESC` but leaves DEL, the C1 controls and the Trojan-Source bidi family raw, so the human path's
 * floor did not reach this branch.
 */
describe('stringifyJsonLine — the --json branch had no Trojan-Source floor (#W15-10)', () => {
  const RLO = '\u202e';
  const ALM = '\u061c';
  const DEL = '\u007f';
  const CSI_8BIT = '\u009b';

  it('escapes what JSON.stringify leaves raw — bidi, DEL and the 8-bit CSI', () => {
    for (const hostile of [RLO, ALM, DEL, CSI_8BIT + '2J', '\u200f', '\u2066']) {
      const line = stringifyJsonLine({ message: 'a' + hostile + 'b' });
      // The point of the finding: the raw code point must not survive into the emitted line.
      expect(line).not.toContain(hostile);
      const codePoint = hostile.codePointAt(0);
      expect(codePoint).toBeDefined(); // no `!` — a bad fixture must fail HERE, not as a confusing miss below
      expect(line).toContain('\\u' + (codePoint ?? 0).toString(16).padStart(4, '0'));
    }
  });

  it('is LOSSLESS — a parser reads back the identical string, so the jq contract is unchanged', () => {
    // This is why the fix escapes rather than strips: `--json` promises to reproduce the data.
    const record = { id: 'n1', message: 'transfer ' + RLO + ' to attacker' + DEL, n: 42, ok: true };
    expect(JSON.parse(stringifyJsonLine(record))).toEqual(record);
  });

  it('leaves ordinary records byte-identical to JSON.stringify', () => {
    for (const record of [{ a: 1 }, { s: 'plain text — with an em dash' }, [1, 'two'], null]) {
      expect(stringifyJsonLine(record)).toBe(JSON.stringify(record));
    }
  });

  it('preserves the pre-existing behaviour for a value JSON.stringify cannot represent', () => {
    // The call sites take `unknown`; `.replace` on `undefined` would throw where the old template did not.
    expect(stringifyJsonLine(undefined)).toBe('undefined');
  });
});
