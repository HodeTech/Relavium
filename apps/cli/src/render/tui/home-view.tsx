import { Box, Text, type DOMElement } from 'ink';
import { useLayoutEffect, useRef, type ReactElement } from 'react';

import type { HomeSnapshot } from '../../home/home-store.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import { bannerLines, shouldShowBanner } from './banner.js';
import type { EditorState } from './chat-input.js';
import { sanitizeInline } from './chat-projection.js';
import type { StatusColor } from './format.js';
import {
  agentLabel,
  exitGuardLines,
  gateExpired,
  gateLabel,
  homeFitsTerminal,
  homeIsEmpty,
  HOSTED_RUN_ENTER_CUE,
  hostedRunCanBeShown,
  hostedRunLabel,
  runLabel,
  sessionLabel,
  tooSmallMessage,
  unreadableRunLabel,
  type ExitGuardPhase,
} from './home-projection.js';
import {
  PARKED_ROW_INDENT_COLUMNS,
  parkedRunLabel,
  parkedRunOverdue,
  type ParkedRunKind,
  type ParkedRunRow,
} from './home-attention.js';
import { PaletteView } from './palette-view.js';
import type { PaletteList, PaletteState } from './palette-reducer.js';
import { PALETTE_MIN_ROWS, paletteGapCount, paletteRowBudget } from './palette-window.js';
import { colorProps, dimProps } from './projection.js';
import { PromptEditor } from './prompt-view.js';
import { homePromptRows, layoutHomeNotice } from './home-notice.js';
import {
  isFocused,
  stripReach,
  stripRows,
  type StripFocus,
  type StripRole,
} from './strip-focus.js';
import { HOSTED_RUN_EXIT_BOUND_MS } from './tui-constants.js';

/**
 * The PURE render of the bare-invocation Home (2.5.B / ADR-0054): a management strip — an "Attention
 * required" section (pending human gates, then failed runs) above a "Continue" list (recent sessions / runs /
 * agents) — with a live prompt below it. No `useInput`, no state, no store: the single raw-mode owner is the
 * Home's `RootApp`, which passes the snapshot + the prompt buffer + the terminal size + a clock here. Below the
 * 80×24 minimum the whole view degrades to a single resize line (the `RootApp` holds it until a resize). The
 * strip labels come from the unit-tested `home-projection`; the prompt echo is sanitized at this boundary.
 *
 * Every dynamic line is `wrap="truncate-end"` — a long title / slug / message truncates with an ellipsis at the
 * terminal edge rather than soft-wrapping into a second physical row (which would shatter the glanceable strip),
 * mirroring the sibling run TUI. Sessions have a separate directory line. An overdue (expired) gate is escalated yellow → red so the most time-critical
 * item in "Attention required" catches the eye. A chat that could not be built is reported in the notice area (it wraps and pages, so the
 * whole failure is readable; a one-row line cut the remedy off at 80 columns).
 */

interface HomeViewProps {
  readonly onFrame?: ((node: DOMElement | null) => void) | undefined;
  readonly snapshot: HomeSnapshot;
  /** The current prompt editor — text + cursor (owned by the `RootApp`). */
  readonly editor: EditorState;
  /** Transient command output — the `/doctor` report (2.5.C S5), shown above the prompt, cleared on the next
   *  edit/submit. Multi-line + already secret-free (the doctor formatter sanitizes). */
  readonly notice?: string | undefined;
  /** Injected clock for the relative-time labels (the projection is clock-free). */
  readonly nowMs: number;
  readonly cols: number;
  readonly rows: number;
  readonly color: boolean;
  /** When the `/` palette is open it owns the bottom of the view, so the prompt + footer hint are suppressed (2.5.C S3c). */
  readonly paletteOpen?: boolean;
  /**
   * The bare Home's open `/` palette, drawn here in the prompt's place so that the strip and the notice can leave it the rows it needs: the
   * landing and the palette together are never taller than the terminal (`paletteRowBudget`, `paletteLines`). Absent ⇒ no palette is drawn
   * here (`paletteOpen` alone only suppresses the prompt, as it does for the model picker, which the host draws).
   */
  readonly palette?: { readonly list: PaletteList; readonly state: PaletteState };
  /** `[preferences].show_banner` (2.6.F Step 5g). `undefined` ⇒ `shouldShowBanner`'s empty-Home rule. */
  readonly showBanner?: boolean | undefined;
  /** Cached key availability, sampled by the host on opening and changes. */
  readonly keyless?: boolean;
  readonly noticePage?: number;
  /** The interrupt keymap is armed (ADR-0115 §1): a second `Ctrl+C` exits the Home, and the hint says so. */
  readonly interruptArmed?: boolean | undefined;
  /** The run host's snapshot (ADR-0139 §3): the `▶` row shows the active run, and nothing when none is active. */
  readonly hostedRun?: RunHostSnapshot | undefined;
  /** The exit-guard card (ADR-0139 §6), open while the person is asked whether to leave with a run executing. It owns the bottom of
   *  the view, so the prompt and the hint bar are not drawn, and it holds the notice back until it is closed. */
  readonly exitGuard?: ExitGuardPhase | undefined;
  /**
   * The runs of THIS project that are parked ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3, §7): one
   * Attention row each, with the key that opens its card. A run that has a row here is not repeated by the strip's own gate rows or
   * its *Continue* runs. Absent or empty ⇒ no such row.
   */
  readonly parkedRuns?: readonly ParkedRunRow[] | undefined;
  /**
   * The strip row `↓` moved onto, or `undefined` (ADR-0140 §6): a run row (parked, failed or recent) or a session row, named by its identity.
   * The focused row is marked `>` and is always one of the rows drawn; the hint bar says what `Enter` does on it.
   */
  readonly stripFocus?: StripFocus | undefined;
}

const NO_PARKED: readonly ParkedRunRow[] = [];

/**
 * The exit-guard card (ADR-0139 §6): a title line, what leaving does and the keys, each in words so it reads with colour off. It is
 * the same card in the loaded Home, in the loading echo and in the below-minimum degrade.
 */
export function ExitGuardCard(
  props: Readonly<{
    phase: ExitGuardPhase;
    hostedRun: RunHostSnapshot | undefined;
    color: boolean;
  }>,
): ReactElement {
  const lines = exitGuardLines(props.phase, props.hostedRun, HOSTED_RUN_EXIT_BOUND_MS / 1000);
  return (
    <Box flexDirection="column">
      {lines.map((line, row) => (
        <Text
          key={line}
          {...(row === 0 ? colorProps(props.color, 'yellow') : dimProps(props.color))}
          {...(row === 0 ? { bold: true } : {})}
          wrap="truncate-end"
        >
          {line}
        </Text>
      ))}
    </Box>
  );
}

/** A glanceable strip row — a stable `key` (the row's durable id, not its array index) + the rendered line. */
interface StripRow {
  readonly key: string;
  readonly line: string;
  readonly hint?: string;
  readonly selected?: boolean;
}

/** A labeled list section ("Sessions", "Runs", …) — renders nothing when empty so the strip stays compact. An
 *  empty `title` renders just the lines (the attention sub-lists sit under one "Attention required" heading). */
function Section(
  props: Readonly<{ title: string; rows: readonly StripRow[]; color: boolean; tint?: StatusColor }>,
): ReactElement | null {
  if (props.rows.length === 0) return null;
  return (
    <Box flexDirection="column" marginLeft={2}>
      {props.title.length > 0 && (
        <Text {...dimProps(props.color)} wrap="truncate-end">
          {props.title}
        </Text>
      )}
      {props.rows.map((row) => (
        <Box key={row.key} flexDirection="column">
          <Text
            {...(props.tint === undefined ? {} : colorProps(props.color, props.tint))}
            wrap="truncate-end"
          >
            {row.selected === true ? '> ' : '  '}
            {row.line}
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

/**
 * What the hint bar says `Enter` does on the focused parked row: a row with a gate opens it, a media park asks whether to continue the
 * run here, and a run with nothing to answer says why (the bar must not promise a gate where there is none).
 */
function parkedHintCue(kind: ParkedRunKind | undefined): string {
  if (kind === 'none') return 'Enter says why';
  if (kind === 'media') return 'Enter continue it';
  // An input gate's card takes no typed value: it shows how to answer in a shell, and offers a rejection.
  if (kind === 'input') return 'Enter shows how';
  return 'Enter open the gate';
}

/** The one more door the hint bar names while a run can be shown: a parked run, else the saved sessions, else the chat itself. */
function runHintNext(hasParkedRuns: boolean, hasRecentSessions: boolean): string {
  if (hasParkedRuns) return '↓ Open a parked run';
  return hasRecentSessions ? '↓ Continue' : 'type a message to chat';
}

/**
 * The context-aware hint bar of the Home (2.5.C S6): the second `Ctrl+C` while the first is armed, the session picker's keys while one
 * is open, at an empty prompt the `/` palette beside the start-a-chat affordance, and once composing the submit hint.
 */
function homeHint(state: {
  readonly interruptArmed: boolean;
  /** What the focused strip row is (`↓` moved onto it), or `undefined` when none is: it says what `Enter` does on that kind of row. */
  readonly focusedRole: StripRole | undefined;
  readonly emptyDraft: boolean;
  readonly hasRecentSessions: boolean;
  readonly hasParkedRuns: boolean;
  /** What the focused parked row waits on, when that is the focused row: `Enter` opens its gate, or says why it cannot. */
  readonly parkedFocusKind: ParkedRunKind | undefined;
  /** A leg is executing and has a run `Enter` shows (the `▶` row says so too). */
  readonly runCanBeShown: boolean;
  /** No provider key: `Enter` connects one (and keeps what is typed), so the bar says so wherever `Enter` does nothing else first. */
  readonly keyless: boolean;
  /** The draft starts with `/`: a command line, which `Enter` RUNS (a registry word answers, and never opens the setup) whatever the key state. */
  readonly slashDraft: boolean;
}): string {
  if (state.interruptArmed) return 'Press Ctrl+C again to exit';
  if (state.focusedRole === 'parked')
    // The same words as the row's own cue: a row that has no gate to decide says why on `Enter`, and the bar must not promise a gate.
    return `↑/↓ select · ${parkedHintCue(state.parkedFocusKind)} · Esc return to prompt · Ctrl+C twice to exit`;
  if (state.focusedRole === 'session')
    return '↑/↓ select session · Enter resume · Esc return to prompt · Ctrl+C twice to exit';
  // A failed or recent run opens its detail (the run this Home hosts opens its view): read-only either way.
  if (state.focusedRole !== undefined)
    return '↑/↓ select · Enter open the run · Esc return to prompt · Ctrl+C twice to exit';
  // Keyless (ADR-0146 §5): `Enter` opens the provider setup and the message stays in the prompt, so the bar says both. A live run keeps
  // its own hint below, because `Enter` shows the run first.
  if (!state.emptyDraft)
    // A slash line is a command, not a message: `Enter` runs it with or without a key, so the keyless sentence ("your message is kept") would be
    // a promise about something else. It reads the keyed hint.
    return state.keyless && !state.slashDraft
      ? 'Enter to connect a provider · your message is kept'
      : 'Enter to start the chat · Ctrl+J newline · Ctrl+C twice to exit';
  if (state.keyless && !state.runCanBeShown)
    return 'Enter to connect a provider · / commands · Ctrl+C twice to exit';
  if (state.runCanBeShown) {
    // With a run to come back to, `Enter` is the first thing to say; the line keeps one more door, and the chat is one keystroke away anyway.
    const next = runHintNext(state.hasParkedRuns, state.hasRecentSessions);
    return `/ commands · ${HOSTED_RUN_ENTER_CUE} · ${next} · Ctrl+C twice to exit`;
  }
  if (state.hasParkedRuns)
    return '/ commands · ↓ Open a parked run · type a message to chat · Ctrl+C twice to exit';
  return state.hasRecentSessions
    ? '/ commands · ↓ Continue · type a message to chat · Ctrl+C twice to exit'
    : '/ for commands · type a message to start a chat · Ctrl+C twice to exit';
}

export function HomeView(props: Readonly<HomeViewProps>): ReactElement {
  const { snapshot, editor, notice, nowMs, cols, rows, color, paletteOpen } = props;
  const interruptArmed = props.interruptArmed === true;
  const exitGuard = props.exitGuard;
  const parked = props.parkedRuns ?? NO_PARKED;
  const parkedIds = new Set(parked.map((row) => row.runId));
  const focus = props.stripFocus;
  // The focused row, by identity, among the rows the strip lets `↓` reach (the controller keeps its focus on the same list).
  const focusedRow = stripRows(parked, snapshot).find((row) => isFocused(row, focus));
  const focusedParked =
    focusedRow?.role === 'parked' ? parked.find((row) => row.runId === focusedRow.id) : undefined;
  const runFocused = (runId: string): boolean => focus?.kind === 'run' && focus.id === runId;
  const runCanBeShown = hostedRunCanBeShown(props.hostedRun);
  // The standing call to action stays on screen whatever has the focus (ADR-0146 §5): a live run or a focused row takes `Enter` first, and
  // the hint bar below says so in those states, but the line is what tells a keyless person there is a way to start at all.
  const keylessLine = props.keyless === true;
  // Nothing to show means no parked run either: a run of this project that waits on an answer is something to show.
  const isEmpty = homeIsEmpty(snapshot, parked);
  const frame = useRef<DOMElement | null>(null);
  useLayoutEffect(() => {
    props.onFrame?.(frame.current);
  });

  // Below the minimum, render ONLY the resize line (+ the exit affordance) — the RootApp suspends the strip
  // until a resize arrives, so the user must still be able to leave without resizing.
  if (!homeFitsTerminal(cols, rows)) {
    return (
      <Box flexDirection="column">
        <Text {...colorProps(color, 'yellow')} wrap="truncate-end">
          {tooSmallMessage(cols, rows)}
        </Text>
        {exitGuard === undefined ? (
          <Text {...dimProps(color)} wrap="truncate-end">
            {interruptArmed ? 'Press Ctrl+C again to exit' : 'Ctrl+C twice to exit'}
          </Text>
        ) : (
          <ExitGuardCard phase={exitGuard} hostedRun={props.hostedRun} color={color} />
        )}
      </Box>
    );
  }

  // Keyed by each row's durable id (gate: run+gate; run: runId; session: sessionId; agent: slug) — never the
  // array index, so React reconciliation is stable as the strip's contents change between reads.
  // Reserve terminal space for the keyless action and prompt; trim management rows first.
  const showBanner = shouldShowBanner({
    configShowBanner: props.showBanner,
    isEmpty,
    rows,
  });
  const promptHeight = homePromptRows(editor, cols);
  // The `▶` row costs one row above the strip; the exit-guard card takes the place of the prompt block and holds the notice back.
  const runRow = hostedRunLabel(props.hostedRun);
  const runRows = runRow === undefined ? 0 : 1;
  const guardRows =
    exitGuard === undefined
      ? undefined
      : exitGuardLines(exitGuard, props.hostedRun, HOSTED_RUN_EXIT_BOUND_MS / 1000).length;
  const palette = props.palette;
  // The palette asks for its entries, the blank rows between its groups and its chrome; the gaps are the first thing to give way
  // (`paletteLines`), so the budget the strip and the notice leave it is sized with them, and never at the cost of an entry.
  const paletteRows =
    palette === undefined
      ? undefined
      : paletteRowBudget(
          rows,
          palette.list.rows.length,
          paletteGapCount(palette.list.rows.map((entry) => entry.groupStart)),
        );
  // The notice leaves the palette what the prompt block would have left it (`homePromptRows + 3 + keyless`, the notice's own slack included)
  // and the rest of the palette's rows (`paletteRows + 2`: the budget, the unused row and the same slack).
  const keylessRows = keylessLine ? 1 : 0;
  const paletteNoticeRows =
    paletteRows === undefined ? 0 : Math.max(0, paletteRows + 2 - (promptHeight + 3 + keylessRows));
  const noticeLayout = layoutHomeNotice({
    notice: guardRows === undefined ? notice : undefined,
    editor,
    cols,
    rows,
    keyless: keylessLine,
    showBanner: props.showBanner,
    isEmpty,
    hasSessions: snapshot.recentSessions.length > 0,
    ...stripReach(parked, snapshot),
    reservedRows: runRows + paletteNoticeRows,
    ...(props.noticePage === undefined ? {} : { page: props.noticePage }),
  });
  // Reserve all headings/margins and the whole editor before allocating management rows. An open palette takes the prompt's place and the
  // rows `paletteRowBudget` names (and the one row no frame uses): the strip is trimmed to what is left, as it is for a long prompt.
  const promptBlockRows = palette === undefined ? promptHeight + 2 + keylessRows : 0;
  const reservedBelow =
    (guardRows === undefined ? promptBlockRows : guardRows + 1) +
    (paletteRows === undefined ? 0 : paletteRows + 1);
  const welcomeRows = noticeLayout === undefined ? 4 : 0;
  const fixedRows =
    (showBanner ? 4 : 1) +
    runRows +
    (noticeLayout === undefined ? 0 : noticeLayout.rowCount + 1) +
    (isEmpty ? welcomeRows : 1);
  const stripBudget = Math.max(0, rows - reservedBelow - fixedRows);
  let remaining = stripBudget;
  let attentionRemaining = Math.max(
    0,
    remaining - (snapshot.recentSessions.length > 0 ? 4 : 0) - 2,
  );
  // A focused failed run is drawn after the rows above it, so they leave it one row: the focused row is always one of the rows drawn.
  const failedFocusIndex = snapshot.attention.failedRuns.findIndex((run) => runFocused(run.runId));
  let attentionReserve = failedFocusIndex >= 0 ? 1 : 0;
  const takeAttention = <T,>(items: readonly T[], max = attentionRemaining): readonly T[] => {
    const room = Math.max(0, attentionRemaining - attentionReserve);
    const selected = items.slice(0, Math.min(room, max));
    attentionRemaining -= selected.length;
    return selected;
  };
  // The parked runs of this project come first: they are the rows the person can act on from here. The window follows the focus, so the
  // focused row is always one of the rows drawn.
  const parkedFocusIndex = parked.findIndex((row) => runFocused(row.runId));
  const parkedCapacity = Math.max(0, attentionRemaining - attentionReserve);
  const parkedStart = Math.max(0, parkedFocusIndex - parkedCapacity + 1);
  const parkedRows: (StripRow & { readonly overdue: boolean })[] = takeAttention(
    parked.slice(parkedStart),
  ).map((row) => ({
    key: `parked:${row.runId}`,
    line: `${runFocused(row.runId) ? '> ' : '  '}${parkedRunLabel(row, runFocused(row.runId), cols - PARKED_ROW_INDENT_COLUMNS, nowMs)}`,
    overdue: parkedRunOverdue(row, nowMs),
  }));
  const unreadable = takeAttention(snapshot.unreadableRunIds, 3);
  const gateRows = takeAttention(
    snapshot.attention.gates.filter((g) => !parkedIds.has(g.runId)),
  ).map((g) => ({
    key: `${g.runId}:${g.gateId}`,
    line: `⚠ ${gateLabel(g, nowMs)}`,
    expired: gateExpired(g, nowMs),
  }));
  attentionReserve = 0; // the failed runs are the last of the Attention rows: what is left is theirs
  const failedStart = Math.max(0, failedFocusIndex - attentionRemaining + 1);
  const failed: StripRow[] = takeAttention(snapshot.attention.failedRuns.slice(failedStart)).map(
    (r) => ({
      key: r.runId,
      line: `✗ ${runLabel(r, nowMs)}`,
      selected: runFocused(r.runId),
    }),
  );
  const attentionCount = parkedRows.length + unreadable.length + gateRows.length + failed.length;
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
  const sessions: StripRow[] = takeSection(
    snapshot.recentSessions.slice(sessionStart),
    2,
    sessionReserve,
  ).map((s) => ({
    key: s.sessionId,
    line: sessionLabel(s, nowMs),
    hint: sanitizeInline(s.workingDir),
    selected: focus?.kind === 'session' && s.sessionId === focus.id,
  }));
  const runCapacity = Math.max(0, remaining - (continueHeading ? 1 : 2));
  const runStart = Math.max(0, runFocusIndex - runCapacity + 1);
  const runs: StripRow[] = takeSection(recentRuns.slice(runStart)).map((r) => ({
    key: r.runId,
    line: runLabel(r, nowMs),
    selected: runFocused(r.runId),
  }));
  const agents: StripRow[] = takeSection(snapshot.recentAgents).map((a) => ({
    key: a.agentSlug,
    line: agentLabel(a, nowMs),
  }));

  // What the landing above the palette draws, by the very accounting that sized it; the palette may take the rest, less the unused row.
  const bodyRows =
    fixedRows + (stripBudget - remaining) + (guardRows === undefined ? 0 : guardRows + 1);
  const paletteMaxRows = Math.max(PALETTE_MIN_ROWS, rows - 1 - bodyRows);

  // Nothing to show: a welcome in the strip's place, unless a notice (a `/doctor` report) holds its rows.
  const welcome =
    noticeLayout === undefined ? (
      <Box flexDirection="column" marginLeft={2} marginTop={1}>
        <Text {...colorProps(color, 'cyan')} wrap="truncate-end">
          Welcome to Relavium.
        </Text>
        <Text wrap="truncate-end">
          Start an agent chat, then graduate it into a saved workflow.
        </Text>
        <Text {...dimProps(color)} wrap="truncate-end">
          e.g. “summarize the files in this folder”
        </Text>
      </Box>
    ) : null;

  return (
    <Box ref={frame} flexDirection="column">
      {showBanner ? (
        // The banner REPLACES the plain heading rather than sitting above it, so nothing shifts when it is off.
        // `color === false` covers both `NO_COLOR` and `--no-color`, and takes the ASCII glyphs with it (ADR-0068).
        <Box flexDirection="column">
          {bannerLines(cols, !color).map((line) => (
            <Text
              key={line.id}
              {...(line.kind === 'tagline' ? dimProps(color) : colorProps(color, 'cyan'))}
              {...(line.kind === 'wordmark' ? { bold: true } : {})}
              wrap="truncate-end"
            >
              {line.text}
            </Text>
          ))}
        </Box>
      ) : (
        <Text {...colorProps(color, 'cyan')} bold wrap="truncate-end">
          relavium
        </Text>
      )}

      {runRow !== undefined && (
        // The active run, in one line with its state as a word (ADR-0139 §3); nothing at all when no run is active.
        <Box marginLeft={2}>
          <Text {...colorProps(color, 'cyan')} wrap="truncate-end">
            {runRow}
          </Text>
        </Box>
      )}

      {isEmpty ? (
        welcome
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {(parkedRows.length > 0 ||
            gateRows.length > 0 ||
            failed.length > 0 ||
            unreadable.length > 0) && (
            <Box flexDirection="column" marginBottom={1}>
              <Text {...colorProps(color, 'yellow')} wrap="truncate-end">
                Attention required
              </Text>
              <Box flexDirection="column" marginLeft={2}>
                {parkedRows.map((row) => (
                  <Text
                    key={row.key}
                    {...colorProps(color, row.overdue ? 'red' : 'yellow')}
                    wrap="truncate-end"
                  >
                    {row.line}
                  </Text>
                ))}
                {/* #W15-15: a run whose event log cannot be read used to render as an ordinary run with
                    nothing pending. Its gate detail is MISSING, not absent, and the Home is where a user
                    comes to find out which run is broken. */}
                {unreadable.map((runId) => (
                  <Text
                    key={`unreadable-${runId}`}
                    {...colorProps(color, 'red')}
                    wrap="truncate-end"
                  >
                    {'  '}
                    {`⚠ ${unreadableRunLabel(runId)}`}
                  </Text>
                ))}
                {gateRows.map((g) => (
                  <Text
                    key={g.key}
                    {...colorProps(color, g.expired ? 'red' : 'yellow')}
                    wrap="truncate-end"
                  >
                    {'  '}
                    {g.line}
                  </Text>
                ))}
                {failed.map((f) => (
                  <Text key={f.key} {...colorProps(color, 'red')} wrap="truncate-end">
                    {f.selected === true ? '> ' : '  '}
                    {f.line}
                  </Text>
                ))}
              </Box>
            </Box>
          )}
          {(sessions.length > 0 || runs.length > 0 || agents.length > 0) && (
            <>
              <Text {...dimProps(color)} wrap="truncate-end">
                Continue
              </Text>
              <Section title="Sessions" rows={sessions} color={color} />
              <Section title="Runs" rows={runs} color={color} />
              <Section title="Agents" rows={agents} color={color} />
            </>
          )}
        </Box>
      )}

      {noticeLayout !== undefined && (
        // The `/doctor` report — ONE dim Text holding the \n-joined block (no keyed list ⇒ no array-index key,
        // mirroring chat-ink's warnings). NO `wrap="truncate-end"`: cli-truncate would drop whole lines from a
        // multi-line string. Already sanitized at the source (formatDoctorReport).
        <Box marginTop={1} flexDirection="column">
          <Text {...dimProps(color)}>{noticeLayout.lines.join('\n')}</Text>
          {noticeLayout.footer !== undefined && (
            <Text {...dimProps(color)} wrap="truncate-end">
              {noticeLayout.footer}
            </Text>
          )}
        </Box>
      )}

      {exitGuard !== undefined && (
        <Box marginTop={1} flexDirection="column">
          <ExitGuardCard phase={exitGuard} hostedRun={props.hostedRun} color={color} />
        </Box>
      )}

      {paletteOpen !== true && exitGuard === undefined && (
        <Box marginTop={1} flexDirection="column">
          {keylessLine && (
            <Text {...colorProps(color, 'cyan')} wrap="truncate-end">
              No provider key yet · Enter to connect · /providers
            </Text>
          )}
          <PromptEditor editor={editor} color={color} />
          {/* The context-aware Home hint bar (2.5.C S6): at an empty prompt, surface the `/` palette (it only opens
              from an empty buffer) alongside the start-a-chat affordance; once composing, swap to the submit hint
              (which surfaces Ctrl+J for a newline). */}
          <Text {...dimProps(color)} wrap="truncate-end">
            {homeHint({
              interruptArmed,
              focusedRole: focusedRow?.role,
              emptyDraft: editor.text.length === 0,
              hasRecentSessions: snapshot.recentSessions.length > 0,
              hasParkedRuns: parked.length > 0,
              parkedFocusKind: focusedParked?.kind,
              runCanBeShown,
              keyless: props.keyless === true,
              slashDraft: editor.text.startsWith('/'),
            })}
          </Text>
        </Box>
      )}

      {palette !== undefined && (
        <PaletteView
          list={palette.list}
          state={palette.state}
          color={color}
          maxRows={paletteMaxRows}
        />
      )}
    </Box>
  );
}
