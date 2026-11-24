import { Box, Text } from 'ink';
import type { ReactElement } from 'react';

import { withGlyphForm } from './glyphs.js';
import { colorProps, dimProps } from './projection.js';
import {
  permissionsSheetLines,
  type PermissionsSheetState,
  type SheetLine,
  type SheetLineKind,
  type SheetRole,
} from './permissions-sheet.js';

/**
 * The `/permissions` sheet ([ADR-0137](../../../../../docs/decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md) §2)
 * — a PURE ink view over {@link permissionsSheetLines}. It owns no `useInput`: the host routes keys to `foldPermissionsSheetKey` and
 * re-renders this from the resulting state, as it does for the model picker. Every state the colour shows also has a word or a glyph (the
 * `›` marker, the `[d]` and `Enter` chips, the `✓`/`✗` of an answer, the `▲`/`▼` markers), so the sheet reads the same with colour
 * off (ADR-0122 §7.2).
 */
export interface PermissionsSheetViewProps {
  readonly state: PermissionsSheetState;
  readonly color: boolean;
  readonly columns: number;
  readonly rows: number;
}

type StyleProps =
  | ReturnType<typeof colorProps>
  | ReturnType<typeof dimProps>
  | { readonly bold: true; readonly color?: 'red' | 'green' | 'yellow' | 'cyan' };

/** How a whole line of this kind is drawn; a span over part of it replaces this for its stretch. */
function styleFor(kind: SheetLineKind, color: boolean): StyleProps {
  switch (kind) {
    case 'selected':
      return colorProps(color, 'cyan');
    case 'armed':
    case 'notice':
      return colorProps(color, 'yellow');
    case 'question':
      return { bold: true, ...colorProps(color, 'yellow') };
    case 'done':
      return colorProps(color, 'green');
    case 'failed':
      return colorProps(color, 'red');
    case 'heading':
      return { bold: true };
    case 'text':
    case 'note':
    case 'marker':
      return dimProps(color);
    case 'rule':
    case 'hint':
    case 'row':
    case 'message':
    case 'legend':
      return {};
  }
}

/** How a stretch of a line is drawn: a key in its role (bold, and in colour where there is colour), a value or a verb dimmed. */
function roleStyle(role: SheetRole, color: boolean): StyleProps {
  switch (role) {
    case 'dim':
      return dimProps(color);
    case 'strong':
      return { bold: true };
    case 'danger':
      return { bold: true, ...colorProps(color, 'red') };
    case 'ok':
      return { bold: true, ...colorProps(color, 'green') };
    case 'warn':
      return { bold: true, ...colorProps(color, 'yellow') };
  }
}

interface Segment {
  readonly text: string;
  readonly role: SheetRole | undefined;
}

/** The line cut at its spans' edges: each stretch with the role it takes, or none. Spans are taken in order; one that overlaps the last is dropped. */
function segments(line: SheetLine): readonly Segment[] {
  const spans = [...(line.spans ?? [])].sort((a, b) => a.from - b.from);
  const out: Segment[] = [];
  let at = 0;
  for (const span of spans) {
    const from = Math.max(span.from, at);
    const to = Math.min(span.to, line.text.length);
    if (to <= from) continue;
    if (from > at) out.push({ text: line.text.slice(at, from), role: undefined });
    out.push({ text: line.text.slice(from, to), role: span.role });
    at = to;
  }
  if (at < line.text.length) out.push({ text: line.text.slice(at), role: undefined });
  return out;
}

function lineKey(line: SheetLine, index: number): string {
  return `${String(index)}:${line.kind}`;
}

/**
 * Lines drawn as the sheet draws them: each in the style of its kind, each span in its role, no line wrapped. The one painter of a
 * {@link SheetLine} list, so a screen that composes the sheet's body in a frame of its own (the Home's tab host, ADR-0140 §3) paints
 * the very same rows the chat's docked sheet does.
 */
export function SheetLinesView(
  props: Readonly<{ lines: readonly SheetLine[]; color: boolean }>,
): ReactElement {
  return (
    <Box flexDirection="column">
      {props.lines.map((line, index) => (
        <Text key={lineKey(line, index)} {...styleFor(line.kind, props.color)} wrap="truncate-end">
          {line.text.length === 0
            ? ' '
            : segments(line).map((segment, at) =>
                segment.role === undefined ? (
                  segment.text
                ) : (
                  // A span styles its stretch on top of the line's own style: a dimmed value on a cyan row, a red key on a yellow one. A
                  // line that has a key in it (the hint, the legend, the rule) is not itself dimmed, so the key is not dimmed with it.
                  <Text
                    key={`${String(at)}:${segment.role}`}
                    {...roleStyle(segment.role, props.color)}
                  >
                    {segment.text}
                  </Text>
                ),
              )}
        </Text>
      ))}
    </Box>
  );
}

export function PermissionsSheetView(props: Readonly<PermissionsSheetViewProps>): ReactElement {
  const lines = withGlyphForm(!props.color, () =>
    permissionsSheetLines(props.state, {
      columns: props.columns,
      terminalRows: props.rows,
    }),
  );
  return <SheetLinesView lines={lines} color={props.color} />;
}
