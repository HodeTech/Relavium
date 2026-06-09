import { describe, expect, it } from 'vitest';

import {
  RETRYABLE_KINDS,
  isRetryable,
  kindFromHttpStatus,
  makeLlmError,
  scrubSecrets,
} from './llm-error.js';
import { LlmErrorSchema } from './types.js';

const byLocale = (a: string, b: string): number => a.localeCompare(b);

describe('LlmError classification (the fallback contract)', () => {
  it('marks exactly the four transient kinds retryable', () => {
    expect([...RETRYABLE_KINDS].sort(byLocale)).toEqual([
      'overloaded',
      'rate_limit',
      'timeout',
      'transport',
    ]);
    for (const kind of ['rate_limit', 'overloaded', 'timeout', 'transport'] as const) {
      expect(isRetryable(kind)).toBe(true);
    }
    for (const kind of ['auth', 'bad_request', 'content_filter', 'cancelled', 'unknown'] as const) {
      expect(isRetryable(kind)).toBe(false);
    }
  });

  it('maps HTTP statuses to kinds (rate limit → retryable; auth → fatal)', () => {
    expect(kindFromHttpStatus(429)).toBe('rate_limit');
    expect(kindFromHttpStatus(529)).toBe('overloaded');
    expect(kindFromHttpStatus(408)).toBe('timeout');
    expect(kindFromHttpStatus(503)).toBe('overloaded'); // 5xx
    expect(kindFromHttpStatus(401)).toBe('auth');
    expect(kindFromHttpStatus(403)).toBe('auth');
    expect(kindFromHttpStatus(400)).toBe('bad_request');
    expect(kindFromHttpStatus(409)).toBe('bad_request');
    expect(kindFromHttpStatus(413)).toBe('bad_request');
    expect(kindFromHttpStatus(418)).toBe('unknown');
    expect(isRetryable(kindFromHttpStatus(429))).toBe(true);
    expect(isRetryable(kindFromHttpStatus(401))).toBe(false);
  });

  it('builds a valid LlmError with retryable derived from kind', () => {
    const e = makeLlmError({
      provider: 'anthropic',
      kind: 'rate_limit',
      message: 'slow down',
      status: 429,
      code: 'rate_limit',
    });
    expect(LlmErrorSchema.safeParse(e).success).toBe(true);
    expect(e).toMatchObject({
      kind: 'rate_limit',
      retryable: true,
      provider: 'anthropic',
      status: 429,
    });

    const fatal = makeLlmError({ provider: 'openai', kind: 'auth', message: 'invalid key' });
    expect(fatal.retryable).toBe(false);
  });

  it('omits optional fields rather than setting them undefined', () => {
    const e = makeLlmError({ provider: 'gemini', kind: 'cancelled', message: 'aborted' });
    expect(Object.keys(e).sort(byLocale)).toEqual(['kind', 'message', 'provider', 'retryable']);
  });
});

describe('makeLlmError optional fields', () => {
  it('includes cause and code when provided', () => {
    const cause = new Error('boom');
    const e = makeLlmError({
      provider: 'anthropic',
      kind: 'unknown',
      message: 'x',
      cause,
      code: 'weird',
    });
    expect(e.cause).toBe(cause);
    expect(e.code).toBe('weird');
  });
});

describe('scrubSecrets — defense-in-depth secret backstop (no key/token/baseURL across the seam)', () => {
  // Build key-shaped strings at runtime so no contiguous key-like literal sits in source (avoids
  // secret-scanner false positives); behavior is identical to an inline literal.
  const join = (...parts: string[]): string => parts.join('');
  const antKey = join('sk-', 'ant-', 'api03-AbCdEf0123456789xyz');
  const projKey = join('sk-', 'proj-', 'ABCDEFGHIJKLMNOP123');
  const googleKey = join('AI', 'za', 'SyA1234567890abcdefghijklmnopqrstuv');
  const bearerTok = 'abc.def.ghi12345';

  it('masks key prefixes, query secrets, URL userinfo (with/without password), and Bearer/Basic headers', () => {
    expect(scrubSecrets(`auth failed for ${antKey}`)).not.toContain('AbCdEf0123456789');
    expect(scrubSecrets(`key ${antKey}`)).toContain('[REDACTED]');
    expect(scrubSecrets(join('google ', googleKey, ' bad'))).not.toContain('SyA1234567890');
    expect(
      scrubSecrets('GET https://api.example.com/v1?api_key=SECRET12345abc failed'),
    ).not.toContain('SECRET12345abc');
    // `x-api-key` as a query param with an OPAQUE value (no sk-/AIza prefix for the key-shape
    // patterns to catch) — only the param-name rule can mask it. Built via join() like the keys
    // above (no contiguous secret-shaped literal in source).
    const opaqueVal = join('opaque', 'Value123456789');
    expect(
      scrubSecrets(`GET https://api.example.com/v1?x-api-key=${opaqueVal} failed`),
    ).not.toContain(opaqueVal);
    expect(scrubSecrets('connect https://user:p4ssw0rd@host/x')).not.toContain('p4ssw0rd');
    // username-only userinfo (no password) must also be redacted
    expect(scrubSecrets('connect https://onlytoken@host/x')).not.toContain('onlytoken');
    expect(scrubSecrets(`header Authorization: Bearer ${bearerTok} rejected`)).not.toContain(
      bearerTok,
    );
    // surrounding text is preserved (the Bearer pattern is not too greedy)
    expect(scrubSecrets(`header Authorization: Bearer ${bearerTok} rejected`)).toContain(
      'rejected',
    );
    // Basic auth header is redacted too, surrounding text preserved
    expect(scrubSecrets('header Authorization: Basic dXNlcjpwYXNz extra')).not.toContain(
      'dXNlcjpwYXNz',
    );
    expect(scrubSecrets('header Authorization: Basic dXNlcjpwYXNz extra')).toContain('extra');
  });

  it('leaves benign error text untouched (no over-redaction of normal messages)', () => {
    for (const msg of [
      'slow down',
      'invalid key',
      'aborted',
      'rate limited, retry later',
      'model not found',
      'https://api.openai.com/v1', // clean URL — no userinfo, no secret query
      '?keyword=value', // near-miss param name (not key/token/secret)
      '?tokenize=abc', // near-miss param name
      join('sk-', 'short'), // below the {16,} key-length floor — not a key
      '', // empty
    ]) {
      expect(scrubSecrets(msg)).toBe(msg);
    }
  });

  it('makeLlmError scrubs message AND code at the one choke point (every adapter benefits)', () => {
    const e = makeLlmError({
      provider: 'openai',
      kind: 'auth',
      message: `invalid key ${projKey} at https://api.x.com/v1?token=tok_SECRETvalue`,
      code: 'bad https://u:pw@h/x',
    });
    expect(e.message).not.toContain('ABCDEFGHIJKLMNOP123');
    expect(e.message).not.toContain('tok_SECRETvalue');
    expect(e.message).toContain('[REDACTED]');
    expect(e.code).not.toContain('pw@');
    expect(LlmErrorSchema.safeParse(e).success).toBe(true);
  });
});
