import { describe, expect, it } from 'vitest';

import { THIN_RULE_MAX_WIDTH, thinRule } from './home-layout.js';

/**
 * The thin rule under the prompt is drawn for whatever width its host reports, and a suspended terminal reports `0`, `NaN` or `Infinity`
 * ([ADR-0146](../../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md) §4): it
 * draws nothing for a width that is not a real count and never throws, and it is never longer than the widest terminal.
 */
describe('the thin rule for a width that is not a real count', () => {
  it.each([
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['NaN', Number.NaN],
    ['a negative width', -3],
    ['zero', 0],
    ['a fraction below one', 0.9],
  ])('is nothing for %s, in both glyph forms, and does not throw', (_name, width) => {
    expect(thinRule(width, false)).toBe('');
    expect(thinRule(width, true)).toBe('');
  });

  it('is never longer than the cap, however wide the width says', () => {
    expect(THIN_RULE_MAX_WIDTH).toBe(400);
    expect(thinRule(THIN_RULE_MAX_WIDTH, true)).toHaveLength(400);
    expect(thinRule(THIN_RULE_MAX_WIDTH + 1, true)).toHaveLength(400);
    expect(thinRule(1e9, false)).toHaveLength(400);
    expect(thinRule(Number.MAX_VALUE, false)).toHaveLength(400);
  });

  it('is exactly the width for a real count, whole columns only', () => {
    expect(thinRule(1, true)).toBe('-');
    expect(thinRule(80, false)).toBe('─'.repeat(80));
    expect(thinRule(399, true)).toBe('-'.repeat(399));
    expect(thinRule(5.9, true)).toBe('-----');
  });
});
