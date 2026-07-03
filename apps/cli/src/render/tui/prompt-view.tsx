import { Box, Text } from 'ink';
import type { ReactElement } from 'react';

import type { EditorState } from './chat-input.js';
import { sanitizeInline } from './chat-projection.js';
import { promptRows } from './prompt-cursor.js';
import { colorProps } from './projection.js';

/**
 * The live multi-line prompt with the cursor drawn at its position (2.5.D step 2) — shared by `ChatView`
 * (`relavium chat`) and the Home `Prompt`, so both surfaces render the editor identically. Each row is a cyan
 * line: the first prefixed `> `, continuation lines aligned under it with two spaces. EVERY segment (before /
 * the cursor cell / after) passes {@link sanitizeInline} at this display boundary, so a pasted or typed control
 * sequence cannot corrupt the terminal or inject ANSI/OSC. The cursor cell is an inverse block (a terminal
 * attribute, gated on `color` like every other style); without color the underlying char is still rendered,
 * just not highlighted — matching the prior trailing-block behavior.
 */
export function PromptEditor(
  props: Readonly<{ editor: EditorState; color: boolean }>,
): ReactElement {
  const { editor, color } = props;
  const rows = promptRows(editor.text, editor.cursor);
  return (
    <Box flexDirection="column">
      {rows.map((row, index) => {
        // sanitizeInline may blank a control char under the cursor → fall back to a space so the block stays visible.
        const cursorCell = row.at === undefined ? '' : sanitizeInline(row.at) || ' ';
        return (
          <Text key={index} {...colorProps(color, 'cyan')}>
            {index === 0 ? '> ' : '  '}
            {sanitizeInline(row.before)}
            {row.at !== undefined && (color ? <Text inverse>{cursorCell}</Text> : cursorCell)}
            {sanitizeInline(row.after)}
          </Text>
        );
      })}
    </Box>
  );
}
