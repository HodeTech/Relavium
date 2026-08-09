import { describe, expect, it } from 'vitest';

import {
  sanitizeUntrusted,
  sanitizeUntrustedInline,
  stringifyJsonLine,
  stripTerminalControls,
} from './sanitize.js';

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
