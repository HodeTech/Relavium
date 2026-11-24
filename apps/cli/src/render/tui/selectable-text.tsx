import type { ReactElement, ReactNode } from 'react';

import { Emph } from './emphasis-view.js';
import { SELECTED_ROW } from './emphasis.js';
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
 * The dimmed words of a selected row: inverse with the row but not bold (a dimmed stretch and bold contradict, and both close with `ESC[22m`).
 * Not selected ⇒ the children as they are.
 */
export function SelectableNote(
  props: Readonly<{ selected: boolean | undefined; children?: ReactNode }>,
): ReactElement {
  return <Emph kinds={props.selected === true ? 'inverse' : undefined}>{props.children}</Emph>;
}
