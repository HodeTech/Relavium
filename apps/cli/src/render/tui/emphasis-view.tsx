import type { ComponentProps, ReactElement, ReactNode } from 'react';

import {
  emphasisClose,
  emphasisKinds,
  emphasisOpen,
  withoutEmphasis,
  type EmphasisSet,
} from './emphasis.js';
import { Text, useBackdropDim } from './text.js';

/**
 * The ink side of the one rule for bold, inverse and underline (see `emphasis.ts` for the rule and for why the SGR pair is written into the
 * text and not asked of ink). A view never passes `bold`, `inverse` or `underline` to ink's `<Text>`: it draws a stretch with {@link Emph}
 * or a row with {@link EmphText}, and a source-text guard (`emphasis-guard.test.ts`) fails for a raw prop outside the two exceptions it names.
 *
 * Apply it to text that has already been sanitised, laid out and clipped: it writes zero-width sequences around whatever it is given.
 *
 * **Under the dimmed backdrop of an open popup the pair draws no bold** ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §4, `text.tsx`): bold and dim share the close code `ESC[22m`, and the renderer's own re-encoding of a frame drops the dim after the first
 * bold-and-dim cell, so the one way to keep every cell dim is to never have a bold one. The decision is made here, where the element is drawn
 * (a React hook), never in a string built in advance, so the same text is the same bytes once the popup closes.
 */

/** Nothing to draw: an empty string, or a value React renders as nothing. */
const isEmpty = (node: ReactNode): boolean =>
  node === undefined || node === null || typeof node === 'boolean' || node === '';

/**
 * The element of `children` drawn in `kinds`: the opening sequence, the children (text, or nested `<Text>`), the closing one. No kinds, or
 * nothing to draw (an empty filter, say) ⇒ the children alone, so no pair is written for nothing. Pure: {@link Emph} is this plus the one
 * decision that depends on where the element is drawn.
 */
export function emphElement(kinds: EmphasisSet | undefined, children: ReactNode): ReactElement {
  const own = emphasisKinds(kinds);
  if (own.length === 0 || isEmpty(children)) return <>{children}</>;
  return (
    <>
      {emphasisOpen(own)}
      {children}
      {emphasisClose(own)}
    </>
  );
}

/** `children` drawn in `kinds` (see {@link emphElement}), without the bold when it is part of the dimmed backdrop of an open popup. */
export function Emph(
  props: Readonly<{ kinds: EmphasisSet | undefined; children?: ReactNode }>,
): ReactElement {
  const dimmed = useBackdropDim();
  return emphElement(dimmed ? withoutEmphasis(props.kinds, 'bold') : props.kinds, props.children);
}

/** Ink's `<Text>` props without the three it draws through chalk: a view asks for them by `emphasis`, so a raw one is a type error. */
export type EmphTextProps = Omit<ComponentProps<typeof Text>, 'bold' | 'inverse' | 'underline'> & {
  readonly emphasis?: EmphasisSet | undefined;
};

/** Ink's `<Text>` with its bold, inverse and underline drawn by the one rule. */
export function EmphText(props: Readonly<EmphTextProps>): ReactElement {
  const { emphasis, children, ...rest } = props;
  return (
    <Text {...rest}>
      <Emph kinds={emphasis}>{children}</Emph>
    </Text>
  );
}
