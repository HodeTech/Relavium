import { Box, type DOMElement } from 'ink';
import type { ReactElement, ReactNode, RefObject } from 'react';

import type { HomeSnapshot } from '../../home/home-store.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import type { EditorState } from './chat-input.js';
import { sanitizeInline } from '../sanitize.js';
import type { StatusColor } from './format.js';
import { glyph, glyphOf, withGlyphForm } from './glyphs.js';
import {
  attentionOrder,
  parkedRunLabel,
  type AttentionItem,
  type ParkedRunRow,
} from './home-attention.js';
import {
  HomeHintText,
  NoticeRows,
  StatusRow,
  type LandingNotice,
  type LandingStatus,
} from './home-landing.js';
import { frameRows, homeMargin, homeRailWidth, thinRule } from './home-layout.js';
import { DockedMention, dockedMentionRows } from './mention-home.js';
import type { MentionState } from './mention.js';
import {
  DOCKED_CHROME_ROWS,
  DOCKED_PLACEHOLDER,
  WAY_BACK_LINE,
  workEditorRows,
  workHeadRows,
  workListRows,
  type HintRow,
} from './home-pages.js';
import {
  agentLabel,
  exitGuardLines,
  failedRunLabel,
  rowId,
  runLabel,
  sessionLabel,
  splitRowId,
  unreadableRunLabel,
  EXIT_GUARD_RULE_ROWS,
  type ExitGuardPhase,
} from './home-projection.js';
import { allocateWorkList, type SectionWindow } from './home-work-budget.js';
import { homeContentColumns, homePromptRows } from './home-notice.js';
import type { OpenPalette } from './palette-reducer.js';
import { PaletteAbovePrompt } from './palette-block.js';
import { paletteLines } from './palette-window.js';
import { colorProps, dimProps } from './projection.js';
import { PromptEditor } from './prompt-view.js';
import { SelectableText, selectionMarker, TintedSelectableText } from './selectable-text.js';
import type { StripFocus } from './strip-focus.js';
import { Text } from './text.js';
import { HOSTED_RUN_EXIT_BOUND_MS } from './tui-constants.js';

/**
 * The Home's WORK PAGE (page 2, MVP-11 unit 7): what `↓` from the landing goes down to. Left-hung at the Home's margin and exactly `rows − 1` rows
 * tall, top to bottom:
 *
 * - the way back, dim (`↑ start page`), and a blank row (from 26 terminal rows: whitespace gives way before words, `workHeadRows`);
 * - the sections, all of them this directory's: "Attention required" (the parked runs, the failed runs of the window and the runs whose log
 *   cannot be read, in their urgency order, `attentionOrder`), then "Continue": Sessions, Runs and Agents, newest first. Each is windowed to the
 *   rows the page leaves it by the allocation (`home-work-budget.ts`: the caps, the priority, the `▲`/`▼ N more` markers whose N is the TRUE
 *   total), so the focused row is always one of the rows drawn and the rows shown and the markers always add up to the section's total;
 * - a notice, when there is one, with a blank row above it;
 * - the block at the bottom: the DOCKED PROMPT (a blank row, the prompt with its invitation, the thin rule, the status line, the hint), or, while
 *   the `/` palette is open, the palette above the prompt (its list, the prompt with the typed query, the rule, the palette's legend on the hint
 *   row), or the exit-guard card in the prompt block's place.
 *
 * Pure: it holds no state and reads nothing but its props. Every row is ONE line (no directory line under a session: every session here is this
 * directory's), built by the unit-tested labels (`home-projection.ts`, `home-attention.ts`), which scrub every stored field (`flowLine`) before
 * they cut the row at its width; the view cuts nothing itself and wraps nothing.
 */

/** Columns a row spends before its own words: the section's indent (2) and the marker column (`› `, 2). */
const ROW_INDENT_COLUMNS = 4;

/**
 * Where the rows a `▼` counts are when `↓` cannot reach them (they were not loaded): the runs in the Runs screen (its Active and History tabs),
 * which `/workflows` opens with `[h]` (there is no command of its own), the conversations in `/resume`, the agents in `/agents` (an agent row
 * is never focusable, so its marker always says where).
 */
const ELSEWHERE = {
  runs: '/workflows, then [h]',
  sessions: '/resume',
  agents: '/agents',
} as const;

/** One line of a section: a row (its durable key, its words, whether it is the focused row, its tint on an Attention row) or a marker. */
type SectionLine =
  | {
      readonly kind: 'row';
      readonly key: string;
      readonly text: string;
      readonly selected: boolean;
      /** An Attention row's colour (amber, red when overdue or failed): its selected look is the tinted one (`TintedSelectableText`). */
      readonly tint?: StatusColor;
      /** The first eight characters of the run's id the row ends with, drawn dim on a row at rest when the row still ends with it whole. */
      readonly id?: string;
    }
  | { readonly kind: 'more'; readonly key: string; readonly text: string };

/** What the sections are built from. */
interface SectionsInput {
  readonly snapshot: HomeSnapshot;
  readonly parked: readonly ParkedRunRow[];
  readonly focus: StripFocus | undefined;
  /** The rows the sections may take: the page's list region. */
  readonly budget: number;
  /** The columns a row may take: the terminal less the margin. */
  readonly columns: number;
  readonly nowMs: number;
  /** Colour on or off: the rows carry the glyph table's glyphs in the form it asks for (the plain forms without colour, ADR-0145 §5). */
  readonly color: boolean;
}

/**
 * The sections' lines for `budget` rows (the allocation's windows, the markers in them). Every line is built here, as text, by the plain function
 * {@link buildSections}: a line carries glyphs of the glyph table, whose form is the one in force while the view is BUILT (`withGlyphForm`), and
 * a component renders after that scope has closed.
 */
export interface SectionsModel {
  readonly attention: readonly SectionLine[];
  readonly sessions: readonly SectionLine[];
  readonly runs: readonly SectionLine[];
  readonly agents: readonly SectionLine[];
  /** Whether the blank row under Attention is drawn: the allocation keeps it only while it costs no row (`WorkAllocation.gap`). */
  readonly gap: boolean;
}

export function buildSections(input: SectionsInput): SectionsModel {
  return withGlyphForm(!input.color, () => sectionsIn(input));
}

/** A marker line: `▲ N more` above the window, `▼ N more` below it, and where the rest are when `↓` cannot reach them. */
function moreLine(side: 'above' | 'below', count: number, elsewhere?: string): SectionLine {
  const mark = glyph(side === 'above' ? 'moreAbove' : 'moreBelow');
  const where = elsewhere === undefined ? '' : ` · ${elsewhere}`;
  return { kind: 'more', key: `more-${side}`, text: `${mark} ${String(count)} more${where}` };
}

/** A section's lines: its `▲` marker, the rows of its window, and its `▼` marker (with `elsewhere` when its rows were not all loaded). */
function linesOf<T>(
  window: SectionWindow,
  items: readonly T[],
  line: (item: T) => SectionLine,
  elsewhere: { readonly where: string; readonly always?: boolean },
): readonly SectionLine[] {
  const lines: SectionLine[] = [];
  if (window.above > 0) lines.push(moreLine('above', window.above));
  for (const item of items.slice(window.start, window.start + window.count)) lines.push(line(item));
  if (window.below > 0) {
    const named = elsewhere.always === true || !window.belowLoaded;
    lines.push(moreLine('below', window.below, named ? elsewhere.where : undefined));
  }
  return lines;
}

/** An Attention row: its label at `room` columns and its tint (a parked run amber, red once overdue; a failed run red; an unreadable run amber). */
function attentionLine(
  item: AttentionItem,
  selected: boolean,
  room: number,
  nowMs: number,
): SectionLine {
  const key = `${item.kind}:${item.runId}`;
  const id = rowId(item.runId);
  switch (item.kind) {
    case 'parked':
      return {
        kind: 'row',
        key,
        id,
        selected,
        text: parkedRunLabel(item.row, room, nowMs),
        tint: item.overdue ? 'red' : 'yellow',
      };
    case 'failed':
      return {
        kind: 'row',
        key,
        id,
        selected,
        text: failedRunLabel(item.run, nowMs, room),
        tint: 'red',
      };
    case 'unreadable':
      return {
        kind: 'row',
        key,
        id,
        selected,
        text: unreadableRunLabel(item.run, room),
        tint: 'yellow',
      };
  }
}

function sectionsIn(input: SectionsInput): SectionsModel {
  const { snapshot, parked, focus, nowMs } = input;
  const runFocused = (runId: string): boolean => focus?.kind === 'run' && focus.id === runId;
  const sessionFocused = (id: string): boolean => focus?.kind === 'session' && focus.id === id;
  const attention = attentionOrder(parked, snapshot, nowMs);
  // A run is listed once: a run that is an Attention item is not also a run of the Runs section.
  const listed = new Set(attention.map((item) => item.runId));
  const runs = snapshot.recentRuns.filter((run) => !listed.has(run.runId));
  const sessions = snapshot.recentSessions;
  const at = (index: number): number | undefined => (index >= 0 ? index : undefined);
  const windows = allocateWorkList({
    rows: input.budget,
    attention: {
      loaded: attention.length,
      total: snapshot.totals.attention,
      focus: at(attention.findIndex((item) => runFocused(item.runId))),
    },
    sessions: {
      loaded: sessions.length,
      total: snapshot.totals.sessions,
      focus: at(sessions.findIndex((session) => sessionFocused(session.sessionId))),
    },
    runs: {
      loaded: runs.length,
      total: snapshot.totals.runs,
      focus: at(runs.findIndex((run) => runFocused(run.runId))),
    },
    agents: { loaded: snapshot.recentAgents.length, total: snapshot.recentAgents.length },
  });
  const room = Math.max(1, input.columns - ROW_INDENT_COLUMNS);
  return {
    gap: windows.gap,
    attention: linesOf(
      windows.attention,
      attention,
      (item) => attentionLine(item, runFocused(item.runId), room, nowMs),
      { where: ELSEWHERE.runs },
    ),
    sessions: linesOf(
      windows.sessions,
      sessions,
      (session) => ({
        kind: 'row',
        key: session.sessionId,
        text: sessionLabel(session, nowMs, room),
        selected: sessionFocused(session.sessionId),
      }),
      { where: ELSEWHERE.sessions },
    ),
    runs: linesOf(
      windows.runs,
      runs,
      (run) => ({
        kind: 'row',
        key: run.runId,
        id: rowId(run.runId),
        text: runLabel(run, nowMs, room),
        selected: runFocused(run.runId),
      }),
      { where: ELSEWHERE.runs },
    ),
    agents: linesOf(
      windows.agents,
      snapshot.recentAgents,
      (agent) => ({
        kind: 'row',
        key: agent.agentSlug,
        text: agentLabel(agent, nowMs, room),
        selected: false,
      }),
      { where: ELSEWHERE.agents, always: true },
    ),
  };
}

/**
 * One line of a section. A marker is dim, in the rows' column. A row has the marker column (`›` when it is the focused row) and its words: an
 * Attention row in its tint, focused `›` + bold + the tint and no inverse (the tinted rule, `TintedSelectableText`); a plain row (a session, a
 * run, an agent) focused bold + inverse (ADR-0145 §5, `SelectableText`). The words are the labels' (scrubbed); the inline pass here is the
 * emphasis module's precondition (no text of theirs carries an SGR into the pair it opens).
 */
function SectionLineView(props: Readonly<{ line: SectionLine; color: boolean }>): ReactElement {
  const { line, color } = props;
  if (line.kind === 'more')
    return (
      <Text {...dimProps(color)} wrap="truncate-end">
        {'  '}
        {line.text}
      </Text>
    );
  // The id a run's row ends with is dim on a row at rest (the way back and the titles are dim too; without colour nothing is, `dimProps`), drawn
  // apart from the words before it. Only a row that still ends with the WHOLE id has one, and a SELECTED row is drawn whole in its selected look
  // (bold, with its inverse or its tint): a dimmed stretch inside bold would contradict it, since both close with `ESC[22m`.
  const split = splitRowId(sanitizeInline(line.text), line.selected ? undefined : line.id);
  const words = (
    <>
      {`${selectionMarker(line.selected, color)} `}
      {split.lead}
    </>
  );
  const tail = split.id === undefined ? null : <Text {...dimProps(color)}>{split.id}</Text>;
  if (line.tint === undefined)
    return (
      <Text wrap="truncate-end">
        <SelectableText selected={line.selected}>{words}</SelectableText>
        {tail}
      </Text>
    );
  return (
    <Text {...colorProps(color, line.tint)} wrap="truncate-end">
      <TintedSelectableText selected={line.selected} color={color}>
        {words}
      </TintedSelectableText>
      {tail}
    </Text>
  );
}

/** The lines of a section, one under the other (the section's own box gives them its indent). */
function SectionLines(
  props: Readonly<{ lines: readonly SectionLine[]; color: boolean }>,
): ReactElement {
  return (
    <Box flexDirection="column">
      {props.lines.map((line) => (
        <SectionLineView key={line.key} line={line} color={props.color} />
      ))}
    </Box>
  );
}

/** A titled section of "Continue" (Sessions, Runs, Agents): its dim title and its lines; nothing when it has none. */
function Section(
  props: Readonly<{ title: string; lines: readonly SectionLine[]; color: boolean }>,
): ReactElement | null {
  if (props.lines.length === 0) return null;
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text {...dimProps(props.color)} wrap="truncate-end">
        {props.title}
      </Text>
      <SectionLines lines={props.lines} color={props.color} />
    </Box>
  );
}

/**
 * The work page's list in a region of exactly `budget` rows, drawn as the allocation counted it (`workListChrome`): "Attention required" and its
 * lines; then, when a Continue section has lines, a blank row (only under Attention, and only when the allocation kept it: `model.gap`), the dim
 * "Continue", and each section's title and lines.
 */
function WorkSections(
  props: Readonly<{ model: SectionsModel; budget: number; color: boolean }>,
): ReactElement {
  const { color, model } = props;
  const hasAttention = model.attention.length > 0;
  const hasContinue = model.sessions.length + model.runs.length + model.agents.length > 0;
  return (
    <Box flexDirection="column" height={Math.max(0, props.budget)} overflow="hidden" flexShrink={0}>
      {hasAttention && (
        <>
          <Text {...colorProps(color, 'yellow')} wrap="truncate-end">
            Attention required
          </Text>
          <Box marginLeft={2} flexDirection="column">
            <SectionLines lines={model.attention} color={color} />
          </Box>
          {hasContinue && model.gap && <Box height={1} />}
        </>
      )}
      {hasContinue && (
        <>
          <Text {...dimProps(color)} wrap="truncate-end">
            Continue
          </Text>
          <Section title="Sessions" lines={model.sessions} color={color} />
          <Section title="Runs" lines={model.runs} color={color} />
          <Section title="Agents" lines={model.agents} color={color} />
        </>
      )}
    </Box>
  );
}

/** The bottom block of the work page, and how many rows it takes (the list region is what the rest of the page leaves). */
export type BottomBlock =
  | { readonly kind: 'docked'; readonly rows: number }
  | {
      readonly kind: 'palette';
      readonly rows: number;
      readonly palette: OpenPalette;
      readonly maxRows: number;
    }
  | { readonly kind: 'guard'; readonly rows: number; readonly phase: ExitGuardPhase }
  | {
      readonly kind: 'mention';
      readonly rows: number;
      readonly mention: MentionState;
      readonly listRows: number;
    };

/** The rows an open palette's block takes with its prompt row, its rule and its legend row (never more than its budget). */
function paletteBlockRows(palette: OpenPalette, maxRows: number, color: boolean): number {
  const rows = palette.list.rows;
  const lines =
    rows.length === 0
      ? 1
      : withGlyphForm(!color, () =>
          paletteLines(
            rows.length,
            palette.state.index,
            maxRows,
            rows.map((entry) => entry.groupStart),
            'up',
          ),
        ).length;
  return lines + 3;
}

/** Which block the bottom of the page holds: the exit guard first, then the palette, then the `@` picker, else the docked prompt. */
export function workBottomBlock(input: {
  readonly exitGuard: ExitGuardPhase | undefined;
  readonly hostedRun: RunHostSnapshot | undefined;
  readonly palette: OpenPalette | undefined;
  readonly paletteMaxRows: number;
  /** The `@` picker open over the docked prompt, and its list's window (`mentionListRows`); absent ⇒ none. */
  readonly mention?: { readonly state: MentionState; readonly listRows: number } | undefined;
  readonly editor: EditorState;
  readonly cols: number;
  /** The terminal's rows: the docked prompt is drawn as a window of at most {@link workEditorRows} of them (OB71). */
  readonly rows: number;
  readonly color: boolean;
}): BottomBlock {
  const { exitGuard } = input;
  if (exitGuard !== undefined)
    return {
      kind: 'guard',
      phase: exitGuard,
      // the card's rows: a blank row, its heavy rule (ADR-0147 §1) and its lines (counted in the form they are drawn in)
      rows:
        1 +
        EXIT_GUARD_RULE_ROWS +
        withGlyphForm(!input.color, () =>
          exitGuardLines(exitGuard, input.hostedRun, HOSTED_RUN_EXIT_BOUND_MS / 1000),
        ).length,
    };
  if (input.palette !== undefined)
    return {
      kind: 'palette',
      palette: input.palette,
      maxRows: input.paletteMaxRows,
      rows: paletteBlockRows(input.palette, input.paletteMaxRows, input.color),
    };
  if (input.mention !== undefined)
    return {
      kind: 'mention',
      mention: input.mention.state,
      listRows: input.mention.listRows,
      rows: dockedMentionRows(
        input.mention.state,
        input.mention.listRows,
        homePromptRows(input.editor, homeContentColumns(input.cols), workEditorRows(input.rows)),
      ),
    };
  return {
    kind: 'docked',
    rows:
      DOCKED_CHROME_ROWS +
      homePromptRows(input.editor, homeContentColumns(input.cols), workEditorRows(input.rows)),
  };
}

export interface HomeWorkPageProps {
  /** The box the Home's measured-frame evidence is taken of (the page at rest); absent while the page is drawn inside the slide's window. */
  readonly frame?: RefObject<DOMElement | null> | undefined;
  /** The sections, built in the glyph form in force ({@link buildSections}) for {@link workListBudget}'s rows. */
  readonly sections: SectionsModel;
  /** The rows of the list region. */
  readonly budget: number;
  /** The ONE draft (the landing's prompt draws it too). */
  readonly editor: EditorState;
  /** The docked prompt has the focus: its cursor is drawn (on a row, or while the page slides away, it is not). */
  readonly promptFocused: boolean;
  readonly status: LandingStatus;
  readonly hint: HintRow;
  readonly notice: LandingNotice | undefined;
  readonly bottom: BottomBlock;
  /** The exit-guard card the Home built (ADR-0139 §6), drawn in the prompt block's place while the bottom block is the guard. */
  readonly guardCard?: ReactNode;
  readonly cols: number;
  readonly rows: number;
  readonly color: boolean;
}

/** The docked prompt block: a blank row, the prompt with its invitation, the thin rule, the status line and the hint. */
function DockedPrompt(props: Readonly<HomeWorkPageProps>): ReactElement {
  const { color, cols } = props;
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box height={1} />
      <PromptEditor
        editor={props.editor}
        color={color}
        glyph={glyphOf('yourTurn', !color)}
        placeholder={DOCKED_PLACEHOLDER}
        cursor={props.promptFocused && props.editor.cursor >= 0}
        maxRows={workEditorRows(props.rows)}
        columns={homeContentColumns(cols)}
      />
      <Text {...dimProps(color)} wrap="truncate-end">
        {thinRule(homeRailWidth(cols), !color)}
      </Text>
      <StatusRow status={props.status} cols={cols} color={color} />
      <HomeHintText hint={props.hint} color={color} />
    </Box>
  );
}

function BottomOf(props: Readonly<HomeWorkPageProps>): ReactElement {
  const { bottom, color } = props;
  if (bottom.kind === 'guard')
    return (
      <Box flexDirection="column" flexShrink={0} marginTop={1}>
        {props.guardCard}
      </Box>
    );
  if (bottom.kind === 'palette')
    return (
      <PaletteAbovePrompt
        palette={bottom.palette}
        maxRows={bottom.maxRows}
        ruleColumns={homeRailWidth(props.cols)}
        color={color}
      />
    );
  if (bottom.kind === 'mention')
    return (
      <DockedMention
        mention={bottom.mention}
        listRows={bottom.listRows}
        editor={props.editor}
        editorRows={workEditorRows(props.rows)}
        cols={props.cols}
        color={color}
      />
    );
  return <DockedPrompt {...props} />;
}

/** The rows the work page's list region holds under the way back, once the bottom block and the notice (with its blank row) are drawn. */
export function workListBudget(
  rows: number,
  bottom: BottomBlock,
  notice: LandingNotice | undefined,
): number {
  const noticeRows =
    notice === undefined ? 0 : notice.lines.length + (notice.footer === undefined ? 0 : 1);
  return workListRows(rows, bottom.rows, noticeRows);
}

export function HomeWorkPage(props: Readonly<HomeWorkPageProps>): ReactElement {
  const { cols, rows, color, notice } = props;
  return (
    <Box
      ref={props.frame}
      flexDirection="column"
      height={frameRows(rows)}
      overflow="hidden"
      marginLeft={homeMargin(cols)}
      flexShrink={0}
    >
      {/* nothing in the head shrinks: whether the blank row under the way back is drawn is the page's own decision (`workHeadRows`, from 26 rows), not Yoga's */}
      <Box flexShrink={0}>
        <Text {...dimProps(color)} wrap="truncate-end">
          {WAY_BACK_LINE}
        </Text>
      </Box>
      {workHeadRows(rows) > 1 && <Box height={1} flexShrink={0} />}
      <WorkSections model={props.sections} budget={props.budget} color={color} />
      {notice !== undefined && (
        <Box flexDirection="column" flexShrink={0} marginTop={1}>
          <NoticeRows notice={notice} color={color} />
        </Box>
      )}
      <BottomOf {...props} />
    </Box>
  );
}
