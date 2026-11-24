import { Box, Text } from 'ink';
import type { ReactElement } from 'react';

import type { EditorState } from './chat-input.js';
import { sanitizeInline } from './chat-projection.js';
import { promptRows, type PromptRow } from './prompt-cursor.js';
import { emphasize } from './emphasis.js';
import { colorProps } from './projection.js';

/**
 * The live multi-line prompt with the cursor drawn at its position (2.5.D step 2) — shared by `ChatView`
 * (`relavium chat`) and the Home `Prompt`, so both surfaces render the editor identically. Each row is a cyan
 * line: the first prefixed `> `, continuation lines aligned under it with two spaces. EVERY segment (before /
 * the cursor cell / after) passes {@link sanitizeInline} at this display boundary, so a pasted or typed control
 * sequence cannot corrupt the terminal or inject ANSI/OSC. The cursor cell is an inverse block, drawn WHETHER OR NOT
 * colour is on: "no colour" means colour only (ADR-0145 §5, MVP-11 OD-6), and bold, inverse and underline stay.
 *
 * The cell is the SGR pair written out (`ESC[7m` … `ESC[27m`) by the one emphasis rule (`emphasis.ts`) in both modes: ink renders
 * `inverse` through chalk, whose level is 0 under `--no-color`, `FORCE_COLOR=0` and `TERM=dumb`, so there `<Text inverse>` prints nothing
 * and the prompt had no cursor at all (observed, MVP-11 step 1 evidence §A; the first fix covered only the `NO_COLOR` variable). The pair
 * is zero-width to ink's width measurement and wrapping, which read SGR as part of no cell, so a row does not wrap earlier for it.
 *
 * The rows INTENTIONALLY reflow (ink's default `wrap`), unlike the Home strip's read-only `truncate-end` rows:
 * this is a LIVE editor, so the full input + the cursor must always stay visible (a `truncate-end` prompt would
 * hide the cursor once a line runs past the terminal edge, and would defeat the multi-line buffer entirely). A
 * long/many-line prompt therefore grows downward — it is the bottom element, so the strip above is unaffected.
 */
export function PromptEditor(
  props: Readonly<{ editor: EditorState; color: boolean }>,
): ReactElement {
  const { editor, color } = props;
  const rows = promptRows(editor.text, editor.cursor);
  // Key each row by its line START char offset — a stable, positional id (identical lines never collide, unlike a
  // content key) that is NOT the array index React discourages for keys. The first row (offset 0) gets the `> `.
  const keyed: { readonly row: PromptRow; readonly offset: number }[] = [];
  let offset = 0;
  for (const row of rows) {
    keyed.push({ row, offset });
    offset += row.before.length + (row.at?.length ?? 0) + row.after.length + 1; // +1 for the joining '\n'
  }
  return (
    <Box flexDirection="column">
      {keyed.map(({ row, offset: rowOffset }) => {
        // sanitizeInline may blank a control char under the cursor → fall back to a space so the block stays visible.
        const cursorCell = row.at === undefined ? '' : sanitizeInline(row.at) || ' ';
        return (
          <Text key={rowOffset} {...colorProps(color, 'cyan')}>
            {rowOffset === 0 ? '> ' : '  '}
            {sanitizeInline(row.before)}
            {row.at !== undefined && emphasize(cursorCell, 'inverse')}
            {sanitizeInline(row.after)}
          </Text>
        );
      })}
    </Box>
  );
}
