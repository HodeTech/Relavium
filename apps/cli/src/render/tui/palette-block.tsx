import { Box } from 'ink';
import type { ReactElement, ReactNode } from 'react';

import type { EditorState } from './chat-input.js';
import { glyphOf } from './glyphs.js';
import { thinRule } from './home-layout.js';
import type { PaletteList, PaletteState } from './palette-reducer.js';
import { paletteLegend, PaletteView } from './palette-view.js';
import { dimProps } from './projection.js';
import { PromptEditor } from './prompt-view.js';
import { Text } from './text.js';

/**
 * What the palette's query reads as on the prompt's own row: the slash and what was typed, the cursor at the end of it. The one definition the
 * chat, the work page and the landing draw the query by: the person is typing on that row, so it is the prompt's and not a line of the list.
 */
export function paletteQueryEditor(query: string): EditorState {
  const text = `/${query}`;
  return { text, cursor: text.length };
}

/** The open palette a block draws: its list (the rows the key fold reads) and its state (the query and the highlighted row). */
export interface PaletteBlockPalette {
  readonly list: PaletteList;
  readonly state: PaletteState;
}

/**
 * The palette's block ABOVE the prompt, as a chat draws it and the work page's docked prompt does (ADR-0146 §4, ADR-0145 §7.1): `before`
 * (the in-flight turn, in a chat), the list with the first entry beside the prompt, the prompt row with the typed query, the thin rule `ruleColumns`
 * wide, and the palette's legend on the hint row. The list ends on the row above the prompt, so it has no query line, no legend line and no blank
 * row of its own (the `up` layout of {@link PaletteView}). `maxRows` is the budget of the whole block (the list's rows, the prompt, the rule and
 * the hint row).
 */
export function PaletteAbovePrompt(
  props: Readonly<{
    palette: PaletteBlockPalette;
    maxRows: number;
    ruleColumns: number;
    color: boolean;
    before?: ReactNode;
  }>,
): ReactElement {
  const { palette, color } = props;
  return (
    <Box flexDirection="column" flexShrink={0}>
      {props.before}
      <PaletteView
        list={palette.list}
        state={palette.state}
        color={color}
        maxRows={props.maxRows}
      />
      <PromptEditor
        editor={paletteQueryEditor(palette.state.query)}
        color={color}
        glyph={glyphOf('yourTurn', !color)}
      />
      <Text {...dimProps(color)} wrap="truncate-end">
        {thinRule(props.ruleColumns, !color)}
      </Text>
      <Text {...dimProps(color)} wrap="truncate-end">
        {paletteLegend(palette.list)}
      </Text>
    </Box>
  );
}
