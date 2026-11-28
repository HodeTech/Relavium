import { Box } from 'ink';
import { Text } from './text.js';
import type { ReactElement } from 'react';

import { Emph } from './emphasis-view.js';
import {
  mergeEmphasis,
  SELECTED_ROW,
  withoutEmphasis,
  type Emphasis,
  type EmphasisSet,
} from './emphasis.js';
import type { StatusColor } from './format.js';
import { colorProps, dimProps } from './projection.js';
import type { SheetLine, SheetLineKind, SheetRole } from './sheet-frame.js';

/** What colour (and dim) a line or a stretch takes: nothing with colour off. Its weight is {@link kindEmphasis} and {@link roleEmphasis}, which colour does not switch. */
type StyleProps = { readonly color?: StatusColor; readonly dimColor?: true };

/** How a whole line of this kind is coloured; a span over part of it replaces this for its stretch. */
function styleFor(kind: SheetLineKind, color: boolean): StyleProps {
  switch (kind) {
    case 'selected':
      return colorProps(color, 'cyan');
    case 'armed':
    case 'notice':
      return colorProps(color, 'yellow');
    case 'question':
      return colorProps(color, 'yellow');
    case 'done':
      return colorProps(color, 'green');
    case 'failed':
      return colorProps(color, 'red');
    case 'text':
    case 'note':
    case 'marker':
      return dimProps(color);
    case 'heading':
    case 'rule':
    case 'hint':
    case 'row':
    case 'message':
    case 'legend':
      return {};
  }
}

/** The weight of a whole line of this kind, with colour on and off alike: the selected row is bold and inverse, a question and a heading are bold. */
function kindEmphasis(kind: SheetLineKind): EmphasisSet | undefined {
  switch (kind) {
    case 'selected':
      return SELECTED_ROW;
    case 'question':
    case 'heading':
      return 'bold';
    default:
      return undefined;
  }
}

/** How a stretch of a line is coloured: a key in its role (in colour where there is colour), a value or a verb dimmed. */
function roleStyle(role: SheetRole, color: boolean): StyleProps {
  switch (role) {
    case 'dim':
      return dimProps(color);
    case 'danger':
      return colorProps(color, 'red');
    case 'ok':
      return colorProps(color, 'green');
    case 'warn':
      return colorProps(color, 'yellow');
    case 'strong':
      return {};
  }
}

/** The weight of a stretch in its role: a key is bold with colour on and off alike; a dimmed stretch has none of its own. */
function roleEmphasis(role: SheetRole): EmphasisSet | undefined {
  return role === 'dim' ? undefined : 'bold';
}

interface Segment {
  readonly text: string;
  readonly role: SheetRole | undefined;
  /** The stretch is the selected item of its line (the current tab). */
  readonly selected: boolean;
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
    if (from > at) out.push({ text: line.text.slice(at, from), role: undefined, selected: false });
    out.push({
      text: line.text.slice(from, to),
      role: span.role,
      selected: span.selected === true,
    });
    at = to;
  }
  if (at < line.text.length)
    out.push({ text: line.text.slice(at), role: undefined, selected: false });
  return out;
}

/**
 * What a stretch is drawn as: the colour of its role over the colour of its line, and its weight, which is the line's and the role's
 * together. The stretches of a line are siblings, each in a style of its own, and never nested: a bold stretch inside a bold line would
 * close with `ESC[22m` and end the line's own bold for the rest of the row. The dimmed stretch of a selected row is inverse but not bold:
 * dim is not relied on (ADR-0145 §5) and the two weights contradict.
 */
function segmentLook(
  line: SheetLine,
  segment: Segment,
  color: boolean,
): { readonly props: StyleProps; readonly emphasis: readonly Emphasis[] } {
  const props: StyleProps = {
    ...styleFor(line.kind, color),
    ...(segment.role === undefined ? {} : roleStyle(segment.role, color)),
  };
  const own = kindEmphasis(line.kind);
  const emphasis =
    segment.role === undefined
      ? mergeEmphasis(own, segment.selected ? SELECTED_ROW : undefined)
      : segment.role === 'dim'
        ? withoutEmphasis(own, 'bold')
        : mergeEmphasis(
            own,
            roleEmphasis(segment.role),
            segment.selected ? SELECTED_ROW : undefined,
          );
  return { props, emphasis };
}

function lineKey(line: SheetLine, index: number): string {
  return `${String(index)}:${line.kind}`;
}

/**
 * The one painter of a {@link SheetLine} list: each line in the style of its kind, each span in its role, no line wrapped. Every popup frame
 * ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)) and the tab host's body (ADR-0140 §3) are
 * painted by it, so a row of one looks like a row of the other. It owns no `useInput` and no state: a pure view over lines a model built. Every
 * state the colour shows also has a word or a glyph (the `›` marker, the `[d]` and `Enter` chips, the `✓`/`✗` of an answer, the `▲`/`▼`
 * markers), so a screen reads the same with colour off (ADR-0122 §7.2). The selected row is bold and inverse with colour on and off alike
 * (ADR-0145 §5).
 */
export function SheetLinesView(
  props: Readonly<{ lines: readonly SheetLine[]; color: boolean }>,
): ReactElement {
  return (
    <Box flexDirection="column">
      {props.lines.map((line, index) => (
        <Text key={lineKey(line, index)} wrap="truncate-end">
          {line.text.length === 0
            ? ' '
            : segments(line).map((segment, at) => {
                const look = segmentLook(line, segment, props.color);
                // A line that has a key in it (the hint, the legend, the rule) is not itself dimmed, so the key is not dimmed with it.
                return (
                  <Text key={`${String(at)}:${segment.role ?? 'plain'}`} {...look.props}>
                    <Emph kinds={look.emphasis}>{segment.text}</Emph>
                  </Text>
                );
              })}
        </Text>
      ))}
    </Box>
  );
}
