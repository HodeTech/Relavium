import { Box } from 'ink';
import type { ReactElement } from 'react';

import { agentSheetLines } from './agent-sheet.js';
import type { ChatSheetState } from './chat-sheet.js';
import { withGlyphForm } from './glyphs.js';
import { PermissionsSheetView, SheetLinesView } from './permissions-sheet-view.js';

/**
 * The docked sheet a chat has open ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §1, §3): a PURE ink view that draws whichever kind the chat's one sheet slot holds, each through its own pure lines and the shared painter.
 * It owns no `useInput`: the host routes the keys.
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
      {state.kind === 'permissions' ? (
        <PermissionsSheetView state={state.sheet} color={color} columns={columns} rows={rows} />
      ) : (
        <SheetLinesView
          lines={withGlyphForm(!color, () =>
            agentSheetLines(state.view, { columns, terminalRows: rows }),
          )}
          color={color}
        />
      )}
    </Box>
  );
}
