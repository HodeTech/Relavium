/**
 * The one rule for bold, inverse and underline ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §5,
 * MVP-11 OD-6): **"no colour" means colour only.** Bold, inverse and underline are not colour, so they are drawn with colour on and with
 * colour off, and `dim` is not relied on. Selection is one marker (`›`, ASCII `>`) AND an inverse row, because `>` alone could not tell a
 * selected row from the prompt; your own turn is the same marker in bold. This module is the one place that writes those three styles.
 *
 * **Why the pair is written out, in both modes.** Ink draws `<Text bold>`, `<Text inverse>` and `<Text underline>` through chalk, whose
 * level is resolved once from the environment: it is 0 under `NO_COLOR`, `--no-color`, `FORCE_COLOR=0` and `TERM=dumb`, and at level 0 chalk
 * strips bold and inverse too, so every such prop silently vanished with colour off and the selected row of a palette or a picker was told
 * apart by its marker alone. The CLI's own colour flag is not chalk's level (colour is on by default, whatever the terminal), so a rule that
 * asked Ink for the style when the flag is on would still lose it wherever chalk is at 0. Writing the SGR pair into the text is the only
 * mechanism that gives the same look in every mode: the bytes are the ones chalk would write (`ESC[1m`, `ESC[7m`, `ESC[4m` and their
 * closes `ESC[22m`, `ESC[27m`, `ESC[24m`), the pair is closed again (a stretch that wraps, or is cut by `wrap="truncate-end"`, is closed by
 * Ink's own ANSI-aware wrapper and cannot leak onto the next row), and no colour code is ever written. Nothing is gated, so there is no
 * second code path to drift: a view that wants a style asks this module and the colour flag does not come into it.
 *
 * **Widths.** An SGR sequence is zero columns to Ink and to `string-width` (both strip it). The CLI's own `displayWidth` is not: it
 * measures with `countAnsiEscapeCodes: true`, because the text it is given is already free of escapes. So a style is applied at the LAST
 * step, to a row that has already been laid out, measured and clipped, and never to a string that is measured afterwards.
 *
 * **Untrusted text.** The helpers do not sanitise: a string a user, a project, a model or a provider wrote must pass `sanitizeInline` (which
 * removes ESC) BEFORE it is handed here, as it must before it reaches the terminal at all, so that no text of theirs can carry an SGR of its
 * own into the frame or close the pair this module opened.
 *
 * Pure: no `ink`, no `react` (the `<Emph>` components are in `emphasis-view.tsx`).
 */

export type Emphasis = 'bold' | 'inverse' | 'underline';

/** One style, or several drawn together. */
export type EmphasisSet = Emphasis | readonly Emphasis[];

const ESC = '\u001b';

interface Pair {
  readonly open: string;
  readonly close: string;
}

const PAIRS: Readonly<Record<Emphasis, Pair>> = {
  bold: { open: `${ESC}[1m`, close: `${ESC}[22m` },
  inverse: { open: `${ESC}[7m`, close: `${ESC}[27m` },
  underline: { open: `${ESC}[4m`, close: `${ESC}[24m` },
};

/** The fixed order the styles are opened in (and closed in, reversed), so the same set is always the same bytes. */
const ORDER: readonly Emphasis[] = ['bold', 'inverse', 'underline'];

/** The selected row of a list: bold and inverse. */
export const SELECTED_ROW: readonly Emphasis[] = ['bold', 'inverse'];

/** The styles of `set`, each once, in the fixed order. */
export function emphasisKinds(set: EmphasisSet | undefined): readonly Emphasis[] {
  if (set === undefined) return [];
  const wanted: readonly Emphasis[] = typeof set === 'string' ? [set] : set;
  return ORDER.filter((kind) => wanted.includes(kind));
}

/** The styles of every set given, each once: a style a row has because of its kind plus the one a stretch of it has. */
export function mergeEmphasis(...sets: readonly (EmphasisSet | undefined)[]): readonly Emphasis[] {
  return emphasisKinds(sets.flatMap((set) => emphasisKinds(set)));
}

/** `set` without `kind`: the styles of a stretch that must not take one of them (the bold of a selected row is left off a dimmed stretch). */
export function withoutEmphasis(set: EmphasisSet | undefined, kind: Emphasis): readonly Emphasis[] {
  return emphasisKinds(set).filter((own) => own !== kind);
}

/** The sequence that turns `set` on; empty for an empty set. */
export function emphasisOpen(set: EmphasisSet | undefined): string {
  return emphasisKinds(set)
    .map((kind) => PAIRS[kind].open)
    .join('');
}

/** The sequence that turns `set` off again, in the reverse order it was turned on; empty for an empty set. */
export function emphasisClose(set: EmphasisSet | undefined): string {
  return [...emphasisKinds(set)]
    .reverse()
    .map((kind) => PAIRS[kind].close)
    .join('');
}

/**
 * `text` drawn in `set`: the opening sequence, the text, the closing one. An empty text or an empty set is returned as it is (an empty
 * pair would write bytes for nothing). Never writes a colour code.
 */
export function emphasize(text: string, set: EmphasisSet | undefined): string {
  if (text.length === 0) return text;
  const kinds = emphasisKinds(set);
  if (kinds.length === 0) return text;
  return `${emphasisOpen(kinds)}${text}${emphasisClose(kinds)}`;
}

/**
 * `set` as a description of a style: `{ bold: true }`, one entry per style. For a tone a test or the legend golden reads and names; it is
 * never spread into ink's `<Text>` (a view draws a style with `Emph` and `EmphText`, which write the pair).
 */
export function emphasisDescription(set: EmphasisSet | undefined): Record<string, true> {
  return Object.fromEntries(emphasisKinds(set).map((kind) => [kind, true as const]));
}
