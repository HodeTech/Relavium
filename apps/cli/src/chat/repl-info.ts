import type { CatalogEntry } from '../workflows/catalog.js';
import { sanitizeInline } from '../render/tui/chat-projection.js';
import { formatCostUsd } from '../render/tui/format.js';

/**
 * Pure formatters for the in-REPL info commands (2.5.C S4) — `/cost` and `/workflows`. The output is rendered as
 * a notice in the chat view ({@link ChatStoreController.notice}); keeping the formatting pure means it is
 * unit-tested with no FS, no session, and no ink, and every dynamic field (a workflow slug) is sanitized at the
 * boundary so a crafted catalog entry can never forge a notice row or inject an escape.
 */

/** The `/cost` notice — the session's cumulative spend (the per-model breakdown is Phase 2.6.C). */
export function costNotice(cumulativeCostMicrocents: number): string {
  return `Session cost: ${formatCostUsd(cumulativeCostMicrocents)}`;
}

/** The `/workflows` notice — the discovered workflow + agent catalogs (each slug sanitized), grouped by kind. */
export function catalogNotice(
  workflows: readonly CatalogEntry[],
  agents: readonly CatalogEntry[],
): string {
  return [catalogSection('Workflows', workflows), catalogSection('Agents', agents)].join('\n');
}

/** One `kind` section: a count header + one sanitized line per entry (invalid entries flagged, never dropped). */
function catalogSection(heading: string, entries: readonly CatalogEntry[]): string {
  if (entries.length === 0) return `${heading}: none`;
  const rows = entries.map((entry) => {
    const slug = sanitizeInline(entry.slug);
    return `  ${slug}${entry.valid ? '' : ' (invalid)'}`;
  });
  return `${heading} (${entries.length}):\n${rows.join('\n')}`;
}
