import { Text } from 'ink';
import type { ReactElement } from 'react';

import { attachmentChip, type PendingAttachment } from './attachments.js';
import { sanitizeInline } from './chat-projection.js';
import { dimProps } from './projection.js';

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
  const chips = attachments.map((a) => sanitizeInline(attachmentChip(a))).join(' · ');
  return (
    <Text {...dimProps(color)} wrap="truncate-end">
      {`📎 ${chips}  ·  Esc to clear`}
    </Text>
  );
}
