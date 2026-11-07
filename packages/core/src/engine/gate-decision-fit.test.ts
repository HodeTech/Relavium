import { describe, expect, it } from 'vitest';

import { decisionsForGateType, gateAcceptsDecision } from './gate-decision-fit.js';

describe('the decisions each human gate type accepts (2.6.K, ruled 2026-11-05)', () => {
  it('approval and review take approved or rejected, never an input', () => {
    for (const gateType of ['approval', 'review'] as const) {
      expect(gateAcceptsDecision(gateType, 'approved')).toBe(true);
      expect(gateAcceptsDecision(gateType, 'rejected')).toBe(true);
      expect(gateAcceptsDecision(gateType, 'input_provided')).toBe(false);
    }
  });

  it('input takes its input or a rejection, never an approval', () => {
    expect(gateAcceptsDecision('input', 'input_provided')).toBe(true);
    expect(gateAcceptsDecision('input', 'rejected')).toBe(true);
    expect(gateAcceptsDecision('input', 'approved')).toBe(false);
    expect(decisionsForGateType('input')).toEqual(['input_provided', 'rejected']);
  });
});
