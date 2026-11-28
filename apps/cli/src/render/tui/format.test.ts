import { describe, expect, it } from 'vitest';

import {
  formatCostShort,
  formatProducedMedia,
  formatReportedCost,
  formatTokens,
  SPINNER_FRAMES,
  spinnerFrame,
  statusColor,
  statusGlyph,
} from './format.js';

// The USD notation, the durations and the ages are `render/notation.ts`'s, with their own tests (`notation.test.ts`); what stays here is
// the coverage qualification this module adds to an amount.
describe('formatReportedCost — the amount is the one USD notation', () => {
  it('shows integer micro-cents (1e-8 USD) as four fractional digits', () => {
    expect(
      formatReportedCost(5_000_000, { unverified: false, pendingInvocations: 0, unknownCalls: 0 }),
    ).toBe('$0.0500');
    expect(
      formatReportedCost(123_456_789, {
        unverified: false,
        pendingInvocations: 0,
        unknownCalls: 0,
      }),
    ).toBe('$1.2346');
  });
});

describe('formatCostShort — coverage-qualified Home amounts', () => {
  const complete = { unverified: false, pendingInvocations: 0, unknownCalls: 0 };
  it('calls only a verified fully priced zero free, preserving the canonical conversion', () => {
    expect(formatCostShort(0, complete)).toBe('free');
    expect(formatCostShort(100_000_000, complete)).toBe('$1.0000');
    expect(formatCostShort(5_000_000, complete)).toBe('$0.0500');
    expect(formatCostShort(0, undefined), 'USAGE_CAUSAL_VERIFIED_FREE').toBe(
      '$0.0000 known; usage unverified',
    );
    expect(formatCostShort(0, { ...complete, pendingInvocations: 1 })).toBe(
      '$0.0000 known; 1 usage pending',
    );
    expect(formatCostShort(0, { ...complete, unknownCalls: 2 })).toBe(
      '$0.0000 known; usage unknown for 2 calls',
    );
    expect(formatCostShort(0, complete, 1)).toBe('$0.0000 known; price unknown for 1 call');
  });
  it('does not present invalid amounts as free', () => {
    for (const value of [-5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(formatCostShort(value, complete)).toBe('unavailable');
  });
});

describe('formatTokens', () => {
  it('renders an up/down token pair', () => {
    expect(formatTokens({ input: 12, output: 34 })).toBe('↑12 ↓34');
  });
});

describe('spinnerFrame', () => {
  it('cycles through the frames and wraps', () => {
    expect(spinnerFrame(0)).toBe(SPINNER_FRAMES[0]);
    expect(spinnerFrame(SPINNER_FRAMES.length)).toBe(SPINNER_FRAMES[0]); // wraps
    expect(spinnerFrame(1)).toBe(SPINNER_FRAMES[1]);
  });

  it('guards a non-finite tick', () => {
    expect(spinnerFrame(Number.NaN)).toBe(SPINNER_FRAMES[0]);
    expect(spinnerFrame(-1)).toBe(SPINNER_FRAMES.at(-1));
  });
});

describe('statusGlyph / statusColor', () => {
  it('maps every status to a distinct glyph and a color', () => {
    const statuses = ['pending', 'running', 'completed', 'failed', 'skipped', 'retrying'] as const;
    const glyphs = statuses.map(statusGlyph);
    expect(new Set(glyphs).size).toBe(statuses.length); // all distinct
    expect(statusColor('completed')).toBe('green');
    expect(statusColor('failed')).toBe('red');
    expect(statusColor('retrying')).toBe('yellow');
  });
});

describe('formatProducedMedia', () => {
  it('renders the durable handle + mime on one line (monochrome glyph), never inline bytes', () => {
    const handle = `media://sha256-${'a'.repeat(64)}`;
    expect(formatProducedMedia({ mimeType: 'image/png', handle })).toBe(`◆ image/png ${handle}`);
    // Pure mimeType passthrough — a non-image modality is rendered verbatim (no per-modality special-casing).
    expect(formatProducedMedia({ mimeType: 'audio/mpeg', handle })).toBe(`◆ audio/mpeg ${handle}`);
  });
});
