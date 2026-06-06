import { describe, expect, it } from 'vitest';

import { RETRYABLE_KINDS, isRetryable, kindFromHttpStatus, makeLlmError } from './llm-error.js';
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
