/**
 * A key row a card draws, as text and as the stretches a view colours
 * ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §3).
 *
 * The cards of a consent path (the approval card, the question card, the checkpoint card) lay their keys out over TWO rows: the answers
 * on the first, and on the second the refusals with the key that leaves. {@link legend} always ends in the key that leaves, so the first
 * row of such a block cannot be built by it alone. These three constructors build a row from the same items and the same spans the
 * builder gives, so a row carries the builder's brackets, separator and roles whether or not it carries the exit:
 *
 * - {@link exitRow}: items and the key that leaves, by `legend` and `legendSpans`;
 * - {@link itemsRow}: items only (the grants row), by `legendItems`;
 * - {@link sentenceRow}: a sentence in the place of a legend (the question a wider grant asks, the lock that says Allow is off), dim.
 *
 * Framework-free and pure.
 */

import { legend, legendItems, legendSpans, type LegendExit, type LegendItem } from './legend.js';
import type { SheetRole, SheetSpan } from './sheet-frame.js';

/** A row's text and where its keys, verbs and separators are in it; the spans cover the text once, in order. */
export interface LegendRow {
  readonly text: string;
  readonly spans: readonly SheetSpan[];
}

/** The row of `items` and the key that leaves, exactly as {@link legend} and {@link legendSpans} write it. */
export function exitRow(items: readonly LegendItem[], exit: LegendExit): LegendRow {
  return { text: legend(items, exit), spans: legendSpans(items, exit) };
}

/** The row of `items` with no key that leaves: the text and spans {@link legendItems} gives (an empty list is an empty row). */
export function itemsRow(items: readonly LegendItem[]): LegendRow {
  return legendItems(items);
}

/** A sentence drawn where a legend would be: the whole of it dim, no keys. */
export function sentenceRow(text: string): LegendRow {
  return { text, spans: text.length === 0 ? [] : [{ from: 0, to: text.length, role: 'dim' }] };
}

/** The row cut at its spans' edges: each stretch of text with the role it is drawn in. A stretch no span covers is dim. */
export function rowSegments(
  row: LegendRow,
): readonly { readonly text: string; readonly role: SheetRole }[] {
  const out: { text: string; role: SheetRole }[] = [];
  let at = 0;
  for (const span of [...row.spans].sort((a, b) => a.from - b.from)) {
    const from = Math.max(span.from, at);
    const to = Math.min(span.to, row.text.length);
    if (to <= from) continue;
    if (from > at) out.push({ text: row.text.slice(at, from), role: 'dim' });
    out.push({ text: row.text.slice(from, to), role: span.role });
    at = to;
  }
  if (at < row.text.length) out.push({ text: row.text.slice(at), role: 'dim' });
  return out;
}
