/**
 * The variants every surface is mounted in ([ADR-0145](../../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §10,
 * MVP-11 §5.6): the renderer (alternate screen or inline) × colour (on, or off as under `NO_COLOR`) × two sizes, plus one extra size below
 * the floor of the product (80×24, [ADR-0122](../../../../../../docs/decisions/0122-the-home-is-the-interactive-product.md) §7).
 */

export type Renderer = 'alt' | 'inline';

export interface Size {
  readonly cols: number;
  readonly rows: number;
}

export interface Variant {
  readonly renderer: Renderer;
  readonly color: boolean;
  readonly size: Size;
}

/** The two sizes every surface must fit: the minimum the product promises, and a roomier terminal. */
export const SIZES: readonly Size[] = [
  { cols: 80, rows: 24 },
  { cols: 100, rows: 30 },
];

/** Below the floor: the expected output is the "enlarge the terminal" notice (or the surface's own below-floor text), never a broken frame. */
export const BELOW_FLOOR: Size = { cols: 60, rows: 20 };

const RENDERERS: readonly Renderer[] = ['alt', 'inline'];
const COLOURS: readonly boolean[] = [true, false];

/** The eight cells at or above the floor: the cross product of the three axes. */
export const FLOOR_VARIANTS: readonly Variant[] = RENDERERS.flatMap((renderer) =>
  COLOURS.flatMap((color) => SIZES.map((size): Variant => ({ renderer, color, size }))),
);

/**
 * The ONE extra cell per surface that is below the floor: full-screen (its viewport is bounded to the terminal, so it is the renderer that
 * can overflow a small one) and without colour (the plainest). The inline renderer's live region only grows with its content, which the
 * cells above already bound.
 */
export const BELOW_FLOOR_VARIANT: Variant = { renderer: 'alt', color: false, size: BELOW_FLOOR };

export const isBelowFloor = (variant: Variant): boolean =>
  variant.size.cols === BELOW_FLOOR.cols && variant.size.rows === BELOW_FLOOR.rows;

/** A stable, readable name of a cell for the test title (`alt · colour · 80×24`). */
export function variantName(variant: Variant): string {
  const { cols, rows } = variant.size;
  return `${variant.renderer === 'alt' ? 'alt-screen' : 'inline'} · ${
    variant.color ? 'colour' : 'no colour'
  } · ${String(cols)}×${String(rows)}`;
}

/** Every cell a surface is mounted in: the eight at or above the floor and the one below it, narrowed by the entry's own `variants`. */
export function cellsOf(only: ((variant: Variant) => boolean) | undefined): readonly Variant[] {
  return [...FLOOR_VARIANTS, BELOW_FLOOR_VARIANT].filter((variant) => only?.(variant) ?? true);
}
