import { Box } from 'ink';
import type { ReactElement, ReactNode } from 'react';

import { marginCell, type ChatGrid, type MarginForm, type MarginRole } from './chat-grid.js';
import type { EmphasisSet } from './emphasis.js';
import { Emph } from './emphasis-view.js';
import { Text, type TextProps } from './text.js';

/**
 * One row of the chat's grid that has a margin: the margin cell on the left (the host's mark, drawn from the closed {@link MarginRole} set by
 * {@link marginCell}, which takes no text) and the content column on the right, exactly {@link ChatGrid.content} wide, where every word a person
 * or a model wrote goes ([MVP-11 §4.8](../../../../../docs/roadmap/phases/mvp-11.md#48-the-chat), [ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md)
 * §6, unit 9). The chat's live region draws a tool call's row through it: the `▸` is in the margin and the call's words are in the content, so a
 * tool id or a target a model named can never stand where the mark does.
 *
 * `children` is the content cell: it is laid out inside the content column and cannot reach the margin, however long its text or whatever it
 * starts with. A content that wraps hangs under its own first row (the margin of the later rows is blank). With no margin on the grid (a terminal
 * too narrow to give one) the row is the content cell alone.
 */
export function MarginRow(
  props: Readonly<{
    /** What the margin says, from the closed set; `undefined` is a blank margin (a row the host marks nothing on). */
    role: MarginRole | undefined;
    grid: ChatGrid;
    /** The margin's form: see {@link marginFormFor}. */
    form: MarginForm;
    /** The props of the margin cell's `Text` (its colour): the mark is the host's, so it is drawn by the row, not by what the content says. */
    mark?: Partial<TextProps> | undefined;
    /** The mark's emphasis (the person's own turn is bold), drawn by the one rule for bold (`emphasis-view.tsx`). Absent ⇒ none. */
    markEmphasis?: EmphasisSet | undefined;
    children?: ReactNode;
  }>,
): ReactElement {
  const { grid } = props;
  return (
    <Box flexDirection="row" flexShrink={0}>
      {grid.margin > 0 && (
        <Box width={grid.margin} flexShrink={0}>
          <Text {...props.mark}>
            <Emph kinds={props.markEmphasis}>{marginCell(props.role, grid, props.form)}</Emph>
          </Text>
        </Box>
      )}
      <Box width={grid.content} flexShrink={0} flexDirection="column">
        {props.children}
      </Box>
    </Box>
  );
}

/**
 * The form of the margin a renderer draws: the full-screen renderer draws the table's glyph (its plain ASCII form without colour, ADR-0145 §5), the
 * inline renderer the role word (`tool`, `you`, `agent`, `note`: a screen reader hears the word where it would skip a glyph, and the words read the
 * same under `LC_ALL=C`).
 */
export function marginFormFor(alternateScreen: boolean, color: boolean): MarginForm {
  if (!alternateScreen) return 'word';
  return color ? 'glyph' : 'ascii';
}
