import { useStdout } from 'ink';
import { Text } from './text.js';
import type { ReactElement } from 'react';

import { attachmentChip, type PendingAttachment } from './attachments.js';
import { sanitizeInline } from './chat-projection.js';
import {
  exitKey,
  fitLegend,
  inertLegendText,
  legend,
  LEGEND_SEPARATOR,
  type LegendItem,
} from './legend.js';
import { dimProps } from './projection.js';
import { displayWidth } from './viewport.js';

/** `Esc` at an idle prompt discards the queued attachments: something is cancelled, so the effect is stated (ADR-0145 §2, the decide class). */
const CLEAR_THEM = exitKey.decide('clears them');

/** The width a bar is fitted to when neither the caller nor the terminal says (the floor every surface is built for). */
const DEFAULT_COLUMNS = 80;

/**
 * What the bar says when its chips do not fit the row: how many are queued. A count is all a person needs to know that `Esc` throws them away,
 * and it never grows with a long path or a long command line.
 */
function countOf(attachments: readonly PendingAttachment[]): string {
  const count = attachments.length;
  return `📎 ${String(count)} attachment${count === 1 ? '' : 's'}`;
}

/**
 * The legend of the bar for a row `columns` wide: the chips, then the key that clears them. The chips are the optional item of the
 * one fit-to-width rule ({@link fitLegend}): where they do not fit, the bar says how many there are instead, and where even that does not fit
 * it is the key alone. The key that leaves is never the thing that is cut (a row cut at its end lost `Esc clears them` first).
 */
export function attachmentLegend(
  attachments: readonly PendingAttachment[],
  columns: number,
): string {
  // The chips are joined by the legend's own separator and sit beside its keys, so a name that holds ` · ` or a `[Ctrl+Y]` is made inert first
  // (a file called `a · Esc keeps them` must not read as an item of this legend).
  const chips = attachments
    .map((a) => inertLegendText(sanitizeInline(attachmentChip(a))))
    .join(LEGEND_SEPARATOR);
  const fit = (text: string): readonly LegendItem[] =>
    fitLegend([], [{ item: { text }, priority: 1 }], CLEAR_THEM, columns, displayWidth);
  const whole = fit(`📎 ${chips}`);
  return legend(whole.length > 0 ? whole : fit(countOf(attachments)), CLEAR_THEM);
}

/**
 * The pending `@`/`!` attachment bar (2.5.D chip redesign) — a compact, dim line ABOVE the prompt listing what will
 * ride the NEXT message (`@src/foo.ts` / `!npm test (exit 0)`), so the user always sees the queued context without it
 * flooding the editor. Each chip is sanitized at this display boundary. The caller renders it only when there is at
 * least one attachment; `Esc` (idle) discards them. `columns` is the room of the row (the terminal's, when the caller does not say).
 */
export function AttachmentBar(
  props: Readonly<{
    attachments: readonly PendingAttachment[];
    color: boolean;
    columns?: number | undefined;
  }>,
): ReactElement {
  const { attachments, color } = props;
  const { stdout } = useStdout();
  const columns = props.columns ?? stdout.columns ?? DEFAULT_COLUMNS;
  return (
    <Text {...dimProps(color)} wrap="truncate-end">
      {attachmentLegend(attachments, columns)}
    </Text>
  );
}
