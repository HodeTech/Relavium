import { Box } from 'ink';
import type { ReactElement } from 'react';

import type { ChatSheetState } from './chat-sheet.js';
import { PermissionsSheetView } from './permissions-sheet-view.js';

/**
 * The docked sheet a chat has open ([ADR-0137](../../../../../docs/decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md)
 * §1): a PURE ink view that draws whichever kind the chat's one sheet slot holds, through its own pure lines and the shared painter. It owns no
 * `useInput`: the host routes the keys.
 */
export interface ChatSheetViewProps {
  readonly state: ChatSheetState;
  readonly color: boolean;
  readonly columns: number;
  readonly rows: number;
}

export function ChatSheetView(props: Readonly<ChatSheetViewProps>): ReactElement {
  const { state, color, columns, rows } = props;
  // The sheet keeps its own height: in the full-screen frame the viewport above it is the box that gives way (and clips), never the
  // sheet's rows, which Yoga would otherwise squeeze onto one another (two rows sharing a line, the legend overwritten).
  return (
    <Box flexDirection="column" flexShrink={0}>
      <PermissionsSheetView state={state.sheet} color={color} columns={columns} rows={rows} />
    </Box>
  );
}
