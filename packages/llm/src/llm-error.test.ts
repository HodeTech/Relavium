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
  it('masks an API-key prefix, a token in a URL query string, URL userinfo, and a Bearer header', () => {
    expect(scrubSecrets('auth failed for sk-ant-api03-AbCdEf0123456789xyz')).not.toContain(
      'AbCdEf0123456789',
    );
    expect(
      scrubSecrets('GET https://api.example.com/v1?api_key=SECRET12345abc failed'),
    ).not.toContain('SECRET12345abc');
    expect(scrubSecrets('connect https://user:p4ssw0rd@host/x')).not.toContain('p4ssw0rd');
    expect(scrubSecrets('header Authorization: Bearer abc.def.ghi12345 rejected')).not.toContain(
      'abc.def.ghi12345',
    );
    // surrounding text is preserved (the Bearer pattern is not too greedy)
    expect(scrubSecrets('header Authorization: Bearer abc.def.ghi12345 rejected')).toContain(
      'rejected',
    );
    expect(scrubSecrets('google AIzaSyA1234567890abcdefghijklmnopqrstuv bad')).not.toContain(
      'AIzaSyA1234567890',
    );
    // a redaction marker is left in place of the secret
    expect(scrubSecrets('key sk-ant-api03-AbCdEf0123456789xyz')).toContain('[REDACTED]');
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
      'sk-short', // below the {16,} key-length floor — not a key
      '', // empty
    ]) {
      expect(scrubSecrets(msg)).toBe(msg);
    }
  });

  it('makeLlmError scrubs message AND code at the one choke point (every adapter benefits)', () => {
    const e = makeLlmError({
      provider: 'openai',
      kind: 'auth',
      message:
        'invalid key sk-proj-ABCDEFGHIJKLMNOP123 at https://api.x.com/v1?token=tok_SECRETvalue',
      code: 'bad https://u:pw@h/x',
    });
    expect(e.message).not.toContain('sk-proj-ABCDEFGHIJKLMNOP123');
    expect(e.message).not.toContain('tok_SECRETvalue');
    expect(e.message).toContain('[REDACTED]');
    expect(e.code).not.toContain('pw@');
    expect(LlmErrorSchema.safeParse(e).success).toBe(true);
  });
});
