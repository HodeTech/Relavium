/**
 * What the `format:` character classes actually EXCLUDE (ADR-0083 §4).
 *
 * The three classes in `workflow.ts` are written with `String.raw` so they read as the regex source they
 * are. That conversion is exactly the kind that fails silently: get one escape wrong and the class stops
 * excluding control characters, which WIDENS what `format:` accepts rather than narrowing it — and a
 * behavioural suite full of ordinary probe strings would stay green, because none of them carries a C0 byte.
 *
 * Asserted through `violatesInputContract`, the exported entry point admission itself calls. A first draft
 * of this file re-declared the three classes locally and asserted against THOSE — so it tested its own copy
 * and would have passed against any drift in `workflow.ts` whatsoever. A mutation proved it: widening the
 * real class was caught by a neighbouring suite, and not by this one.
 */

import { describe, expect, it } from 'vitest';

import { violatesInputContract } from './workflow.js';

/** Does the declared `format` ACCEPT this value? Straight through the admission-time contract. */
const accepts = (format: string, value: string): boolean =>
  violatesInputContract(value, 'string', { format }) === undefined;

const ESC = String.fromCharCode(0x1b);
const NUL = String.fromCharCode(0x00);
const US = String.fromCharCode(0x1f);
const DEL = String.fromCharCode(0x7f);

describe('the `format` control-character exclusions', () => {
  it('rejects C0, NUL, US and DEL in a `uri` — the Trojan-Source shape the classes exist for', () => {
    expect(accepts('uri', 'http://x/' + ESC + '[2J')).toBe(false);
    expect(accepts('uri', 'http://x/' + NUL)).toBe(false);
    expect(accepts('uri', 'http://x/' + US)).toBe(false);
    expect(accepts('uri', 'http://x/' + DEL)).toBe(false);
  });

  it('rejects them in BOTH halves of an `email` — the local part and the domain', () => {
    expect(accepts('email', 'a' + ESC + 'b@example.com')).toBe(false);
    expect(accepts('email', 'a' + NUL + 'b@example.com')).toBe(false);
    expect(accepts('email', 'ab@exa' + ESC + 'mple.com')).toBe(false);
    expect(accepts('email', 'ab@example.co' + DEL + 'm')).toBe(false);
  });

  it('still accepts the ordinary shapes — the negative control', () => {
    expect(accepts('email', 'someone@example.com')).toBe(true);
    expect(accepts('email', 'first.last@sub.example.co.uk')).toBe(true);
    expect(accepts('uri', 'https://example.com/a?b=c')).toBe(true);
    expect(accepts('uri', 'mailto:someone@example.com')).toBe(true);
    expect(accepts('uri', 'urn:isbn:0451450523')).toBe(true);
  });
});
