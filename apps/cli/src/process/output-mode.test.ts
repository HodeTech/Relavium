import { describe, expect, it } from 'vitest';

import { detectOutputMode, isCiEnv } from './output-mode.js';

describe('detectOutputMode', () => {
  it('selects the TUI only with a TTY and no machine-output forcing', () => {
    expect(detectOutputMode({ stdoutIsTty: true, json: false, ci: false })).toBe('tui');
  });

  it('falls back to plain with no TTY (piped stdout)', () => {
    expect(detectOutputMode({ stdoutIsTty: false, json: false, ci: false })).toBe('plain');
  });

  it('forces plain under --json even with a TTY', () => {
    expect(detectOutputMode({ stdoutIsTty: true, json: true, ci: false })).toBe('plain');
  });

  it('forces plain under CI even with a TTY', () => {
    expect(detectOutputMode({ stdoutIsTty: true, json: false, ci: true })).toBe('plain');
  });
});

describe('isCiEnv', () => {
  it('is true for a non-falsey CI value', () => {
    expect(isCiEnv({ CI: 'true' })).toBe(true);
    expect(isCiEnv({ CI: '1' })).toBe(true);
  });

  it('is false when CI is absent or explicitly falsey', () => {
    expect(isCiEnv({})).toBe(false);
    expect(isCiEnv({ CI: '' })).toBe(false);
    expect(isCiEnv({ CI: 'false' })).toBe(false);
    expect(isCiEnv({ CI: '0' })).toBe(false);
  });
});
