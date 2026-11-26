import { Box, type DOMElement } from 'ink';
import type { ReactElement, ReactNode, RefObject } from 'react';

import type {
  HomeAgentRow,
  HomeRunRow,
  HomeSessionRow,
  HomeSnapshot,
} from '../../home/home-store.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import type { DisplayPathRoots } from '../notation.js';
import type { EditorState } from './chat-input.js';
import { sanitizeInline } from './chat-projection.js';
import { flowLine } from './flow-text.js';
import type { StatusColor } from './format.js';
import { glyph, glyphOf, withGlyphForm } from './glyphs.js';
import {
  PARKED_ROW_INDENT_COLUMNS,
  parkedRunLabel,
  parkedRunOverdue,
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
import {
  DOCKED_CHROME_ROWS,
  DOCKED_PLACEHOLDER,
  UNREADABLE_ROWS_SHOWN,
  WAY_BACK_LINE,
  workEditorRows,
  workListRows,
  type HintRow,
} from './home-pages.js';
import {
  agentLabel,
  exitGuardLines,
  runLabel,
  sessionLabel,
  unreadableRunLabel,
  type ExitGuardPhase,
} from './home-projection.js';
import { homeContentColumns, homePromptRows } from './home-notice.js';
import type { OpenPalette } from './palette-reducer.js';
import { PaletteAbovePrompt } from './palette-block.js';
import { paletteLines } from './palette-window.js';
import { placeForDisplay } from './place-label.js';
import { colorProps, dimProps } from './projection.js';
import { PromptEditor } from './prompt-view.js';
import { SelectableText, selectionMarker } from './selectable-text.js';
import type { StripFocus } from './strip-focus.js';
import { Text } from './text.js';
import { HOSTED_RUN_EXIT_BOUND_MS } from './tui-constants.js';

/**
 * The Home's WORK PAGE (page 2, MVP-11 unit 7): what `↓` from the landing goes down to. Left-hung at the Home's margin and exactly `rows − 1` rows
 * tall, top to bottom:
 *
 * - the way back, dim (`↑ start page`), and a blank row;
 * - the strip's sections as the Home has always built them ("Attention required": the parked runs of this project, the runs whose log cannot be
 *   read, the failed runs; then "Continue": the sessions with their directories, the runs, the agents; all of them this directory's), windowed to the
 *   rows the page leaves them so the focused row is always one of the rows drawn;
 * - a notice, when there is one, with a blank row above it;
 * - the block at the bottom: the DOCKED PROMPT (a blank row, the prompt with its invitation, the thin rule, the status line, the hint), or, while
 *   the `/` palette is open, the palette above the prompt (its list, the prompt with the typed query, the rule, the palette's legend on the hint
 *   row), or the exit-guard card in the prompt block's place.
 *
 * Pure: it holds no state and reads nothing but its props. The strip's labels come from the unit-tested `home-projection`; every free text is
 * sanitised at this boundary (and each row cut at its width rather than wrapped, so a long title cannot shatter the list).
 */

/** Columns a session's directory line spends before its text: the section's indent (2) and the line's own (4). */
const STRIP_HINT_INDENT = 6;

/** A strip row: a stable key (the row's durable id), its line, and the directory line under a session. */
interface StripRow {
  readonly key: string;
  readonly line: string;
  readonly hint?: string;
  readonly selected?: boolean;
}

/** A labelled list section ("Sessions", "Runs", …): nothing when it is empty. */
function Section(
  props: Readonly<{ title: string; rows: readonly StripRow[]; color: boolean; tint?: StatusColor }>,
): ReactElement | null {
  if (props.rows.length === 0) return null;
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text {...dimProps(props.color)} wrap="truncate-end">
        {props.title}
      </Text>
      {props.rows.map((row) => (
        <Box key={row.key} flexDirection="column">
          <Text
            {...(props.tint === undefined ? {} : colorProps(props.color, props.tint))}
            wrap="truncate-end"
          >
            <SelectableText selected={row.selected}>
              {`${selectionMarker(row.selected, props.color)} `}
              {sanitizeInline(row.line)}
            </SelectableText>
          </Text>
          {row.hint !== undefined && (
            <Text {...dimProps(props.color)} wrap="truncate-end">
              {'    '}
              {row.hint}
            </Text>
          )}
        </Box>
      ))}
    </Box>
  );
}

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
  readonly paths: DisplayPathRoots | undefined;
  /** Colour on or off: the rows carry the glyph table's glyphs in the form it asks for (the plain forms without colour, ADR-0145 §5). */
  readonly color: boolean;
}

/**
 * The sections' rows, windowed to the budget the way the strip always was (the focused row is always one of the rows drawn). Every line is built
 * here, as text, by the plain function {@link buildSections}: a line carries glyphs of the glyph table, whose form is the one in force while the
 * view is BUILT (`withGlyphForm`), and a component renders after that scope has closed.
 */
export interface SectionsModel {
  readonly parkedRows: readonly (StripRow & { readonly overdue: boolean })[];
  readonly unreadable: readonly StripRow[];
  readonly failed: readonly StripRow[];
  readonly sessions: readonly StripRow[];
  readonly runs: readonly StripRow[];
  readonly agents: readonly StripRow[];
}

/**
 * The strip's rows for `budget` rows. The Attention rows come first (the parked runs, the unreadable runs, the failed runs) and leave the Continue sections their least (a session's four rows when there is one); each window follows the focus so the focused
 * row is drawn; the sessions take two rows each (the title and the directory) and leave a focused recent run its section's title and row.
 */
export function buildSections(input: SectionsInput): SectionsModel {
  return withGlyphForm(!input.color, () => sectionsIn(input));
}

// ---- The stored text of a row (MVP-11 unit 7, round 1) ----------------------------------------------------------------------------
// A session's title and agent, a run's id and workflow, a gate's message: stored text a model, a project or another terminal wrote. Each passes
// the Home's full row scrub (`flowLine`: secrets, control, bidirectional, invisible and line-separator characters, host glyphs, answer chords,
// and the legend's separators and key tokens made inert) BEFORE the strip's label is built from it, so the label's own separators are the only
// ones on the row. A row's identity (its key, its focus) is the stored id as it is; only what is drawn is scrubbed.

/** A session row with its drawn text scrubbed. */
function scrubbedSession(row: HomeSessionRow): HomeSessionRow {
  return {
    ...row,
    title: row.title === undefined ? undefined : flowLine(row.title),
    agentSlug: flowLine(row.agentSlug),
  };
}
/** A run row with its drawn text scrubbed (the workflow, and the id its short form is cut from). */
function scrubbedRun(row: HomeRunRow): HomeRunRow {
  return {
    ...row,
    runId: flowLine(row.runId),
    workflowSlug: row.workflowSlug === undefined ? undefined : flowLine(row.workflowSlug),
  };
}
/** An agent row with its name scrubbed. */
function scrubbedAgent(row: HomeAgentRow): HomeAgentRow {
  return { ...row, agentSlug: flowLine(row.agentSlug) };
}

function sectionsIn(input: SectionsInput): SectionsModel {
  const { snapshot, parked, focus, columns, nowMs } = input;
  const parkedIds = new Set(parked.map((row) => row.runId));
  const runFocused = (runId: string): boolean => focus?.kind === 'run' && focus.id === runId;
  let remaining = Math.max(0, input.budget);
  let attentionRemaining = Math.max(
    0,
    remaining - (snapshot.recentSessions.length > 0 ? 4 : 0) - 2,
  );
  // A focused failed run is drawn after the rows above it, so they leave it one row.
  const failedFocusIndex = snapshot.attention.failedRuns.findIndex((run) => runFocused(run.runId));
  let attentionReserve = failedFocusIndex >= 0 ? 1 : 0;
  const takeAttention = <T,>(items: readonly T[], max = attentionRemaining): readonly T[] => {
    const room = Math.max(0, attentionRemaining - attentionReserve);
    const selected = items.slice(0, Math.min(room, max));
    attentionRemaining -= selected.length;
    return selected;
  };
  const parkedFocusIndex = parked.findIndex((row) => runFocused(row.runId));
  const parkedCapacity = Math.max(0, attentionRemaining - attentionReserve);
  const parkedStart = Math.max(0, parkedFocusIndex - parkedCapacity + 1);
  const parkedRows = takeAttention(parked.slice(parkedStart)).map((row) => ({
    key: `parked:${row.runId}`,
    line: `${runFocused(row.runId) ? `${glyph('selection')} ` : '  '}${parkedRunLabel(row, runFocused(row.runId), columns - PARKED_ROW_INDENT_COLUMNS, nowMs)}`,
    selected: runFocused(row.runId),
    overdue: parkedRunOverdue(row, nowMs),
  }));
  const unreadable = takeAttention(snapshot.unreadableRuns, UNREADABLE_ROWS_SHOWN).map(
    ({ runId }) => ({
      key: `unreadable-${runId}`,
      line: `${glyph('warning')} ${unreadableRunLabel(flowLine(runId))}`,
    }),
  );
  attentionReserve = 0; // the failed runs are the last of the Attention rows: what is left is theirs
  const failedStart = Math.max(0, failedFocusIndex - attentionRemaining + 1);
  const failed = takeAttention(snapshot.attention.failedRuns.slice(failedStart)).map((r) => ({
    key: r.runId,
    line: `${glyph('failed')} ${runLabel(scrubbedRun(r), nowMs)}`,
    selected: runFocused(r.runId),
  }));
  const attentionCount = parkedRows.length + unreadable.length + failed.length;
  // the heading and the blank row under the section
  if (attentionCount > 0) remaining -= attentionCount + 2;
  let continueHeading = false;
  const takeSection = <T,>(items: readonly T[], cost = 1, reserve = 0): readonly T[] => {
    const chrome = continueHeading ? 1 : 2;
    const selected = items.slice(0, Math.max(0, Math.floor((remaining - chrome - reserve) / cost)));
    if (selected.length > 0) {
      remaining -= chrome + selected.length * cost;
      continueHeading = true;
    }
    return selected;
  };
  const recentRuns = snapshot.recentRuns.filter((r) => !parkedIds.has(r.runId));
  const runFocusIndex = recentRuns.findIndex((r) => runFocused(r.runId));
  // A focused recent run is drawn after the sessions, so they leave it its section's title and its own row.
  const sessionReserve = runFocusIndex >= 0 ? 2 : 0;
  const sessionCapacity = Math.max(0, Math.floor((remaining - 2 - sessionReserve) / 2));
  const focusedIndex = snapshot.recentSessions.findIndex(
    (s) => focus?.kind === 'session' && s.sessionId === focus.id,
  );
  const sessionStart = Math.max(0, focusedIndex - sessionCapacity + 1);
  const sessions = takeSection(snapshot.recentSessions.slice(sessionStart), 2, sessionReserve).map(
    (s) => ({
      key: s.sessionId,
      line: sessionLabel(scrubbedSession(s), nowMs),
      hint: placeForDisplay(
        s.workingDir,
        input.paths,
        Math.max(1, columns - STRIP_HINT_INDENT),
        flowLine,
      ),
      selected: focus?.kind === 'session' && s.sessionId === focus.id,
    }),
  );
  const runCapacity = Math.max(0, remaining - (continueHeading ? 1 : 2));
  const runStart = Math.max(0, runFocusIndex - runCapacity + 1);
  const runs = takeSection(recentRuns.slice(runStart)).map((r) => ({
    key: r.runId,
    line: runLabel(scrubbedRun(r), nowMs),
    selected: runFocused(r.runId),
  }));
  const agents = takeSection(snapshot.recentAgents).map((a) => ({
    key: a.agentSlug,
    line: agentLabel(scrubbedAgent(a), nowMs),
  }));
  return { parkedRows, unreadable, failed, sessions, runs, agents };
}

/** The Attention section: its heading in the warning colour, its rows, and the blank row under it. */
function AttentionSection(
  props: Readonly<{ model: SectionsModel; color: boolean }>,
): ReactElement | null {
  const { model, color } = props;
  if (model.parkedRows.length + model.unreadable.length + model.failed.length === 0) return null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text {...colorProps(color, 'yellow')} wrap="truncate-end">
        Attention required
      </Text>
      <Box flexDirection="column" marginLeft={2}>
        {model.parkedRows.map((row) => (
          <Text
            key={row.key}
            {...colorProps(color, row.overdue ? 'red' : 'yellow')}
            wrap="truncate-end"
          >
            <SelectableText selected={row.selected}>{sanitizeInline(row.line)}</SelectableText>
          </Text>
        ))}
        {/* A run whose event log cannot be read: its gate detail is MISSING, not absent (#W15-15). */}
        {model.unreadable.map((row) => (
          <Text key={row.key} {...colorProps(color, 'red')} wrap="truncate-end">
            {'  '}
            {row.line}
          </Text>
        ))}
        {model.failed.map((f) => (
          <Text key={f.key} {...colorProps(color, 'red')} wrap="truncate-end">
            <SelectableText selected={f.selected}>
              {`${selectionMarker(f.selected, color)} `}
              {sanitizeInline(f.line)}
            </SelectableText>
          </Text>
        ))}
      </Box>
    </Box>
  );
}

/**
 * The work page's list: the strip's sections ({@link buildSections}) in a region of exactly `budget` rows, so the block under it stays where it is
 * whatever the list holds.
 */
function WorkSections(
  props: Readonly<{ model: SectionsModel; budget: number; color: boolean }>,
): ReactElement {
  const { color, model } = props;
  const hasContinue = model.sessions.length + model.runs.length + model.agents.length > 0;
  return (
    <Box flexDirection="column" height={Math.max(0, props.budget)} overflow="hidden" flexShrink={0}>
      <AttentionSection model={model} color={color} />
      {hasContinue && (
        <>
          <Text {...dimProps(color)} wrap="truncate-end">
            Continue
          </Text>
          <Section title="Sessions" rows={model.sessions} color={color} />
          <Section title="Runs" rows={model.runs} color={color} />
          <Section title="Agents" rows={model.agents} color={color} />
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
  | { readonly kind: 'guard'; readonly rows: number; readonly phase: ExitGuardPhase };

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

/** Which block the bottom of the page holds: the exit guard first, then the palette, else the docked prompt. */
export function workBottomBlock(input: {
  readonly exitGuard: ExitGuardPhase | undefined;
  readonly hostedRun: RunHostSnapshot | undefined;
  readonly palette: OpenPalette | undefined;
  readonly paletteMaxRows: number;
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
      // the card's rows: a blank row and its lines (counted in the form they are drawn in)
      rows:
        1 +
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
      <Text {...dimProps(color)} wrap="truncate-end">
        {WAY_BACK_LINE}
      </Text>
      <Box height={1} />
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
