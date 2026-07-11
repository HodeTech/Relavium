import { describe, expect, it } from 'vitest';

import {
  DEFAULT_COPY_ON_SELECT,
  resolveCopyOnSelect,
  DEFAULT_ALT_SCREEN,
  DEFAULT_MOUSE,
  resolveMouseMode,
  resolveRenderMode,
  type RenderModeInput,
} from './render-mode.js';

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

/**
 * `resolveMouseMode` (2.6.F Step 5e, ADR-0068 §e). Precedence mirrors `resolveRenderMode`, with one extra structural
 * guarantee: the INLINE renderer can never enable mouse reporting, whatever the flag or the config key say — capturing
 * the mouse there would break the emulator's native scrollback selection, which is the whole reason inline exists.
 */
describe('resolveMouseMode', () => {
  const base = { renderMode: 'alt', noMouseFlag: false, configMouse: undefined } as const;

  it('defaults to ON inside the alt screen (a maintainer deviation from §e, recorded in the ADR)', () => {
    expect(resolveMouseMode(base)).toBe(true);
    expect(DEFAULT_MOUSE).toBe(true);
  });

  it('the INLINE renderer never enables the mouse — not by config, not by the phase default', () => {
    expect(resolveMouseMode({ ...base, renderMode: 'inline' })).toBe(false);
    expect(resolveMouseMode({ ...base, renderMode: 'inline', configMouse: true })).toBe(false);
    expect(resolveMouseMode({ ...base, renderMode: 'inline', defaultMouse: true })).toBe(false);
  });

  it('`--no-mouse` overrides the config key (the flag is the per-invocation opt-out)', () => {
    expect(resolveMouseMode({ ...base, noMouseFlag: true, configMouse: true })).toBe(false);
  });

  it('`[preferences].mouse` is the durable opt-out / opt-in when no flag is passed', () => {
    expect(resolveMouseMode({ ...base, configMouse: false })).toBe(false);
    expect(resolveMouseMode({ ...base, configMouse: true, defaultMouse: false })).toBe(true);
  });

  it('falls to the injected phase default when neither flag nor key decides', () => {
    expect(resolveMouseMode({ ...base, defaultMouse: false })).toBe(false);
  });
});

/**
 * `[preferences].copy_on_select` (2.6.F Step 6e). Deliberately has NO flag: it is a durable preference, and
 * `--no-mouse` already removes the gesture that produces a copy.
 */
describe('resolveCopyOnSelect', () => {
  it('defaults ON when the mouse is on', () => {
    expect(resolveCopyOnSelect({ mouseEnabled: true, configCopyOnSelect: undefined })).toBe(
      DEFAULT_COPY_ON_SELECT,
    );
    expect(DEFAULT_COPY_ON_SELECT).toBe(true);
  });

  it('the config key opts out durably, and can also opt IN explicitly', () => {
    expect(resolveCopyOnSelect({ mouseEnabled: true, configCopyOnSelect: false })).toBe(false);
    expect(resolveCopyOnSelect({ mouseEnabled: true, configCopyOnSelect: true })).toBe(true);
  });

  it('is STRUCTURALLY off without the mouse — no selection can exist, so nothing can be copied', () => {
    // Taking the already-resolved mouse decision (not the raw flag/key) is what makes this unbypassable: an unmoused
    // caller cannot ask for copy-on-select even by setting the key. Same trick as `resolveMouseMode(renderMode)`.
    expect(resolveCopyOnSelect({ mouseEnabled: false, configCopyOnSelect: true })).toBe(false);
    expect(resolveCopyOnSelect({ mouseEnabled: false, configCopyOnSelect: undefined })).toBe(false);
  });

  it('honours an injected phase default (so the default can move without touching call sites)', () => {
    expect(
      resolveCopyOnSelect({
        mouseEnabled: true,
        configCopyOnSelect: undefined,
        defaultCopyOnSelect: false,
      }),
    ).toBe(false);
  });
});
