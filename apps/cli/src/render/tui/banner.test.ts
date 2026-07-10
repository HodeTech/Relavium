import { describe, expect, it } from 'vitest';

import { BANNER_EXTRA_ROWS, bannerLines, shouldShowBanner } from './banner.js';
import { HOME_MIN_COLS, HOME_MIN_ROWS } from './home-projection.js';
import { displayWidth } from './viewport.js';

/**
 * The branded Home banner (2.6.F Step 5g, ADR-0068). It gates no feature, so the bar here is not "does it work" but
 * "can it ever look broken": a plaque with a ragged right edge, one that overflows the terminal and wraps, or one that
 * prints `╭` into a terminal that cannot draw it.
 */

/** Printable ASCII only — no box-drawing glyph, no control character. */
const ASCII_ONLY = /^[\x20-\x7e]*$/;

describe('bannerLines', () => {
  it('every line is EXACTLY the same display width — a ragged plaque looks broken, not branded', () => {
    for (const cols of [80, 81, 100, 120, 200]) {
      const widths = bannerLines(cols, false).map((l) => displayWidth(l.text));
      expect(new Set(widths).size, `cols=${cols}`).toBe(1);
    }
  });

  it('never exceeds the terminal width — an overflowing line WRAPS and destroys the box', () => {
    for (let cols = 20; cols <= 200; cols += 1) {
      for (const ascii of [false, true]) {
        const widest = Math.max(...bannerLines(cols, ascii).map((l) => displayWidth(l.text)));
        expect(widest, `cols=${cols} ascii=${String(ascii)}`).toBeLessThanOrEqual(cols);
      }
    }
  });

  it('at every supported width it draws the full plaque: border, wordmark, tagline, border', () => {
    const lines = bannerLines(HOME_MIN_COLS, false);
    expect(lines.map((l) => l.kind)).toEqual(['border', 'wordmark', 'tagline', 'border']);
    expect(lines[1]?.text).toContain('R E L A V I U M');
    expect(lines[2]?.text).toContain('Own every run.');
  });

  it('drops the TAGLINE before the wordmark when the terminal is too narrow', () => {
    // The brand survives; the sentence does not. (Below HOME_MIN_COLS the Home is in its too-small mode anyway, so
    // this is defensive — but `bannerLines` is exported and must be total.)
    const lines = bannerLines(30, false);
    expect(lines.map((l) => l.kind)).toEqual(['border', 'wordmark', 'border']);
    expect(lines[1]?.text).toContain('R E L A V I U M');
  });

  it('truncates the wordmark rather than overflow, at an absurd width', () => {
    const lines = bannerLines(8, false);
    expect(Math.max(...lines.map((l) => displayWidth(l.text)))).toBeLessThanOrEqual(8);
  });

  it('NO_COLOR / --no-color degrades to PLAIN ASCII — no box-drawing glyph survives', () => {
    const ascii = bannerLines(HOME_MIN_COLS, true);
    for (const line of ascii) expect(line.text, line.text).toMatch(ASCII_ONLY);
    // …and the coloured form really does use box-drawing, so the test above is not vacuous.
    const unicode = bannerLines(HOME_MIN_COLS, false);
    expect(unicode.some((l) => /[╭╮╰╯─│]/.test(l.text))).toBe(true);
  });

  it('the ASCII and Unicode plaques are the same SHAPE — only the glyphs change', () => {
    const a = bannerLines(HOME_MIN_COLS, true);
    const u = bannerLines(HOME_MIN_COLS, false);
    expect(a.map((l) => l.kind)).toEqual(u.map((l) => l.kind));
    expect(a.map((l) => displayWidth(l.text))).toEqual(u.map((l) => displayWidth(l.text)));
  });

  it('every line carries a UNIQUE, stable id — the two ASCII borders are byte-identical', () => {
    // Keying the React children by `text` gave the top and bottom borders the same key under `NO_COLOR`
    // (`+---…---+` both), and React printed "Encountered two children with the same key" onto the alt buffer,
    // because the Home mounts ink with `patchConsole: false`. Verified against the real renderer before fixing.
    for (const ascii of [true, false]) {
      const lines = bannerLines(HOME_MIN_COLS, ascii);
      expect(new Set(lines.map((l) => l.id)).size).toBe(lines.length);
    }
    const ascii = bannerLines(HOME_MIN_COLS, true);
    expect(ascii[0]?.text).toBe(ascii.at(-1)?.text); // …and this is exactly why an id is needed
    expect(ascii[0]?.id).not.toBe(ascii.at(-1)?.id);
  });

  it('the plaque costs exactly BANNER_EXTRA_ROWS more than the one-line heading it replaces', () => {
    expect(bannerLines(HOME_MIN_COLS, false)).toHaveLength(1 + BANNER_EXTRA_ROWS);
  });
});

describe('shouldShowBanner', () => {
  const at = (over: Partial<Parameters<typeof shouldShowBanner>[0]> = {}): boolean =>
    shouldShowBanner({
      configShowBanner: undefined,
      isEmpty: true,
      rows: HOME_MIN_ROWS + BANNER_EXTRA_ROWS,
      ...over,
    });

  it('`false` never shows it, whatever else is true', () => {
    expect(at({ configShowBanner: false })).toBe(false);
    expect(at({ configShowBanner: false, isEmpty: true, rows: 200 })).toBe(false);
  });

  it('absent ⇒ shown while the Home is EMPTY, and auto-dismissed once there is anything to continue', () => {
    // The ADR asked for "the first five opens", which needs a durable counter. An empty Home IS that signal, and it
    // stops the instant the user's first chat gives them something to continue.
    expect(at({ isEmpty: true })).toBe(true);
    expect(at({ isEmpty: false })).toBe(false);
  });

  it('`true` shows it even on a busy Home — the user asked for it', () => {
    expect(at({ configShowBanner: true, isEmpty: false })).toBe(true);
  });

  it('never below HOME_MIN_ROWS — the Home is already in its too-small mode there', () => {
    expect(at({ rows: HOME_MIN_ROWS - 1 })).toBe(false);
    expect(at({ configShowBanner: true, rows: HOME_MIN_ROWS - 1 })).toBe(false);
  });

  it('a FORCED banner also needs room for the strip it would otherwise push off the screen', () => {
    // An empty Home has almost nothing below the banner, so exactly HOME_MIN_ROWS is fine there. A forced one on a
    // busy Home is not: the plaque would eat the rows the strip and prompt need on an 80x24 terminal.
    expect(at({ isEmpty: true, rows: HOME_MIN_ROWS })).toBe(true);
    expect(at({ configShowBanner: true, isEmpty: false, rows: HOME_MIN_ROWS })).toBe(false);
    expect(
      at({ configShowBanner: true, isEmpty: false, rows: HOME_MIN_ROWS + BANNER_EXTRA_ROWS }),
    ).toBe(true);
  });
});
