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

import type { SheetRole, SheetSpan } from './sheet-frame.js';

/**
 * One key and the thing it does: `{ keys: '↑/↓', verb: 'select' }` reads `↑/↓ select`. A key that CHANGES something is written in brackets
 * (`[d / Del]`), a key that only moves or leaves is not, and `role` says how a view draws the key (an action in danger, a confirmation in
 * attention; absent ⇒ emphasised).
 */
export interface LegendItem {
  readonly keys: string;
  readonly verb: string;
  readonly role?: Exclude<SheetRole, 'dim' | 'ok'>;
}

/** The separator between two items: one space, a middle dot, one space. */
export const LEGEND_SEPARATOR = ' · ';

/** The legend text for these items, in the order given: the caller puts the leaving key last. */
export function legend(items: readonly LegendItem[]): string {
  return items.map((item) => `${item.keys} ${item.verb}`).join(LEGEND_SEPARATOR);
}

/**
 * Where the keys, the verbs and the separators are in {@link legend}'s text, so a view can draw the keys apart from the words: each key in
 * its role (emphasised by default), each verb and each separator dimmed. The spans index `legend(items)` exactly.
 */
export function legendSpans(items: readonly LegendItem[]): readonly SheetSpan[] {
  const spans: SheetSpan[] = [];
  let at = 0;
  items.forEach((item, index) => {
    if (index > 0) {
      spans.push({ from: at, to: at + LEGEND_SEPARATOR.length, role: 'dim' });
      at += LEGEND_SEPARATOR.length;
    }
    spans.push({ from: at, to: at + item.keys.length, role: item.role ?? 'strong' });
    at += item.keys.length;
    // the space between the keys and the verb, then the verb
    spans.push({ from: at, to: at + 1 + item.verb.length, role: 'dim' });
    at += 1 + item.verb.length;
  });
  return spans;
}
