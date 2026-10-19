import { describe, expect, it } from 'vitest';

import { SplitProbeInvariantError, splitProbe } from './split-credential-probe.js';

function invariantCode(rule: Parameters<typeof splitProbe>[0]): string | undefined {
  try {
    splitProbe(rule);
    return undefined;
  } catch (error) {
    if (error instanceof SplitProbeInvariantError) return error.code;
    throw error;
  }
}

describe('split-credential scanner invariants', () => {
  it('refuses a boundary-bearing rule with neither a joined pattern nor a \\b-prefixed source', () => {
    expect(invariantCode({ pattern: /token-[a-z]+/g, boundary: /\w/ })).toBe(
      'joined_form_required',
    );
    expect(invariantCode({ pattern: /\btoken-[a-z]+/g, boundary: /\w/ })).toBeUndefined();
    expect(
      invariantCode({ pattern: /token-[a-z]+/g, joinedPattern: /token-/g, boundary: /\w/ }),
    ).toBeUndefined();
  });

  it('refuses a boundary that treats some ASCII word characters differently from others', () => {
    for (const boundary of [/[a-z]/, /[A-Za-z]/, /\d/, /_/]) {
      expect(invariantCode({ pattern: /\bx/g, boundary })).toBe('mixed_word_boundary');
    }
    for (const boundary of [/\w/, /[A-Za-z0-9_-]/, /(?!)/]) {
      expect(invariantCode({ pattern: /\bx/g, boundary })).toBeUndefined();
    }
  });

  it('reports the refusal as a typed error with a fixed message', () => {
    expect(() => splitProbe({ pattern: /x/g, boundary: /\w/ })).toThrow(
      new SplitProbeInvariantError('joined_form_required'),
    );
    const error = new SplitProbeInvariantError('mixed_word_boundary');
    expect(error.name).toBe('SplitProbeInvariantError');
    expect(error.message).toBe(
      'scrub rule violates the split-credential scanner invariant: mixed_word_boundary',
    );
  });

  it('strips only the \\b of a source without a joined pattern', () => {
    const probe = splitProbe({ pattern: /\bsk-[\w-]+/g, boundary: /\w/ });
    expect(probe.preflight.source).toBe('sk-[\\w-]+');
    expect(probe.sticky.source).toBe('sk-[\\w-]+');
    const joined = splitProbe({ pattern: /x/gi, joinedPattern: /\bkey:/gi, boundary: /\w/ });
    expect(joined.preflight.source).toBe('\\bkey:');
  });

  it('compiles a stateless preflight and a sticky scanner that keep the other flags', () => {
    const probe = splitProbe({ pattern: /x/gi, joinedPattern: /api-key:/gi, boundary: /\w/ });
    expect(probe.preflight.flags).toBe('i');
    expect(probe.sticky.flags).toBe('iy');
    // A global preflight would carry lastIndex between diagnostics and miss the second match.
    expect(probe.preflight.test('API-KEY:')).toBe(true);
    expect(probe.preflight.test('API-KEY:')).toBe(true);
  });

  it('derives the word-start skip from the boundary and carries the anchor through', () => {
    expect(splitProbe({ pattern: /\bx/g, boundary: /\w/ }).wordBlocksStart).toBe(true);
    const anchor = { text: '://', window: 32 };
    const url = splitProbe({ pattern: /x/g, joinedPattern: /x/g, boundary: /(?!)/, anchor });
    expect(url.wordBlocksStart).toBe(false);
    expect(url.anchor).toBe(anchor);
  });
});
