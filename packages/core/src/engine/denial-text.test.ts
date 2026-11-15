import { describe, expect, it } from 'vitest';

import {
  boundedExplanation,
  DENIAL_EXPLANATION_MAX,
  denialResultText,
  REPEATED_DENIAL_TEXT,
} from './denial-text.js';

describe('denial text (ADR-0117 §2)', () => {
  it('gives each class one fixed text that states nothing was run or changed', () => {
    for (const cls of ['user', 'mode', 'unavailable'] as const) {
      expect(denialResultText(cls, undefined)).toContain('Nothing was');
    }
    expect(REPEATED_DENIAL_TEXT).toContain('Nothing was run or changed');
  });

  it('is identical for every call when no explanation is given — it cannot depend on a target', () => {
    expect(denialResultText('user', undefined)).toBe(denialResultText('user', undefined));
    expect(denialResultText('mode', undefined)).not.toContain('(');
  });

  it("carries the user's words and the mode's label, nothing else", () => {
    expect(denialResultText('user', 'use the fixture')).toContain(
      `The user's reason: "use the fixture"`,
    );
    expect(denialResultText('mode', 'plan mode is read-only')).toContain(
      '(plan mode is read-only)',
    );
  });

  it('flattens controls, bidi overrides and line separators and bounds the length', () => {
    const hostile = `line one\nline two‮\u0007${String.fromCharCode(0x2028)}end`;
    const flat = boundedExplanation(hostile);
    expect(flat).toBe('line one line two end');
    const long = boundedExplanation('x'.repeat(DENIAL_EXPLANATION_MAX * 2));
    expect([...(long ?? '')].length).toBe(DENIAL_EXPLANATION_MAX + 1);
    expect(long?.endsWith('…')).toBe(true);
  });

  it('drops an explanation that is only whitespace or controls', () => {
    expect(boundedExplanation('  \n\t ')).toBeUndefined();
    expect(boundedExplanation(undefined)).toBeUndefined();
    expect(denialResultText('user', '\u0007\u0007')).not.toContain('reason');
  });
});
