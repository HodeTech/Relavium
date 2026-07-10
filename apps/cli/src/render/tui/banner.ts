import { HOME_MIN_ROWS } from './home-projection.js';
import { displayWidth, sliceDisplayColumns } from './viewport.js';

/**
 * The branded Home banner (2.6.F Step 5g, ADR-0068).
 *
 * PURE: it computes lines and says what each one IS; `home-view.tsx` decides how to paint them. Everything a terminal
 * can get wrong about a decorative plaque — width, glyph support, colour — is decided here, once, and tested here.
 *
 * It is a **cosmetic substrate element**: it gates no feature, and the Home renders identically without it.
 */

/** The wordmark, letter-spaced. Not ASCII art: a five-row block font eats a fifth of an 80x24 terminal, and it looks
 *  dated next to the box-drawn strip below it. */
const WORDMARK = 'R E L A V I U M';

/** Relavium's positioning line, verbatim from the README — one place it can drift from, and it is a doc. */
const TAGLINE = 'Start as an agent. Ship the workflow. Own every run.';

/** Rows the banner adds over the plain one-line heading it replaces (border, wordmark, tagline, border ⇒ 4, less 1). */
export const BANNER_EXTRA_ROWS = 3;

/** Horizontal padding inside the plaque, each side. */
const PADDING = 2;

/** What a banner line is, so the renderer can style it without parsing it back. */
export interface BannerLine {
  /** A STABLE, unique React key. Not the text: under `NO_COLOR` the two ASCII borders are byte-identical
   *  (`+---…---+`), and keying by text gave React two children with the same key — a runtime error printed straight
   *  onto the alt buffer, because the Home mounts ink with `patchConsole: false`. */
  readonly id: 'top' | 'wordmark' | 'tagline' | 'bottom';
  readonly text: string;
  readonly kind: 'border' | 'wordmark' | 'tagline';
}

interface Glyphs {
  readonly topLeft: string;
  readonly topRight: string;
  readonly bottomLeft: string;
  readonly bottomRight: string;
  readonly horizontal: string;
  readonly vertical: string;
}

/** Box-drawing when colour is on, plain ASCII when it is off. ADR-0068 ties the two: a terminal told `NO_COLOR` is a
 *  terminal we should assume renders conservatively, and a mis-rendered `╭` is worse than a `+`. */
const UNICODE: Glyphs = {
  topLeft: '╭',
  topRight: '╮',
  bottomLeft: '╰',
  bottomRight: '╯',
  horizontal: '─',
  vertical: '│',
};
const ASCII: Glyphs = {
  topLeft: '+',
  topRight: '+',
  bottomLeft: '+',
  bottomRight: '+',
  horizontal: '-',
  vertical: '|',
};

/** Pad `text` with spaces to exactly `width` DISPLAY columns, truncating if it does not fit. */
function fit(text: string, width: number): string {
  const w = displayWidth(text);
  if (w > width) return sliceDisplayColumns(text, 0, width);
  return text + ' '.repeat(width - w);
}

/**
 * Build the banner for a terminal `cols` wide.
 *
 * The plaque is as wide as its widest line needs, never wider than the terminal. When even the wordmark cannot fit,
 * the tagline is dropped first — the brand survives, the sentence does not. Below that, the caller should not have
 * asked: {@link shouldShowBanner} refuses under `HOME_MIN_COLS`.
 */
export function bannerLines(cols: number, ascii: boolean): readonly BannerLine[] {
  const g = ascii ? ASCII : UNICODE;
  // Two border glyphs + padding on each side.
  const chrome = 2 + PADDING * 2;
  const available = Math.max(cols - chrome, 1);

  const withTagline = displayWidth(TAGLINE) <= available;
  const inner = withTagline
    ? Math.max(displayWidth(WORDMARK), displayWidth(TAGLINE))
    : Math.min(displayWidth(WORDMARK), available);

  const pad = ' '.repeat(PADDING);
  const rule = g.horizontal.repeat(inner + PADDING * 2);
  const row = (text: string): string => `${g.vertical}${pad}${fit(text, inner)}${pad}${g.vertical}`;

  const lines: BannerLine[] = [
    { id: 'top', text: `${g.topLeft}${rule}${g.topRight}`, kind: 'border' },
    { id: 'wordmark', text: row(WORDMARK), kind: 'wordmark' },
  ];
  if (withTagline) lines.push({ id: 'tagline', text: row(TAGLINE), kind: 'tagline' });
  lines.push({ id: 'bottom', text: `${g.bottomLeft}${rule}${g.bottomRight}`, kind: 'border' });
  return lines;
}

export interface BannerVisibility {
  /** `[preferences].show_banner`. `true` ⇒ always, `false` ⇒ never, `undefined` ⇒ the rule below. */
  readonly configShowBanner: boolean | undefined;
  /** Whether the Home has nothing to continue — no sessions, no runs, no agents. */
  readonly isEmpty: boolean;
  /** The terminal's row count. */
  readonly rows: number;
}

/**
 * Should the Home draw the banner?
 *
 * `undefined` ⇒ **only while the Home is empty**. ADR-0068 asked for "the first five Home opens, then auto-dismissed",
 * which needs a durable counter. The two places to keep one are both wrong for a cosmetic element: a `history.db`
 * migration, or auto-writing the user's `config.toml` on startup — mutating a file they may hand-author and commit,
 * every time they open the Home. An empty Home IS the first-opens signal, costs nothing to read, and stops the instant
 * the user's first chat gives them something to continue. `show_banner = true` brings it back for good. Recorded as a
 * deliberate deviation in ADR-0068's Step-5g amendment.
 *
 * Two guards, both about not crowding a small terminal: never below `HOME_MIN_ROWS` (the Home is already in its
 * too-small mode there), and a FORCED banner also needs room for the strip it would otherwise push off the screen.
 */
export function shouldShowBanner(v: BannerVisibility): boolean {
  if (v.configShowBanner === false) return false;
  if (v.rows < HOME_MIN_ROWS) return false;
  if (v.configShowBanner === true) return v.rows >= HOME_MIN_ROWS + BANNER_EXTRA_ROWS;
  return v.isEmpty;
}
