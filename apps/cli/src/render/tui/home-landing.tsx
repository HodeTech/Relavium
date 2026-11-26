import { Box } from 'ink';
import { useMemo, type ReactElement, type ReactNode } from 'react';

import type { HomeStatusFacts } from '../../home/home-status-facts.js';
import type { EditorState } from './chat-input.js';
import { EmphText } from './emphasis-view.js';
import { glyphOf } from './glyphs.js';
import {
  exampleText,
  homeMargin,
  homeRailWidth,
  landingGapRows,
  railRows,
  thinRule,
  WORDMARK,
  type RailPlacement,
} from './home-layout.js';
import { homeContentColumns } from './home-notice.js';
import type { HintRow } from './home-pages.js';
import { paletteQueryEditor, type PaletteBlockPalette } from './palette-block.js';
import { paletteLegend, PaletteView } from './palette-view.js';
import { colorProps, dimProps } from './projection.js';
import { PromptEditor } from './prompt-view.js';
import { statusLine } from './status-line.js';
import { Text } from './text.js';

/**
 * The Home's LANDING ([ADR-0146](../../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md)
 * §1, §2, §5, [MVP-11 §4.7](../../../../../docs/roadmap/phases/mvp-11.md#47-the-home)): the calm landing, page 1 of the Home in every state, all of
 * its drawing in one place so that the page that leads to the rest of the Home can reuse it as its first. Left-hung at {@link homeMargin} (6 columns
 * at 80, 8 from 100), top to bottom:
 *
 * - **the head**: the block (the wordmark in the accent and bold, a blank row, the rail with its three nodes, the three labels, the three dim notes),
 *   or the one-line title (the spaced wordmark) when the block is not shown ({@link HomeLandingProps.showBlock});
 * - a notice when there is one, in the blank rows above the prompt (OB76: a short notice moves nothing);
 * - **the prompt block**: the prompt (the `›` in the accent and the dim example inside the row, never sent, with the cursor on its first letter; a
 *   long draft is a window of its rows around the cursor with a `▲/▼ N more` marker, OB71), the thin rule the rail's width, the one status line
 *   (or, with no provider key, the call to connect, in the accent), the hosted run's row when a leg is executing, a blank row and the hint.
 *   While the exit guard or the palette owns the bottom of the view the prompt block is not drawn and its place is the children's: the palette's
 *   block ({@link LandingPalette}) opens BELOW the prompt row, which stays where it was, so page 1 never moves.
 *
 * Vertical: in the alternate screen the block sits above the middle ({@link HomeLandingProps.topGap}, from `landingTopGap`: 3 rows at 24, 6 at 30),
 * inline there is no gap, and the whole landing is never taller than `rows − 1`. Every width is the real columns less the margin, so a row that is exactly as wide as its
 * room does not wrap, and a hostile status value is cut by the status line's own model, never by the terminal.
 *
 * Pure: it holds no state and reads nothing but its props. Everything it draws that is not a product constant arrives already safe (the hint
 * and the notice are built and sanitised by the Home; the facts are scrubbed, bounded and fitted by {@link statusLine}).
 */

/** What the status row says: the facts of the next chat, the call to connect a provider (no key), or nothing (a Home that was told no facts). */
export type LandingStatus =
  | { readonly kind: 'facts'; readonly facts: HomeStatusFacts }
  | { readonly kind: 'keyless'; readonly line: string }
  | { readonly kind: 'none' };

/** A notice's rows as `layoutHomeNotice` laid them out: its lines and, when it pages, the footer that says where. */
export interface LandingNotice {
  readonly lines: readonly string[];
  readonly footer: string | undefined;
}

interface HomeLandingProps {
  readonly cols: number;
  readonly color: boolean;
  /**
   * The blank rows above the head: `landingTopGap`'s answer (the alternate screen's, 3 at 24 rows and 6 at 30; none inline, where a blank row would
   * be pushed into the terminal's scrollback). The caller computes it so that what it sizes with it (the palette's rows) cannot differ from what is drawn.
   */
  readonly topGap: number;
  /** The block (wordmark, rail, labels, notes) or the one-line title: `showsLandingBlock`'s answer. */
  readonly showBlock: boolean;
  readonly editor: EditorState;
  readonly status: LandingStatus;
  /** The most rows the prompt's editor may take (`landingEditorRows`): a longer draft is drawn as a window of its rows (OB71). */
  readonly editorRows: number;
  /** The hint row (or the notification that replaces it for its few seconds), with the part drawn in the warning role when there is one. */
  readonly hint: HintRow;
  /** The hosted run's one row, or none: the only live activity the landing shows, between the status line and the hint (the study's frame 21). */
  readonly runRow?: string | undefined;
  readonly notice?: LandingNotice | undefined;
  /** Whether the prompt block is drawn: not while the exit guard or the palette owns its place. */
  readonly promptShown: boolean;
  /** What follows the head where the prompt block would be: the exit-guard card, or the palette's block ({@link LandingPalette}). */
  readonly children?: ReactNode;
}

/** `rows` blank rows (a Box of that height: an empty Text would take none). */
function Blank(props: Readonly<{ rows: number }>): ReactElement | null {
  return props.rows > 0 ? <Box height={props.rows} /> : null;
}

/** The node row: the current step in the accent, the line and the pending nodes dim. */
function NodeRow(props: Readonly<{ node: string; color: boolean }>): ReactElement {
  const [first = '', ...rest] = Array.from(props.node);
  return (
    <Text wrap="truncate-end">
      <Text {...colorProps(props.color, 'cyan')}>{first}</Text>
      <Text {...dimProps(props.color)}>{rest.join('')}</Text>
    </Text>
  );
}

/** The labels row: the label where the user starts strong (bold, whatever the colour), the others dim, each at its own column. */
function LabelsRow(
  props: Readonly<{ placements: readonly RailPlacement[]; color: boolean }>,
): ReactElement {
  let at = 0;
  const pieces = props.placements.map((place) => {
    const lead = ' '.repeat(Math.max(0, place.labelStart - at));
    at = Math.max(at, place.labelStart) + place.label.length;
    return (
      <Text key={place.label}>
        {lead}
        {place.strong ? (
          <EmphText emphasis="bold">{place.label}</EmphText>
        ) : (
          <Text {...dimProps(props.color)}>{place.label}</Text>
        )}
      </Text>
    );
  });
  return <Text wrap="truncate-end">{pieces}</Text>;
}

/** The block: the wordmark, a blank row, the rail's nodes, its labels and its notes (five rows: `LANDING_BLOCK_HEAD_ROWS`). */
function LandingBlock(props: Readonly<{ cols: number; color: boolean }>): ReactElement {
  const rail = railRows(homeRailWidth(props.cols), !props.color);
  return (
    <Box flexDirection="column">
      <EmphText {...colorProps(props.color, 'cyan')} emphasis="bold" wrap="truncate-end">
        {WORDMARK}
      </EmphText>
      <Blank rows={1} />
      <NodeRow node={rail.node} color={props.color} />
      <LabelsRow placements={rail.placements} color={props.color} />
      <Text {...dimProps(props.color)} wrap="truncate-end">
        {rail.notes}
      </Text>
    </Box>
  );
}

/** The one-line title the Home draws when the block is not shown (the spaced wordmark: the same form of the name as the chat's header). */
function LandingTitle(props: Readonly<{ color: boolean }>): ReactElement {
  return (
    <EmphText {...colorProps(props.color, 'cyan')} emphasis="bold" wrap="truncate-end">
      {WORDMARK}
    </EmphText>
  );
}

/** The status line of the Home for `columns`, fitted: built once per facts and width, not once per draw (the Home repaints on every key). */
function FactsRow(
  props: Readonly<{ facts: HomeStatusFacts; cols: number; color: boolean }>,
): ReactElement {
  const { facts, cols } = props;
  const text = useMemo(() => statusLine({ surface: 'home', ...facts }, cols).text, [facts, cols]);
  return (
    <Text {...colorProps(props.color, 'gray')} wrap="truncate-end">
      {text}
    </Text>
  );
}

/** The status row of either page: the facts of the next chat, the call to connect (in the accent), or a blank row. */
export function StatusRow(
  props: Readonly<{ status: LandingStatus; cols: number; color: boolean }>,
): ReactElement {
  const { status } = props;
  if (status.kind === 'facts')
    return <FactsRow facts={status.facts} cols={props.cols} color={props.color} />;
  if (status.kind === 'keyless')
    return (
      <Text {...colorProps(props.color, 'cyan')} wrap="truncate-end">
        {status.line}
      </Text>
    );
  return <Blank rows={1} />;
}

/**
 * A hint row of either page, dim, with the part the hint marks drawn in the warning colour (the landing's `↓ 1 needs you`): the text is one row,
 * cut at its end, and the marked part is a span of that very text, so the words are the same with colour and without it.
 */
export function HomeHintText(props: Readonly<{ hint: HintRow; color: boolean }>): ReactElement {
  const { hint, color } = props;
  const warn = hint.warn;
  if (warn === undefined || !color)
    return (
      <Text {...dimProps(color)} wrap="truncate-end">
        {hint.text}
      </Text>
    );
  return (
    <Text wrap="truncate-end">
      <Text {...dimProps(color)}>{hint.text.slice(0, warn.from)}</Text>
      <Text {...colorProps(color, 'yellow')}>{hint.text.slice(warn.from, warn.to)}</Text>
      <Text {...dimProps(color)}>{hint.text.slice(warn.to)}</Text>
    </Text>
  );
}

/**
 * The prompt block: the prompt with its example, the rule, the status row, the hosted run's row when a leg is executing, a blank row and the
 * hint (five rows at rest, `LANDING_FOOT_ROWS` of them under the prompt, one more with the run's row).
 */
function LandingPromptBlock(
  props: Readonly<{
    cols: number;
    color: boolean;
    editor: EditorState;
    editorRows: number;
    status: LandingStatus;
    hint: HintRow;
    runRow?: string | undefined;
  }>,
): ReactElement {
  const { cols, color, editor } = props;
  return (
    <Box flexDirection="column">
      <PromptEditor
        editor={editor}
        color={color}
        glyph={glyphOf('yourTurn', !color)}
        placeholder={exampleText(!color)}
        cursor={editor.cursor >= 0}
        maxRows={props.editorRows}
        columns={homeContentColumns(cols)}
      />
      <Text {...dimProps(color)} wrap="truncate-end">
        {thinRule(homeRailWidth(cols), !color)}
      </Text>
      <StatusRow status={props.status} cols={cols} color={color} />
      {props.runRow !== undefined && (
        <Text {...colorProps(color, 'cyan')} wrap="truncate-end">
          {props.runRow}
        </Text>
      )}
      <Blank rows={1} />
      <HomeHintText hint={props.hint} color={color} />
    </Box>
  );
}

/** The rows of the notice as either page draws them: its lines (one Text, so no keyed list) and its footer. */
export function NoticeRows(
  props: Readonly<{ notice: LandingNotice; color: boolean }>,
): ReactElement {
  return (
    <Box flexDirection="column">
      <Text {...dimProps(props.color)}>{props.notice.lines.join('\n')}</Text>
      {props.notice.footer !== undefined && (
        <Text {...dimProps(props.color)} wrap="truncate-end">
          {props.notice.footer}
        </Text>
      )}
    </Box>
  );
}

/**
 * The palette's block on the landing, BELOW the prompt row (OB72, the study's frame 11): the prompt row with the typed query where the prompt
 * was, the thin rule, the list (`bare`: its entries alone, the first one beside the prompt), and the legend. `maxRows` is the budget of the
 * whole block (the prompt row, the rule, the list and the legend row), `fillRows` the blank rows that keep the legend on the frame's last
 * row in the alternate screen (none inline, where nothing blank is pushed into the terminal's scrollback). Nothing above the prompt row
 * changes when the palette opens or closes.
 */
export function LandingPalette(
  props: Readonly<{
    palette: PaletteBlockPalette;
    cols: number;
    color: boolean;
    maxRows: number;
    fillRows: number;
  }>,
): ReactElement {
  const { palette, color } = props;
  return (
    <Box flexDirection="column" flexShrink={0}>
      <PromptEditor
        editor={paletteQueryEditor(palette.state.query)}
        color={color}
        glyph={glyphOf('yourTurn', !color)}
      />
      <Text {...dimProps(color)} wrap="truncate-end">
        {thinRule(homeRailWidth(props.cols), !color)}
      </Text>
      <PaletteView
        list={palette.list}
        state={palette.state}
        color={color}
        maxRows={props.maxRows}
        bare
      />
      <Blank rows={props.fillRows} />
      <Text {...dimProps(color)} wrap="truncate-end">
        {paletteLegend(palette.list)}
      </Text>
    </Box>
  );
}

export function HomeLanding(props: Readonly<HomeLandingProps>): ReactElement {
  const { cols, color, showBlock, notice } = props;
  // The rows between the head and the prompt: the block's two (the title's one), and a notice stands in them directly over the prompt with
  // a blank row above it, so a short notice moves nothing (`landingGapRows`). The hosted run's row is part of the prompt block.
  const noticeRows =
    notice === undefined ? 0 : notice.lines.length + (notice.footer === undefined ? 0 : 1);
  return (
    <Box flexDirection="column" marginTop={props.topGap} marginLeft={homeMargin(cols)}>
      {showBlock ? <LandingBlock cols={cols} color={color} /> : <LandingTitle color={color} />}
      <Blank rows={landingGapRows(showBlock, noticeRows) - noticeRows} />
      {notice !== undefined && <NoticeRows notice={notice} color={color} />}
      {props.promptShown && (
        <LandingPromptBlock
          cols={cols}
          color={color}
          editor={props.editor}
          editorRows={props.editorRows}
          status={props.status}
          hint={props.hint}
          runRow={props.runRow}
        />
      )}
      {props.children}
    </Box>
  );
}
