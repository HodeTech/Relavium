import type { ReactElement, ReactNode } from 'react';

import { Emph } from './emphasis-view.js';
import { SELECTED_ROW, type Emphasis } from './emphasis.js';
import type { StatusColor } from './format.js';
import { glyphOf } from './glyphs.js';
import { colorProps } from './projection.js';

/**
 * The one place a list row's "selected" look is decided: bold and inverse with colour on and off alike (ADR-0145 §5, `emphasis.ts`), and
 * the one selection marker. A view that draws a row of a list says `selected` and passes the words; the ternaries that turn it into a style
 * and a marker live here, so the views stay readable (and under the complexity bar) and no row can forget half of the rule.
 *
 * `selected` is a plain flag (`undefined` reads as `false`), so a row model with an optional `selected` field passes it straight.
 */

/** A selected row that carries a tint, with colour on: bold alone (its tint and its marker do the rest; {@link tintedSelectionEmphasis}). */
const TINTED_SELECTED_ROW: readonly Emphasis[] = ['bold'];

/** The marker column of a list row: the selection glyph (`›`, `>` without colour) when selected, one space otherwise. */
export function selectionMarker(selected: boolean | undefined, color: boolean): string {
  return selected === true ? glyphOf('selection', !color) : ' ';
}

/** The colour of a selected row's text (cyan, with colour on); not selected ⇒ no colour of its own. Spreadable into ink's `<Text>`. */
export function selectedTone(
  selected: boolean | undefined,
  color: boolean,
): { readonly color?: StatusColor } {
  return selected === true ? colorProps(color, 'cyan') : {};
}

/** `children` drawn as the selected row of a list: bold and inverse. Not selected ⇒ the children as they are. */
export function SelectableText(
  props: Readonly<{ selected: boolean | undefined; children?: ReactNode }>,
): ReactElement {
  return <Emph kinds={props.selected === true ? SELECTED_ROW : undefined}>{props.children}</Emph>;
}

/**
 * The selected look of a row that carries a colour TINT (MVP-11 unit 7, the maintainer's ruling of 2026-11-26: the work page's Attention rows,
 * amber, or red when overdue or failed): the `›` marker the caller draws ({@link selectionMarker}), bold, and the row's own tint, and NO
 * inverse, so the selected row softens instead of turning into a block of the warning colour.
 *
 * The rule, in full: a row that carries a tint is selected by `›` + bold + the tint; every other row of a list (a session, a run, a palette
 * entry) keeps bold + inverse (ADR-0145 §5). **Without colour no row carries a tint**, so a tinted row falls back to the plain rule there:
 * bold + inverse with the `>` marker, which keeps ADR-0145 §5's ASCII distinction (the selection is `>` with inverse, your turn is `>` with
 * bold) and the surface matrix's check of it. Either way the row is never told apart by colour alone: the marker, the bold, the glyph and the
 * words carry it, and with colour off the inverse too. The caller draws the tint around it (`<Text color>`); this decides only the emphasis.
 */
export function tintedSelectionEmphasis(
  selected: boolean | undefined,
  color: boolean,
): readonly Emphasis[] | undefined {
  if (selected !== true) return undefined;
  return color ? TINTED_SELECTED_ROW : SELECTED_ROW;
}

/** The selected row of a tinted list: bold (and inverse only without colour), by {@link tintedSelectionEmphasis}. Not selected ⇒ as it is. */
export function TintedSelectableText(
  props: Readonly<{ selected: boolean | undefined; color: boolean; children?: ReactNode }>,
): ReactElement {
  return <Emph kinds={tintedSelectionEmphasis(props.selected, props.color)}>{props.children}</Emph>;
}

/**
 * The dimmed words of a selected row: inverse with the row but not bold (a dimmed stretch and bold contradict, and both close with `ESC[22m`).
 * Not selected ⇒ the children as they are.
 */
export function SelectableNote(
  props: Readonly<{ selected: boolean | undefined; children?: ReactNode }>,
): ReactElement {
  return <Emph kinds={props.selected === true ? 'inverse' : undefined}>{props.children}</Emph>;
}
