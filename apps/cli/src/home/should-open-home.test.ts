import { describe, expect, it } from 'vitest';

import { shouldOpenHome, type HomeGateSignals } from './should-open-home.js';

const interactive: HomeGateSignals = {
  stdoutIsTty: true,
  stdinIsTty: true,
  json: false,
  env: {},
};

describe('shouldOpenHome', () => {
  it('opens the Home only when fully interactive (TTY stdout + stdin, no --json, no CI)', () => {
    expect(shouldOpenHome(interactive)).toBe(true);
  });

  it('keeps help (no Home) when stdout is not a TTY (piped/redirected output)', () => {
    expect(shouldOpenHome({ ...interactive, stdoutIsTty: false })).toBe(false);
  });

  it('keeps help when stdin is not a TTY (the prompt cannot read keystrokes)', () => {
    expect(shouldOpenHome({ ...interactive, stdinIsTty: false })).toBe(false);
  });

  it('keeps help under --json (machine output wins over the TUI)', () => {
    expect(shouldOpenHome({ ...interactive, json: true })).toBe(false);
  });

  it('keeps help under CI — including CI=1 and a pseudo-TTY runner', () => {
    expect(shouldOpenHome({ ...interactive, env: { CI: 'true' } })).toBe(false);
    expect(shouldOpenHome({ ...interactive, env: { CI: '1' } })).toBe(false); // not just CI === 'true'
  });

  it('opens the Home when CI is falsey/unset', () => {
    expect(shouldOpenHome({ ...interactive, env: { CI: 'false' } })).toBe(true);
    expect(shouldOpenHome({ ...interactive, env: { CI: '0' } })).toBe(true);
    expect(shouldOpenHome({ ...interactive, env: {} })).toBe(true);
  });
});
