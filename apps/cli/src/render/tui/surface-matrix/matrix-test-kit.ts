import { describeFrame, problemsOf } from './run-cell.js';
import { runCell } from './cells.js';
import type { Surface } from './surface-types.js';
import { cellsOf, variantName, type Variant } from './variants.js';

/** The `it.each` table of one surface: a title and the cell. */
export function cellTable(entry: Surface): readonly { name: string; variant: Variant }[] {
  return cellsOf(entry.variants).map((variant) => ({ name: variantName(variant), variant }));
}

/**
 * Mount one cell and say what is wrong with it: the problems (no violation a known failure does not cover, no known failure that holds
 * again) and the frame, so a failing cell shows the screen it failed on.
 */
export async function checkCell(
  entry: Surface,
  variant: Variant,
): Promise<{ problems: string[]; frame: string }> {
  const result = await runCell(entry, variant);
  return { problems: problemsOf(entry, result), frame: describeFrame(result) };
}
