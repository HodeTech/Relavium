import { Box, Text } from 'ink';
import type { ReactElement } from 'react';

import { colorProps, dimProps } from './projection.js';
import {
  permissionsSheetLines,
  type PermissionsSheetState,
  type SheetLine,
  type SheetLineKind,
} from './permissions-sheet.js';

/**
 * The `/permissions` sheet ([ADR-0137](../../../../../docs/decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md) §2)
 * — a PURE ink view over {@link permissionsSheetLines}. It owns no `useInput`: the host routes keys to `foldPermissionsSheetKey` and
 * re-renders this from the resulting state, as it does for the model picker. Every state the colour shows also has a word or a glyph (the
 * `›` marker, the headings, the `▲`/`▼` markers), so the sheet reads the same with colour off (ADR-0122 §7.2).
 */
export interface PermissionsSheetViewProps {
  readonly state: PermissionsSheetState;
  readonly color: boolean;
  readonly columns: number;
  readonly rows: number;
}

type StyleProps = ReturnType<typeof colorProps> | ReturnType<typeof dimProps> | { bold: true };

function styleFor(kind: SheetLineKind, color: boolean): StyleProps {
  switch (kind) {
    case 'title':
    case 'selected':
      return colorProps(color, 'cyan');
    case 'question':
      return colorProps(color, 'yellow');
    case 'heading':
      return { bold: true };
    case 'text':
    case 'note':
    case 'marker':
    case 'legend':
      return dimProps(color);
    case 'row':
    case 'message':
      return {};
  }
}

function lineKey(line: SheetLine, index: number): string {
  return `${String(index)}:${line.kind}`;
}

export function PermissionsSheetView(props: Readonly<PermissionsSheetViewProps>): ReactElement {
  const lines = permissionsSheetLines(props.state, {
    columns: props.columns,
    terminalRows: props.rows,
  });
  return (
    <Box flexDirection="column" marginTop={1}>
      {lines.map((line, index) => (
        <Text key={lineKey(line, index)} {...styleFor(line.kind, props.color)} wrap="truncate-end">
          {line.text.length === 0 ? ' ' : line.text}
        </Text>
      ))}
    </Box>
  );
}
