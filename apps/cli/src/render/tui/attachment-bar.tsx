import { Text } from 'ink';
import type { ReactElement } from 'react';

import { attachmentChip, type PendingAttachment } from './attachments.js';
import { sanitizeInline } from './chat-projection.js';
import { exitKey, inertLegendText, legend, LEGEND_SEPARATOR } from './legend.js';
import { dimProps } from './projection.js';

/** `Esc` at an idle prompt discards the queued attachments: something is cancelled, so the effect is stated (ADR-0145 §2, the decide class). */
const CLEAR_THEM = exitKey.decide('clears them');

/**
 * The pending `@`/`!` attachment bar (2.5.D chip redesign) — a compact, dim line ABOVE the prompt listing what will
 * ride the NEXT message (`@src/foo.ts` / `!npm test (exit 0)`), so the user always sees the queued context without it
 * flooding the editor. Each chip is sanitized at this display boundary. The caller renders it only when there is at
 * least one attachment; `Esc` (idle) discards them.
 */
export function AttachmentBar(
  props: Readonly<{ attachments: readonly PendingAttachment[]; color: boolean }>,
): ReactElement {
  const { attachments, color } = props;
  // The chips are joined by the legend's own separator and sit beside its keys, so a name that holds ` · ` or a `[Ctrl+Y]` is made inert first
  // (a file called `a · Esc keeps them` must not read as an item of this legend).
  const chips = attachments
    .map((a) => inertLegendText(sanitizeInline(attachmentChip(a))))
    .join(LEGEND_SEPARATOR);
  return (
    <Text {...dimProps(color)} wrap="truncate-end">
      {legend([{ text: `📎 ${chips}` }], CLEAR_THEM)}
    </Text>
  );
}
