import { Text } from 'ink';
import type { ComponentProps, ReactElement, ReactNode } from 'react';

import { emphasisClose, emphasisKinds, emphasisOpen, type EmphasisSet } from './emphasis.js';

/**
 * The ink side of the one rule for bold, inverse and underline (see `emphasis.ts` for the rule and for why the SGR pair is written into the
 * text and not asked of ink). A view never passes `bold`, `inverse` or `underline` to ink's `<Text>`: it draws a stretch with {@link Emph}
 * or a row with {@link EmphText}, and a source-text guard (`emphasis-guard.test.ts`) fails for a raw prop outside the two exceptions it names.
 *
 * Apply it to text that has already been sanitised, laid out and clipped: it writes zero-width sequences around whatever it is given.
 */

/** Nothing to draw: an empty string, or a value React renders as nothing. */
const isEmpty = (node: ReactNode): boolean =>
  node === undefined || node === null || typeof node === 'boolean' || node === '';

/**
 * `children` drawn in `kinds`: the opening sequence, the children (text, or nested `<Text>`), the closing one. No kinds, or nothing to
 * draw (an empty filter, say) ⇒ the children alone, so no pair is written for nothing.
 */
export function Emph(
  props: Readonly<{ kinds: EmphasisSet | undefined; children?: ReactNode }>,
): ReactElement {
  const kinds = emphasisKinds(props.kinds);
  if (kinds.length === 0 || isEmpty(props.children)) return <>{props.children}</>;
  return (
    <>
      {emphasisOpen(kinds)}
      {props.children}
      {emphasisClose(kinds)}
    </>
  );
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
