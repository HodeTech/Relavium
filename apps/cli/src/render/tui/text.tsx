import { Text as InkText } from 'ink';
import {
  createContext,
  useContext,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react';

/**
 * The CLI's one `Text` and the one context behind the dimmed backdrop ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §4). While a popup is open in the alternate screen the body stays drawn under it, and every cell of that body is drawn dim. The renderer
 * has no body-level dim, so the dimming is a **leaf-level route**: this module is the ONLY non-test, non-harness file that imports `Text` from
 * `ink` (`text-import-guard.test.ts` pins that), every view imports `Text` from here, and a host that opens a popup wraps its body, not the
 * popup's slot, in {@link BackdropDim}.
 *
 * **Applied at paint time, to the element and to nothing else.** The context is read where the `Text` element is drawn and becomes ONE prop
 * of ink's `Text` (`dimColor`). Nothing here, and no view, builds a dimmed string in advance: a wrap cache, a projection or a markdown layout
 * is the same bytes with the popup open and closed, so dimming can neither enter a cache key nor survive the popup's close.
 *
 * **Why a dimmed backdrop draws no bold.** SGR 22 closes bold AND dim, and that is not the whole trap: ink composes its frame cell by cell and
 * writes it back with `@alcalzone/ansi-tokenize`, whose diff of two neighbouring cells goes from "bold and dim" to "dim" by closing bold
 * (`ESC[22m`, which also closes dim) and NOT opening dim again. So the first dim-only cell after a bold-and-dim one is drawn plain, whatever
 * the string said (a re-opening `ESC[2m` in the text does not help: the cells are re-encoded from their styles). Two defences cannot be
 * built at the string level, so the state itself is avoided: under the dim, `Text` draws no `bold` and {@link Emph}'s pair
 * drops its bold (`emphasis-view.tsx`); inverse, underline, italic and colour do not share a close code with dim and stay. The dimmed backdrop
 * keeps its words, its markers, its inverse rows and its colours, and loses only the weight of its bold.
 *
 * **Colour off.** chalk's level is 0 under `NO_COLOR`, `--no-color`, `FORCE_COLOR=0` and `TERM=dumb`, and there `dimColor` prints nothing. The
 * hosts therefore ask for the dim only with colour on, and with colour off the backdrop is simply not dimmed (the popup is opaque and framed
 * anyway); nothing writes a dim sequence by hand.
 */

const BackdropDimContext = createContext(false);

/**
 * Draws everything under it as the backdrop of an open popup when `dimmed`. It renders its children and no host node, so the layout is the
 * same with and without it. Its value is a boolean, so a subscriber of a host that re-renders for a popup's own state change re-renders
 * nothing here: the descendants re-render only when the boolean does, when a popup opens or closes.
 */
export function BackdropDim(
  props: Readonly<{ dimmed: boolean; children?: ReactNode }>,
): ReactElement {
  return (
    <BackdropDimContext.Provider value={props.dimmed}>{props.children}</BackdropDimContext.Provider>
  );
}

/** Whether the text being drawn is part of the backdrop of an open popup. */
export function useBackdropDim(): boolean {
  return useContext(BackdropDimContext);
}

/** Exactly ink's `Text` props: derived, not restated, so a prop ink adds is a prop of this one. */
export type TextProps = ComponentProps<typeof InkText>;

/**
 * Ink's `Text`, made context-aware: outside a dimmed backdrop it is ink's `Text` with the same props and so the same bytes; inside one it
 * is drawn dim (OR-ed with the dim it asked for) and without bold (see the module's note on why).
 */
export function Text(props: Readonly<TextProps>): ReactElement | null {
  const dimmed = useBackdropDim();
  if (!dimmed) return <InkText {...props} />;
  return <InkText {...props} dimColor bold={false} />;
}
