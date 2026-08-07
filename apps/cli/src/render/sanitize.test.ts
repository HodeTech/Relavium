import { describe, expect, it } from 'vitest';

import { sanitizeUntrusted, sanitizeUntrustedInline } from './sanitize.js';

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
    // NOT a proof that redact-before-strip matters: swapping the order leaves this green, because
    // `scrubSecrets` matches the surviving prefix either way. It pins the outcome, not the ordering.
    const split = join('sk-', 'ant-', 'api03-AbCdEf', '\u001b', '[0m', '0123456789xyz');
    expect(sanitizeUntrusted(split)).not.toContain('AbCdEf0123456789xyz');
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
});
