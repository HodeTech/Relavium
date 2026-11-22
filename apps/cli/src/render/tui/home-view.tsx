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
  hostedRunLabel,
  runLabel,
  sessionLabel,
  tooSmallMessage,
  unreadableRunLabel,
  type ExitGuardPhase,
} from './home-projection.js';
import { colorProps, dimProps } from './projection.js';
import { PromptEditor } from './prompt-view.js';
import { homePromptRows, layoutHomeNotice } from './home-notice.js';
import { HOSTED_RUN_EXIT_GRACE_MS } from './tui-constants.js';

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
 * item in "Attention required" catches the eye. A build-failure banner is rendered adjacent to the prompt (not
 * at the top) so it stays in view even when a full strip scrolls the header off a short terminal.
 */

interface HomeViewProps {
  readonly onFrame?: ((node: DOMElement | null) => void) | undefined;
  readonly snapshot: HomeSnapshot;
  /** The current prompt editor — text + cursor (owned by the `RootApp`). */
  readonly editor: EditorState;
  /** A build-failure message to show above the prompt (cleared on the next submit / a clean return). */
  readonly errorText?: string | undefined;
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
  /** `[preferences].show_banner` (2.6.F Step 5g). `undefined` ⇒ `shouldShowBanner`'s empty-Home rule. */
  readonly showBanner?: boolean | undefined;
  /** Cached key availability, sampled by the host on opening and changes. */
  readonly keyless?: boolean;
  readonly continueSessionId?: string | undefined;
  readonly noticePage?: number;
  /** The interrupt keymap is armed (ADR-0115 §1): a second `Ctrl+C` exits the Home, and the hint says so. */
  readonly interruptArmed?: boolean | undefined;
  /** The run host's snapshot (ADR-0139 §3): the `▶` row shows the active run, and nothing when none is active. */
  readonly hostedRun?: RunHostSnapshot | undefined;
  /** The exit-guard card (ADR-0139 §6), open while the person is asked whether to leave with a run executing. It owns the bottom of
   *  the view, so the prompt and the hint bar are not drawn, and it holds the notice back until it is closed. */
  readonly exitGuard?: ExitGuardPhase | undefined;
}

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
  const lines = exitGuardLines(props.phase, props.hostedRun, HOSTED_RUN_EXIT_GRACE_MS / 1000);
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
 * The context-aware hint bar of the Home (2.5.C S6): the second `Ctrl+C` while the first is armed, the session picker's keys while one
 * is open, at an empty prompt the `/` palette beside the start-a-chat affordance, and once composing the submit hint.
 */
function homeHint(state: {
  readonly interruptArmed: boolean;
  readonly resuming: boolean;
  readonly emptyDraft: boolean;
  readonly hasRecentSessions: boolean;
}): string {
  if (state.interruptArmed) return 'Press Ctrl+C again to exit';
  if (state.resuming)
    return '↑/↓ select session · Enter resume · Esc return to prompt · Ctrl+C twice to exit';
  if (!state.emptyDraft) return 'Enter to start the chat · Ctrl+J newline · Ctrl+C twice to exit';
  return state.hasRecentSessions
    ? '/ commands · ↓ Continue · type a message to chat · Ctrl+C twice to exit'
    : '/ for commands · type a message to start a chat · Ctrl+C twice to exit';
}

export function HomeView(props: Readonly<HomeViewProps>): ReactElement {
  const { snapshot, editor, errorText, notice, nowMs, cols, rows, color, paletteOpen } = props;
  const interruptArmed = props.interruptArmed === true;
  const exitGuard = props.exitGuard;
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
    isEmpty: snapshot.isEmpty,
    rows,
  });
  const promptHeight = homePromptRows(editor, cols);
  // The `▶` row costs one row above the strip; the exit-guard card takes the place of the prompt block and holds the notice back.
  const runRow = hostedRunLabel(props.hostedRun);
  const runRows = runRow === undefined ? 0 : 1;
  const guardRows =
    exitGuard === undefined
      ? undefined
      : exitGuardLines(exitGuard, props.hostedRun, HOSTED_RUN_EXIT_GRACE_MS / 1000).length;
  const noticeLayout = layoutHomeNotice({
    notice: guardRows === undefined ? notice : undefined,
    editor,
    cols,
    rows,
    keyless: props.keyless === true,
    errorText,
    showBanner: props.showBanner,
    isEmpty: snapshot.isEmpty,
    hasSessions: snapshot.recentSessions.length > 0,
    reservedRows: runRows,
    ...(props.noticePage === undefined ? {} : { page: props.noticePage }),
  });
  // Reserve all headings/margins and the whole editor before allocating management rows.
  let remaining = Math.max(
    0,
    rows -
      (showBanner ? 4 : 1) -
      (guardRows === undefined
        ? promptHeight + 2 + (props.keyless === true ? 1 : 0)
        : guardRows + 1) -
      runRows -
      (errorText === undefined ? 0 : 2) -
      (noticeLayout === undefined ? 0 : noticeLayout.rowCount + 1) -
      (snapshot.isEmpty ? (noticeLayout === undefined ? 4 : 0) : 1),
  );
  let attentionRemaining = Math.max(
    0,
    remaining - (snapshot.recentSessions.length > 0 ? 4 : 0) - 2,
  );
  const takeAttention = <T,>(items: readonly T[], max = attentionRemaining): readonly T[] => {
    const selected = items.slice(0, Math.min(attentionRemaining, max));
    attentionRemaining -= selected.length;
    return selected;
  };
  const unreadable = takeAttention(snapshot.unreadableRunIds, 3);
  const gateRows = takeAttention(snapshot.attention.gates).map((g) => ({
    key: `${g.runId}:${g.gateId}`,
    line: `⚠ ${gateLabel(g, nowMs)}`,
    expired: gateExpired(g, nowMs),
  }));
  const failed: StripRow[] = takeAttention(snapshot.attention.failedRuns).map((r) => ({
    key: r.runId,
    line: `✗ ${runLabel(r, nowMs)}`,
  }));
  const attentionCount = unreadable.length + gateRows.length + failed.length;
  if (attentionCount > 0) remaining -= attentionCount + 2;
  let continueHeading = false;
  const takeSection = <T,>(items: readonly T[], cost = 1): readonly T[] => {
    const chrome = continueHeading ? 1 : 2;
    const selected = items.slice(0, Math.max(0, Math.floor((remaining - chrome) / cost)));
    if (selected.length > 0) {
      remaining -= chrome + selected.length * cost;
      continueHeading = true;
    }
    return selected;
  };
  const sessionCapacity = Math.max(0, Math.floor((remaining - 2) / 2));
  const focusedIndex = snapshot.recentSessions.findIndex(
    (s) => s.sessionId === props.continueSessionId,
  );
  const sessionStart = Math.max(0, focusedIndex - sessionCapacity + 1);
  const sessions: StripRow[] = takeSection(snapshot.recentSessions.slice(sessionStart), 2).map(
    (s) => ({
      key: s.sessionId,
      line: sessionLabel(s, nowMs),
      hint: sanitizeInline(s.workingDir),
      selected: s.sessionId === props.continueSessionId,
    }),
  );
  const runs: StripRow[] = takeSection(snapshot.recentRuns).map((r) => ({
    key: r.runId,
    line: runLabel(r, nowMs),
  }));
  const agents: StripRow[] = takeSection(snapshot.recentAgents).map((a) => ({
    key: a.agentSlug,
    line: agentLabel(a, nowMs),
  }));

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

      {snapshot.isEmpty ? (
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
        ) : null
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {(gateRows.length > 0 || failed.length > 0 || unreadable.length > 0) && (
            <Box flexDirection="column" marginBottom={1}>
              <Text {...colorProps(color, 'yellow')} wrap="truncate-end">
                Attention required
              </Text>
              <Box flexDirection="column" marginLeft={2}>
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
                    {'  '}
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

      {errorText !== undefined && (
        <Box marginTop={1}>
          <Text {...colorProps(color, 'red')} wrap="truncate-end">
            couldn’t start the chat: {sanitizeInline(errorText)}
          </Text>
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
          {props.keyless === true && (
            <Text {...colorProps(color, 'yellow')} wrap="truncate-end">
              Connect a provider to start chatting — Enter to set up or /providers.
            </Text>
          )}
          <PromptEditor editor={editor} color={color} />
          {/* The context-aware Home hint bar (2.5.C S6): at an empty prompt, surface the `/` palette (it only opens
              from an empty buffer) alongside the start-a-chat affordance; once composing, swap to the submit hint
              (which surfaces Ctrl+J for a newline). */}
          <Text {...dimProps(color)} wrap="truncate-end">
            {homeHint({
              interruptArmed,
              resuming: props.continueSessionId !== undefined,
              emptyDraft: editor.text.length === 0,
              hasRecentSessions: snapshot.recentSessions.length > 0,
            })}
          </Text>
        </Box>
      )}
    </Box>
  );
}
