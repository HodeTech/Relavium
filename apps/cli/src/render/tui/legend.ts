/**
 * The one builder of a key legend ([ADR-0137](../../../../../docs/decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md) §5):
 * the dim, ` · `-separated line under a screen that says which keys do what. The grammar is the common-language draft's navigation
 * legend: `Ctrl+X` with a plus, a lower-case verb with no full stop, the key that leaves the screen last.
 *
 * Framework-free and pure. A screen builds its legend from the same constants its key handler matches, so a hint cannot say a key
 * does something the handler does not: see `SHEET_KEYS` in `permissions-sheet.ts` and the test that presses every one of them.
 * Only the new permissions sheet is built on it today; the older overlays keep their own footers until the common-language
 * increment moves them (ADR-0137 §5).
 */

/** One key and the thing it does: `{ keys: '↑/↓', verb: 'select' }` reads `↑/↓ select`. */
export interface LegendItem {
  readonly keys: string;
  readonly verb: string;
}

/** The separator between two items: one space, a middle dot, one space. */
export const LEGEND_SEPARATOR = ' · ';

/** The legend text for these items, in the order given: the caller puts the leaving key last. */
export function legend(items: readonly LegendItem[]): string {
  return items.map((item) => `${item.keys} ${item.verb}`).join(LEGEND_SEPARATOR);
}
