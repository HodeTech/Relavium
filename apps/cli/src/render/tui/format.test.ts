import { describe, expect, it } from 'vitest';

import {
  formatCostUsd,
  formatDuration,
  formatTokens,
  SPINNER_FRAMES,
  spinnerFrame,
  statusColor,
  statusGlyph,
} from './format.js';

describe('formatCostUsd', () => {
  it('treats the value as integer micro-cents (1e-8 USD)', () => {
    expect(formatCostUsd(0)).toBe('$0.0000');
    expect(formatCostUsd(5_000_000)).toBe('$0.0500'); // workflow-yaml-spec.md: 5_000_000 ≈ $0.05
    expect(formatCostUsd(100_000_000)).toBe('$1.0000'); // 1e8 micro-cents = $1
    expect(formatCostUsd(123_456_789)).toBe('$1.2346'); // rounds to 4 dp
  });
});

describe('formatDuration', () => {
  it('formats sub-second, second, and minute scales', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(420)).toBe('420ms');
    expect(formatDuration(3200)).toBe('3.2s');
    expect(formatDuration(64_000)).toBe('1m04s');
  });

  it('carries a rounded-up 60s into the next minute (never "1m60s")', () => {
    expect(formatDuration(119_600)).toBe('2m00s'); // 119.6s → round(59.6)=60 → carry to 2m00s
  });

  it('clamps a negative duration (clock skew) to zero', () => {
    expect(formatDuration(-5)).toBe('0ms');
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
