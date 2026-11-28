import { Box } from 'ink';
import type { ReactElement } from 'react';

import type { EditorState } from './chat-input.js';
import { glyphOf } from './glyphs.js';
import { foldKeyLookalikes } from './home-attention.js';
import { homeRailWidth, thinRule } from './home-layout.js';
import { homeContentColumns } from './home-notice.js';
import { DOCKED_PLACEHOLDER, MENTION_HINT } from './home-pages.js';
import { workRowText } from './home-projection.js';
import { mentionListLines, MentionView } from './mention-view.js';
import type { MentionState } from './mention.js';
import { dimProps } from './projection.js';
import { PromptEditor } from './prompt-view.js';
import { Text } from './text.js';

/**
 * The `@` file picker on the Home's two prompts (ADR-0061, the maintainer's question of 2026-11-26: `@` at the Home's prompt did nothing). The
 * picker is the chat's own (`MentionView` over `foldMentionKey`'s state); this module only places it on the Home's pages, the palette's way:
 *
 * - **On the landing** it opens BELOW the prompt row, which stays where it was (page 1 does not move): the prompt with the draft and its cursor,
 *   the thin rule, the picker's `@ dir/` header and its list, the blank rows that keep the hint on the frame's last row in the alternate screen,
 *   and the hint row, which says the picker's keys ({@link MENTION_HINT}).
 * - **On the work page** it runs UP from the docked prompt, as the palette does there: a blank row, the header and the list, then the prompt,
 *   the rule and the hint row.
 *
 * Every stored name it draws (a file, a directory) goes through the Home's full row scrub ({@link homeMentionText}), as every name the Home draws
 * beside its keys does. Only names are drawn: no file is read until a row is chosen, and a chosen file's content is never drawn, only its marker.
 */

/** A stored name (a file, a directory) as the Home's picker draws it: the row scrub, the marker lookalikes blanked, the key lookalikes folded. */
export function homeMentionText(stored: string): string {
  return foldKeyLookalikes(workRowText(stored));
}

/** `rows` blank rows (a Box of that height: an empty Text would take none). */
function Blank(props: Readonly<{ rows: number }>): ReactElement | null {
  return props.rows > 0 ? <Box height={props.rows} /> : null;
}

/** The rows the landing's picker block takes under its prompt row: the rule, the header, the list for `state` in `listRows` and the hint. */
export function landingMentionRows(state: MentionState, listRows: number): number {
  return 3 + mentionListLines(state, listRows);
}

export interface LandingMentionProps {
  readonly mention: MentionState;
  readonly editor: EditorState;
  /** The prompt's window (`landingEditorRows`), as at rest: the prompt row does not move when the picker opens. */
  readonly editorRows: number;
  /** The rows of the picker's list window. */
  readonly listRows: number;
  /** Blank rows between the list and the hint (the alternate screen keeps the hint on the frame's last row; none inline). */
  readonly fillRows: number;
  readonly cols: number;
  readonly color: boolean;
}

/** The picker's block on the landing: the prompt (the draft, its cursor), the rule, the picker, the fill and the hint. */
export function LandingMention(props: Readonly<LandingMentionProps>): ReactElement {
  const { cols, color } = props;
  return (
    <Box flexDirection="column" flexShrink={0}>
      <PromptEditor
        editor={props.editor}
        color={color}
        glyph={glyphOf('yourTurn', !color)}
        cursor={props.editor.cursor >= 0}
        maxRows={props.editorRows}
        columns={homeContentColumns(cols)}
      />
      <Text {...dimProps(color)} wrap="truncate-end">
        {thinRule(homeRailWidth(cols), !color)}
      </Text>
      <MentionView
        state={props.mention}
        color={color}
        windowRows={props.listRows}
        text={homeMentionText}
        framed={false}
        columns={homeContentColumns(cols)}
      />
      <Blank rows={props.fillRows} />
      <Text {...dimProps(color)} wrap="truncate-end">
        {MENTION_HINT}
      </Text>
    </Box>
  );
}

/** The rows the work page's picker block takes with its prompt: a blank row, the header and the list, the prompt's rows, the rule and the hint. */
export function dockedMentionRows(
  state: MentionState,
  listRows: number,
  promptRows: number,
): number {
  return 4 + mentionListLines(state, listRows) + promptRows;
}

export interface DockedMentionProps {
  readonly mention: MentionState;
  readonly editor: EditorState;
  /** The docked prompt's window (`workEditorRows`). */
  readonly editorRows: number;
  readonly listRows: number;
  readonly cols: number;
  readonly color: boolean;
}

/** The picker's block on the work page, running up from the docked prompt: a blank row, the picker, the prompt, the rule and the hint. */
export function DockedMention(props: Readonly<DockedMentionProps>): ReactElement {
  const { cols, color } = props;
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box height={1} />
      <MentionView
        state={props.mention}
        color={color}
        windowRows={props.listRows}
        text={homeMentionText}
        framed={false}
        columns={homeContentColumns(cols)}
      />
      <PromptEditor
        editor={props.editor}
        color={color}
        glyph={glyphOf('yourTurn', !color)}
        placeholder={DOCKED_PLACEHOLDER}
        cursor={props.editor.cursor >= 0}
        maxRows={props.editorRows}
        columns={homeContentColumns(cols)}
      />
      <Text {...dimProps(color)} wrap="truncate-end">
        {thinRule(homeRailWidth(cols), !color)}
      </Text>
      <Text {...dimProps(color)} wrap="truncate-end">
        {MENTION_HINT}
      </Text>
    </Box>
  );
}
