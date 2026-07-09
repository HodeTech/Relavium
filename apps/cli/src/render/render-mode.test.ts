import { describe, expect, it } from 'vitest';

import { DEFAULT_ALT_SCREEN, resolveRenderMode, type RenderModeInput } from './render-mode.js';

const input = (over: Partial<RenderModeInput> = {}): RenderModeInput => ({
  outputMode: 'tui',
  noAltScreenFlag: false,
  configAltScreen: undefined,
  ...over,
});

describe('resolveRenderMode (2.6.F / ADR-0068 §e)', () => {
  it('a machine / non-TTY (plain) output mode is ALWAYS inline — the byte-identical guarantee', () => {
    // Plain wins even when the flag/config would enable alt — the machine path can never be alt-screened.
    expect(resolveRenderMode(input({ outputMode: 'plain' }))).toBe('inline');
    expect(resolveRenderMode(input({ outputMode: 'plain', configAltScreen: true }))).toBe('inline');
    expect(
      resolveRenderMode(
        input({ outputMode: 'plain', configAltScreen: true, defaultAltScreen: true }),
      ),
    ).toBe('inline');
  });

  it('the --no-alt-screen flag opts out, overriding an opt-in config key', () => {
    expect(resolveRenderMode(input({ noAltScreenFlag: true, configAltScreen: true }))).toBe(
      'inline',
    );
    expect(resolveRenderMode(input({ noAltScreenFlag: true, defaultAltScreen: true }))).toBe(
      'inline',
    );
  });

  it('the config key decides when no flag is set: true ⇒ alt, false ⇒ inline', () => {
    expect(resolveRenderMode(input({ configAltScreen: true }))).toBe('alt');
    expect(resolveRenderMode(input({ configAltScreen: false }))).toBe('inline');
    // A false config key overrides an alt phase default (an explicit opt-out beats the default).
    expect(resolveRenderMode(input({ configAltScreen: false, defaultAltScreen: true }))).toBe(
      'inline',
    );
  });

  it('falls to the phase default when neither flag nor config decides', () => {
    expect(resolveRenderMode(input({ defaultAltScreen: true }))).toBe('alt');
    expect(resolveRenderMode(input({ defaultAltScreen: false }))).toBe('inline');
    // Omitting defaultAltScreen uses DEFAULT_ALT_SCREEN — alt since 4b-3 (full-screen is the first-class default).
    expect(resolveRenderMode(input())).toBe(DEFAULT_ALT_SCREEN ? 'alt' : 'inline');
    expect(DEFAULT_ALT_SCREEN).toBe(true); // pin the 4b-3 phase default explicitly (bare TTY opens full-screen)
  });

  it('precedence chain end-to-end: plain > flag > config > default', () => {
    // config true would enable, but the flag opts out; the flag would be moot on plain.
    expect(resolveRenderMode(input({ configAltScreen: true }))).toBe('alt'); // config alone
    expect(resolveRenderMode(input({ configAltScreen: true, noAltScreenFlag: true }))).toBe(
      'inline',
    ); // flag beats config
    expect(
      resolveRenderMode(
        input({ configAltScreen: true, noAltScreenFlag: true, outputMode: 'plain' }),
      ),
    ).toBe('inline'); // plain beats all
  });
});
