import { Box, type DOMElement } from 'ink';
import { Text } from './text.js';
import { useLayoutEffect, useRef, type ReactElement, type RefObject } from 'react';

import type { HomeStatusFacts } from '../../home/home-status-facts.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import type { EditorState } from './chat-input.js';
import { EmphText } from './emphasis-view.js';
import { withGlyphForm } from './glyphs.js';
import {
  exitGuardLines,
  homeFitsTerminal,
  homeIsEmpty,
  HOSTED_RUN_ENTER_ITEM,
  hostedRunCanBeShown,
  hostedRunLabel,
  tooSmallMessage,
  type ExitGuardPhase,
} from './home-projection.js';
import { attentionOrder, urgentHeadOf, type ParkedRunRow } from './home-attention.js';
import { keyHint, legend } from './legend.js';
import { HomeLanding, LandingPalette, type LandingStatus } from './home-landing.js';
import { LandingMention, landingMentionRows } from './mention-home.js';
import { MENTION_WINDOW } from './mention-view.js';
import type { MentionState } from './mention.js';
import {
  frameRows,
  LANDING_FOOT_ROWS,
  landingEditorRows,
  landingRowsAbovePrompt,
  landingTopGap,
  showsLandingBlock,
} from './home-layout.js';
import {
  EXIT_AGAIN,
  EXIT_TWICE,
  landingHint,
  MENTION_CHROME_ROWS,
  mentionListRows,
  workCounts,
  workHint,
  type HintRow,
  type HomePage,
  type UrgentHead,
  type WorkCounts,
  type WorkRowCue,
} from './home-pages.js';
import { buildSections, HomeWorkPage, workBottomBlock, workListBudget } from './home-work-page.js';
import { paletteQueryEditor } from './palette-block.js';
import { chatPaletteRows } from './palette-view.js';
import type { OpenPalette } from './palette-reducer.js';
import {
  PALETTE_CHROME_ROWS,
  PALETTE_MIN_ROWS,
  paletteGapCount,
  paletteLines,
  paletteRowBudget,
} from './palette-window.js';
import type { DisplayPathRoots } from '../notation.js';
import { colorProps, dimProps } from './projection.js';
import { homeContentColumns, homePromptRows, layoutHomeNotice } from './home-notice.js';
import { stripReach, stripRows, isFocused, type StripFocus } from './strip-focus.js';
import { HOSTED_RUN_EXIT_BOUND_MS } from './tui-constants.js';
import { displayWidth } from './viewport.js';

/**
 * The PURE render of the bare-invocation Home as TWO PAGES (MVP-11 unit 7, ADR-0146 §1 with the maintainer's 2026-11-26 choice): page 1 is
 * ALWAYS the calm landing (the block or the one-line title, the prompt with its example, the one status line, the hint; with the INDICATOR in the
 * hint when there is something to continue, and the hosted run's one row while a leg executes); page 2 is the work page (`home-work-page.tsx`:
 * the strip's sections over a docked prompt). No `useInput`, no state, no store: the single raw-mode owner is the Home's `RootApp`, which passes
 * the controller's state, the terminal size and a clock here. Below the 80×24 minimum the whole view degrades to a single resize line.
 *
 * In the alternate screen a change of page SLIDES: while the controller's slide is in progress this view draws a window of `rows − 1` rows onto
 * the two pages stacked (each exactly `rows − 1` tall), the inner column moved up by the slide's offset; the window clips what is outside it, so
 * every frame is the rows of one document and never taller than the screen. At rest, and always inline, only the page in front is drawn.
 */

interface HomeViewProps {
  readonly onFrame?: ((node: DOMElement | null) => void) | undefined;
  readonly snapshot: HomeSnapshot;
  /** The current prompt editor — text + cursor (owned by the `RootApp`): the ONE draft both pages' prompts draw. */
  readonly editor: EditorState;
  /** Transient command output (a refusal, a flow's closing sentence, a failed build), shown on the page in front, cleared on the next
   *  edit/submit. Multi-line; each line is sanitised as it is laid out (`layoutHomeNotice`). */
  readonly notice?: string | undefined;
  /** Injected clock for the relative-time labels (the projection is clock-free). */
  readonly nowMs: number;
  readonly cols: number;
  readonly rows: number;
  readonly color: boolean;
  /** When the `/` palette (or the model picker the host draws) owns the bottom of the view, the prompt block is not drawn. */
  readonly paletteOpen?: boolean;
  /**
   * The Home's open `/` palette, drawn here in the prompt's place: under the landing's prompt (it runs down), above the work page's docked prompt
   * (it runs up, as a chat's does). Absent ⇒ no palette is drawn here (`paletteOpen` alone only suppresses the prompt).
   */
  readonly palette?: OpenPalette;
  /**
   * The Home's open `@` file picker (ADR-0061 on the Home's own prompts), drawn as the palette is: under the landing's prompt row, which does not
   * move, and above the work page's docked prompt. Absent ⇒ none is open.
   */
  readonly mention?: MentionState | undefined;
  /** `[preferences].show_banner` (2.6.F Step 5g). `undefined` and `true` ⇒ the landing's block; `false` ⇒ its one-line title (`showsLandingBlock`). */
  readonly showBanner?: boolean | undefined;
  /** The alternate screen draws the landing's top gap and slides between the pages; inline draws no gap and swaps them. Absent ⇒ inline. */
  readonly alternateScreen?: boolean | undefined;
  /** What the next chat would use and where it would work (ADR-0146 §2), read by the controller: both pages draw it as the one status line. */
  readonly status?: HomeStatusFacts | undefined;
  /** Cached key availability, sampled by the host on opening and changes. */
  readonly keyless?: boolean;
  readonly noticePage?: number;
  /** The interrupt keymap is armed (ADR-0115 §1): a second `Ctrl+C` exits the Home, and the hint says so. */
  readonly interruptArmed?: boolean | undefined;
  /** The run host's snapshot (ADR-0139 §3): the landing's run row shows the active run, and nothing when none is active. */
  readonly hostedRun?: RunHostSnapshot | undefined;
  /**
   * What a path is shortened against (ADR-0145 §8). The work page no longer draws a session's directory (MVP-11 unit 7: every session it
   * lists is this directory's, one row each), so the view reads it nowhere now; the Home's host still hands it in with its other props.
   */
  readonly paths?: DisplayPathRoots | undefined;
  /** The exit-guard card (ADR-0139 §6): it takes the place of the prompt block of the page in front and holds the notice back. */
  readonly exitGuard?: ExitGuardPhase | undefined;
  /** The runs of THIS project that are parked ([ADR-0139] §3, §7): one Attention row each on the work page. */
  readonly parkedRuns?: readonly ParkedRunRow[] | undefined;
  /** The work page's focused row (ADR-0140 §6), by its identity: marked `›` and always one of the rows drawn. `undefined`: no row. */
  readonly stripFocus?: StripFocus | undefined;
  /** The one notification of the Home's channel, drawn on the hint row in place of the hint for its few seconds (ADR-0148 §2). */
  readonly notification?: string | undefined;
  /** Which page is in front (MVP-11 unit 7): the landing, or the work page. Absent ⇒ the landing. */
  readonly page?: HomePage | undefined;
  /**
   * The slide in progress (alternate screen only): the window's offset in whole rows from the top of the landing (`slideFrames`). Absent ⇒ at
   * rest. Ignored inline, where the pages swap.
   */
  readonly slideOffset?: number | undefined;
}

const NO_PARKED: readonly ParkedRunRow[] = [];
const NOTHING_TO_COUNT: WorkCounts = { attention: 0, sessions: 0, runs: 0 };

/**
 * The exit-guard card (ADR-0139 §6): a title line, what leaving does and the keys, each in words so it reads with colour off. It is
 * the same card on both pages, in the loading echo and in the below-minimum degrade.
 */
export function ExitGuardCard(
  props: Readonly<{
    phase: ExitGuardPhase;
    hostedRun: RunHostSnapshot | undefined;
    color: boolean;
  }>,
): ReactElement {
  const lines = withGlyphForm(!props.color, () =>
    exitGuardLines(props.phase, props.hostedRun, HOSTED_RUN_EXIT_BOUND_MS / 1000),
  );
  return (
    <Box flexDirection="column">
      {lines.map((line, row) => (
        <EmphText
          key={line}
          {...(row === 0 ? colorProps(props.color, 'yellow') : dimProps(props.color))}
          emphasis={row === 0 ? 'bold' : undefined}
          wrap="truncate-end"
        >
          {line}
        </EmphText>
      ))}
    </Box>
  );
}

/**
 * The standing call to action of a Home with no key (ADR-0146 §5): `Enter` opens the provider setup. A key and a command word, so it has no leaving
 * key of its own: the hint bar under it carries that. On both pages it takes the place of the status line.
 */
const KEYLESS_SETUP_LINE = keyHint([
  { text: 'No provider key yet' },
  { keys: 'Enter', verb: 'connect' },
  { text: '/providers' },
]);
/** The same call to action while something else owns `Enter` (a focused row, a live run, a command being typed): only the command word is promised. */
const KEYLESS_SETUP_LINE_ENTER_TAKEN = 'No provider key yet · /providers connects one';

/**
 * What the status row says (ADR-0146 §2, §5): with no provider key the call to connect (promising `Enter` only where `Enter` does connect),
 * else the facts of the next chat when the controller holds them, else nothing.
 */
function landingStatusOf(view: HomeViewProps, enterIsTaken: boolean): LandingStatus {
  if (view.keyless === true)
    return {
      kind: 'keyless',
      line: enterIsTaken ? KEYLESS_SETUP_LINE_ENTER_TAKEN : KEYLESS_SETUP_LINE,
    };
  return view.status === undefined ? { kind: 'none' } : { kind: 'facts', facts: view.status };
}

/**
 * The rows an open palette's block needs of the landing beyond the prompt block it replaces, so a notice (a `/doctor` report that was started before
 * the palette opened) gives them up and the palette keeps the rows it is budgeted: half the terminal, as a chat's palette has (`paletteRowBudget`),
 * where the prompt block is the prompt row and the four rows under it. Read from EVERY entry, not the ones the query matches, so the notice does not
 * grow and shrink under the person's typing. Nothing without a palette.
 */
function paletteExtra(palette: OpenPalette | undefined, rows: number): number {
  if (palette === undefined) return 0;
  const entries = palette.list.entries;
  const budget = paletteRowBudget(
    rows,
    entries.length,
    paletteGapCount(entries.map((entry) => entry.groupStart)),
  );
  return Math.max(0, budget - 1 - LANDING_FOOT_ROWS);
}

/**
 * The picker's list window on the landing and the blank rows that keep its hint on the frame's last row in the alternate screen: what the frame
 * leaves under the prompt row (`room`), less the rule, the header and the hint, at most the size {@link mentionListRows} gives it (half the
 * terminal, as the palette's), never under one. Nothing above the prompt row gives way for it: a long draft leaves the list fewer rows.
 */
function landingMentionFit(
  mention: MentionState,
  rows: number,
  room: number,
  alternateScreen: boolean,
): { readonly listRows: number; readonly fillRows: number } {
  const listRows = Math.max(
    1,
    Math.min(mentionListRows(rows, MENTION_WINDOW), room - MENTION_CHROME_ROWS),
  );
  const fillRows = alternateScreen ? Math.max(0, room - landingMentionRows(mention, listRows)) : 0;
  return { listRows, fillRows };
}

/**
 * The rows an open palette's block takes on the landing, from its prompt row down to its legend (OB72): half the terminal at most, as a chat's
 * palette is ({@link chatPaletteRows}: 12 rows at 80×24, a window of eight entries and a marker), never what the terminal leaves under the prompt
 * row, and never fewer than a window with both markers (`PALETTE_MIN_ROWS`). `rowsAbove` is the rows above the prompt row, the top gap included.
 */
function landingPaletteRows(palette: OpenPalette, rows: number, rowsAbove: number): number {
  return Math.max(
    PALETTE_MIN_ROWS,
    Math.min(chatPaletteRows(rows, palette.list), frameRows(rows) - rowsAbove),
  );
}

/**
 * The blank rows that keep the palette's legend on the frame's last row in the alternate screen (the study's frame 11: the hint row does not
 * walk up the screen as the query narrows the list); none inline, where the block is only as tall as it is. The list's lines are the window the
 * palette draws for `budget` rows.
 */
function landingPaletteFill(
  palette: OpenPalette,
  budget: number,
  room: number,
  alternateScreen: boolean,
): number {
  if (!alternateScreen) return 0;
  const entries = palette.list.rows;
  const listLines =
    entries.length === 0
      ? 1
      : paletteLines(
          entries.length,
          palette.state.index,
          budget,
          entries.map((entry) => entry.groupStart),
          palette.list.layout,
        ).length;
  return Math.max(0, room - PALETTE_CHROME_ROWS - listLines);
}

/** The editor as a prompt that does not have the focus draws it: the same text, no cursor (`-1` is before the text: no row carries it). */
function withoutCursor(editor: EditorState): EditorState {
  return editor.cursor < 0 ? editor : { text: editor.text, cursor: -1 };
}

/** What both pages are built from, once per draw. */
interface PageInput {
  readonly view: HomeViewProps;
  readonly page: HomePage;
  readonly canContinue: boolean;
  readonly counts: WorkCounts;
  readonly runCanBeShown: boolean;
  readonly slashDraft: boolean;
}

/** What the landing's rows are made of, worked out once from the page, the notice and the palette (`home-layout.ts`'s one accounting). */
interface LandingGeometry {
  readonly noticeLayout: ReturnType<typeof layoutHomeNotice>;
  readonly editorRows: number;
  readonly topGap: number;
  /** The rows above the prompt row, the top gap included: where the palette's block begins. */
  readonly rowsAbove: number;
}

/**
 * The landing's geometry: the notice laid out in the room the head, the prompt block and (while the palette is open) the palette's rows leave it,
 * the editor's window in what the notice then leaves, and the top gap, which is the resting one unless the room runs out (then it is the first thing
 * to go, and the palette's rows count in that room too). `promptEditor` is what the prompt row holds, `runRows` the hosted run's row as at rest.
 */
function landingGeometry(
  input: PageInput,
  palette: OpenPalette | undefined,
  promptEditor: EditorState,
  runRows: number,
): LandingGeometry {
  const { view } = input;
  const { cols, rows } = view;
  const showBlock = showsLandingBlock(view.showBanner);
  const blockExtra = paletteExtra(palette, rows);
  const noticeLayout = layoutHomeNotice({
    notice: view.exitGuard === undefined ? view.notice : undefined,
    editor: promptEditor,
    cols,
    rows,
    showBanner: view.showBanner,
    onLanding: true,
    hasSessions: false,
    reservedRows: runRows + blockExtra,
    ...(view.noticePage === undefined ? {} : { page: view.noticePage }),
  });
  const noticeRows = noticeLayout?.rowCount ?? 0;
  // The editor's window leaves the notice its rows too: the head, the notice, the window and the four rows under it fit `rows − 1`.
  const editorRows = landingEditorRows(rows, showBlock, { noticeRows, runRows });
  const parts = {
    promptRows: homePromptRows(promptEditor, homeContentColumns(cols), editorRows),
    noticeRows,
    runRows,
  };
  const topGap = landingTopGap(rows, view.alternateScreen === true, showBlock, {
    ...parts,
    runRows: runRows + blockExtra,
  });
  return {
    noticeLayout,
    editorRows,
    topGap,
    rowsAbove: topGap + landingRowsAbovePrompt(showBlock, parts),
  };
}

/**
 * The most urgent item of "Attention required" as page 1 names it (MVP-11 unit 7): the first of the one urgency order (`attentionOrder`), in
 * the words `urgentHeadOf` builds (its stored name scrubbed and bounded there), marked as only the most urgent of those READ when more items
 * wait than the Home read (the snapshot's true count against the items in hand), or none with nothing to continue or nothing under Attention.
 */
function urgentOf(input: PageInput): UrgentHead | undefined {
  if (!input.canContinue) return undefined;
  const { view } = input;
  const items = attentionOrder(view.parkedRuns ?? NO_PARKED, view.snapshot, view.nowMs);
  return urgentHeadOf(items, view.snapshot.totals.attention, view.nowMs);
}

/** The landing's hint row: the one notification of the Home's channel in its place for its few seconds, else the hint of the draft and the Home's state. */
function landingHintOf(input: PageInput, editor: EditorState): HintRow {
  const { view } = input;
  if (view.notification !== undefined) return { text: view.notification };
  return landingHint(
    {
      interruptArmed: view.interruptArmed === true,
      draft: editor,
      keyless: view.keyless === true,
      runCanBeShown: input.runCanBeShown,
      counts: input.counts,
      urgent: urgentOf(input),
      columns: homeContentColumns(view.cols),
    },
    displayWidth,
  );
}

/**
 * The landing (page 1, ADR-0146 §1): the block or the title, the notice, the prompt block with the hosted run's row under the status line, and
 * the exit-guard card or the `/` palette where the prompt block would be. The landing's height is accounted in one place (`home-layout.ts`), and
 * the things that size it from here (the notice's room, the top gap, the editor's window and the palette's rows) read that one accounting, so the
 * landing is never taller than `rows − 1`.
 *
 * - The prompt is a window of at most `landingEditorRows` rows (OB71): a long draft shows the rows around the cursor and a `▲/▼ N more` marker.
 * - The palette opens BELOW the prompt row and moves nothing above it (OB72, the study's frame 11): the top gap and the head are what they are
 *   at rest, the query is typed on the prompt row, and the list takes the rows under the rule, at most half the terminal.
 * - A notice stands in the blank rows above the prompt and leaves an open palette the rows its block needs.
 *
 * A plain function and not a component: it builds the run row's label from the glyph table, which reads the form in force while the view
 * is built (`withGlyphForm` in {@link HomeView}), and a component renders after that scope has closed.
 */
function landingPage(
  input: PageInput,
  frame: RefObject<DOMElement | null> | undefined,
): ReactElement {
  const { view } = input;
  const { cols, rows, color, exitGuard } = view;
  // The palette opened on the page in front: the landing draws it only when it is that page (on the work page it runs up over the docked prompt).
  const palette = input.page === 'start' ? view.palette : undefined;
  // The `@` picker opened on the page in front: the landing draws it under its prompt row (on the work page it runs up over the docked prompt).
  const mention = input.page === 'start' && palette === undefined ? view.mention : undefined;
  const editor = input.page === 'start' ? view.editor : withoutCursor(view.editor);
  const runRow = hostedRunLabel(view.hostedRun);
  const promptShown = view.paletteOpen !== true && exitGuard === undefined && mention === undefined;
  // The run's row is part of the prompt block (under the status line): the exit-guard card takes its place with the block's. The palette's
  // and the picker's blocks take its place too, but the head must not move when one opens, so the row is counted as at rest.
  const runRows =
    runRow !== undefined && (promptShown || palette !== undefined || mention !== undefined) ? 1 : 0;
  // What the prompt row holds: the draft, or the query typed on it while the palette is open.
  const promptEditor = palette === undefined ? editor : paletteQueryEditor(palette.state.query);
  // The `@` picker reserves nothing above the prompt row: the head and the top gap stay as they are at rest (the prompt row does not move), and
  // the picker's list takes what the frame leaves under the prompt row (`landingMentionFit`).
  const geometry = landingGeometry(input, palette, promptEditor, runRows);
  const paletteRows =
    palette === undefined ? 0 : landingPaletteRows(palette, rows, geometry.rowsAbove);
  // `Enter` does something else first on the landing when the draft is a command or a run can be shown: the keyless line then promises only the word.
  const enterIsTaken = input.slashDraft || (input.runCanBeShown && editor.text.length === 0);
  return (
    <Box ref={frame} flexDirection="column">
      <HomeLanding
        cols={cols}
        color={color}
        topGap={geometry.topGap}
        showBlock={showsLandingBlock(view.showBanner)}
        editor={editor}
        editorRows={geometry.editorRows}
        status={landingStatusOf(view, enterIsTaken)}
        hint={landingHintOf(input, editor)}
        runRow={runRow}
        notice={geometry.noticeLayout}
        promptShown={promptShown}
      >
        {exitGuard !== undefined && (
          <ExitGuardCard phase={exitGuard} hostedRun={view.hostedRun} color={color} />
        )}
        {mention !== undefined && exitGuard === undefined && (
          <LandingMention
            mention={mention}
            editor={editor}
            editorRows={geometry.editorRows}
            cols={cols}
            color={color}
            {...landingMentionFit(
              mention,
              rows,
              frameRows(rows) -
                geometry.rowsAbove -
                homePromptRows(editor, homeContentColumns(cols), geometry.editorRows),
              view.alternateScreen === true,
            )}
          />
        )}
        {palette !== undefined && (
          <LandingPalette
            palette={palette}
            cols={cols}
            color={color}
            maxRows={paletteRows}
            fillRows={landingPaletteFill(
              palette,
              paletteRows,
              frameRows(rows) - geometry.rowsAbove,
              view.alternateScreen === true,
            )}
          />
        )}
      </HomeLanding>
    </Box>
  );
}

/** What the focused row is, for the hint's `Enter`: its role, and for a parked run what it waits on. */
function rowCueOf(
  focus: StripFocus | undefined,
  view: HomeViewProps,
  parked: readonly ParkedRunRow[],
): WorkRowCue | undefined {
  const row = stripRows(parked, view.snapshot).find((candidate) => isFocused(candidate, focus));
  if (row === undefined) return undefined;
  if (row.role === 'parked')
    return { role: 'parked', waits: parked.find((run) => run.runId === row.id)?.kind };
  return { role: row.role };
}

/**
 * The work page (page 2): `home-work-page.tsx` draws it; this builds what it is told (the focused row's cue for the hint, the status row, the
 * notice laid out for the work page, the block at the bottom and the exit-guard card).
 */
function workPage(input: PageInput, frame: RefObject<DOMElement | null> | undefined): ReactElement {
  const { view } = input;
  const { cols, rows, color, exitGuard } = view;
  const palette = input.page === 'work' ? view.palette : undefined;
  const mention = input.page === 'work' && palette === undefined ? view.mention : undefined;
  const parked = view.parkedRuns ?? NO_PARKED;
  const focus = input.page === 'work' ? view.stripFocus : undefined;
  const cue = rowCueOf(focus, view, parked);
  const promptFocused = input.page === 'work' && cue === undefined;
  const editor = promptFocused ? view.editor : withoutCursor(view.editor);
  const bottom = workBottomBlock({
    exitGuard,
    hostedRun: view.hostedRun,
    palette,
    paletteMaxRows: palette === undefined ? 0 : chatPaletteRows(rows, palette.list),
    mention:
      mention === undefined
        ? undefined
        : { state: mention, listRows: mentionListRows(rows, MENTION_WINDOW) },
    editor,
    cols,
    rows,
    color,
  });
  // The notice leaves an open palette what its block needs beyond the docked prompt's.
  const docked = workBottomBlock({
    exitGuard: undefined,
    hostedRun: undefined,
    palette: undefined,
    paletteMaxRows: 0,
    editor,
    cols,
    rows,
    color,
  });
  const noticeLayout = layoutHomeNotice({
    notice: exitGuard === undefined ? view.notice : undefined,
    editor,
    cols,
    rows,
    showBanner: view.showBanner,
    onLanding: false,
    hasSessions: view.snapshot.recentSessions.length > 0,
    ...stripReach(parked, view.snapshot),
    reservedRows: Math.max(0, bottom.rows - docked.rows),
    ...(view.noticePage === undefined ? {} : { page: view.noticePage }),
  });
  const enterIsTaken =
    cue !== undefined || input.slashDraft || (input.runCanBeShown && view.editor.text.length === 0);
  const hint: HintRow =
    view.notification === undefined
      ? workHint(
          {
            interruptArmed: view.interruptArmed === true,
            row: cue,
            draft: view.editor,
            keyless: view.keyless === true,
            runCanBeShown: input.runCanBeShown,
            hasRows: stripRows(parked, view.snapshot).length > 0,
            columns: homeContentColumns(cols),
          },
          HOSTED_RUN_ENTER_ITEM,
          displayWidth,
        )
      : { text: view.notification };
  const budget = workListBudget(rows, bottom, noticeLayout);
  // Built here, in the glyph form in force (`withGlyphForm` in `HomeView`): the rows carry the table's glyphs.
  const sections = buildSections({
    snapshot: view.snapshot,
    parked,
    focus,
    budget,
    columns: homeContentColumns(cols),
    nowMs: view.nowMs,
    color,
  });
  return (
    <HomeWorkPage
      frame={frame}
      sections={sections}
      budget={budget}
      editor={editor}
      promptFocused={promptFocused}
      status={landingStatusOf(view, enterIsTaken)}
      hint={hint}
      notice={noticeLayout}
      bottom={bottom}
      guardCard={
        exitGuard === undefined ? undefined : (
          <ExitGuardCard phase={exitGuard} hostedRun={view.hostedRun} color={color} />
        )
      }
      cols={cols}
      rows={rows}
      color={color}
    />
  );
}

/**
 * The Home's two pages. The rows are built in the glyph form the colour setting asks for (the plain forms when colour is off, ADR-0145 §5): the
 * body runs inside {@link withGlyphForm}, so every table glyph a row carries is the form that is drawn and every row is measured on it.
 */
export function HomeView(props: Readonly<HomeViewProps>): ReactElement {
  return withGlyphForm(!props.color, () => HomeViewBody(props));
}

function HomeViewBody(props: Readonly<HomeViewProps>): ReactElement {
  const { snapshot, editor, cols, rows, color } = props;
  const interruptArmed = props.interruptArmed === true;
  const exitGuard = props.exitGuard;
  const parked = props.parkedRuns ?? NO_PARKED;
  const frame = useRef<DOMElement | null>(null);
  useLayoutEffect(() => {
    props.onFrame?.(frame.current);
  });

  // Below the minimum, render ONLY the resize line (+ the exit affordance) — the RootApp suspends the pages
  // until a resize arrives, so the user must still be able to leave without resizing.
  if (!homeFitsTerminal(cols, rows)) {
    return (
      <Box flexDirection="column">
        <Text {...colorProps(color, 'yellow')} wrap="truncate-end">
          {tooSmallMessage(cols, rows)}
        </Text>
        {exitGuard === undefined ? (
          <Text {...dimProps(color)} wrap="truncate-end">
            {legend([], interruptArmed ? EXIT_AGAIN : EXIT_TWICE)}
          </Text>
        ) : (
          <ExitGuardCard phase={exitGuard} hostedRun={props.hostedRun} color={color} />
        )}
      </Box>
    );
  }

  // Nothing to continue: there is no work page, and the landing is the Home (ADR-0146 §1); a page the controller still names falls back to it.
  const canContinue = !homeIsEmpty(snapshot, parked);
  const page: HomePage = canContinue ? (props.page ?? 'start') : 'start';
  const input: PageInput = {
    view: props,
    page,
    canContinue,
    counts: canContinue ? workCounts(snapshot) : NOTHING_TO_COUNT,
    runCanBeShown: hostedRunCanBeShown(props.hostedRun),
    // dispatch trims, so a line with blanks before its slash is a command too
    slashDraft: editor.text.trimStart().startsWith('/'),
  };
  const offset = props.slideOffset;
  if (offset === undefined || props.alternateScreen !== true || !canContinue)
    return page === 'work' ? workPage(input, frame) : landingPage(input, frame);
  // The slide: a window of `rows − 1` rows onto the landing and the work page stacked, the column moved up by the offset. Each page is exactly
  // `rows − 1` tall in it, so an offset of `rows − 1` is the work page at rest and 0 the landing at rest.
  const pageRows = frameRows(rows);
  return (
    <Box ref={frame} flexDirection="column" height={pageRows} overflow="hidden" flexShrink={0}>
      <Box
        flexDirection="column"
        marginTop={-Math.max(0, Math.min(pageRows, offset))}
        flexShrink={0}
      >
        <Box flexDirection="column" height={pageRows} overflow="hidden" flexShrink={0}>
          {landingPage(input, undefined)}
        </Box>
        {workPage(input, undefined)}
      </Box>
    </Box>
  );
}
