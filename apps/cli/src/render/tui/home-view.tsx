import { Box, Text } from 'ink';
import { type ReactElement } from 'react';

import type { HomeSnapshot } from '../../home/home-store.js';
import type { EditorState } from './chat-input.js';
import { sanitizeInline } from './chat-projection.js';
import type { StatusColor } from './format.js';
import {
  agentLabel,
  gateExpired,
  gateLabel,
  homeFitsTerminal,
  runLabel,
  sessionLabel,
  tooSmallMessage,
} from './home-projection.js';
import { colorProps, dimProps } from './projection.js';
import { PromptEditor } from './prompt-view.js';

/**
 * The PURE render of the bare-invocation Home (2.5.B / ADR-0054): a read-only management strip — an "Attention
 * required" section (pending human gates, then failed runs) above a "Continue" list (recent sessions / runs /
 * agents) — with a live prompt below it. No `useInput`, no state, no store: the single raw-mode owner is the
 * Home's `RootApp`, which passes the snapshot + the prompt buffer + the terminal size + a clock here. Below the
 * 80×24 minimum the whole view degrades to a single resize line (the `RootApp` holds it until a resize). The
 * strip labels come from the unit-tested `home-projection`; the prompt echo is sanitized at this boundary.
 *
 * Every dynamic row is `wrap="truncate-end"` — a long title / slug / message truncates with an ellipsis at the
 * terminal edge rather than soft-wrapping into a second physical row (which would shatter the glanceable strip),
 * mirroring the sibling run TUI. An overdue (expired) gate is escalated yellow → red so the most time-critical
 * item in "Attention required" catches the eye. A build-failure banner is rendered adjacent to the prompt (not
 * at the top) so it stays in view even when a full strip scrolls the header off a short terminal.
 */

interface HomeViewProps {
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
}

/** A glanceable strip row — a stable `key` (the row's durable id, not its array index) + the rendered line. */
interface StripRow {
  readonly key: string;
  readonly line: string;
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
        <Text
          key={row.key}
          {...(props.tint === undefined ? {} : colorProps(props.color, props.tint))}
          wrap="truncate-end"
        >
          {'  '}
          {row.line}
        </Text>
      ))}
    </Box>
  );
}

export function HomeView(props: Readonly<HomeViewProps>): ReactElement {
  const { snapshot, editor, errorText, notice, nowMs, cols, rows, color, paletteOpen } = props;

  // Below the minimum, render ONLY the resize line (+ the exit affordance) — the RootApp suspends the strip
  // until a resize arrives, so the user must still be able to leave without resizing.
  if (!homeFitsTerminal(cols, rows)) {
    return (
      <Box flexDirection="column">
        <Text {...colorProps(color, 'yellow')} wrap="truncate-end">
          {tooSmallMessage(cols, rows)}
        </Text>
        <Text {...dimProps(color)} wrap="truncate-end">
          Ctrl-C to exit
        </Text>
      </Box>
    );
  }

  // Keyed by each row's durable id (gate: run+gate; run: runId; session: sessionId; agent: slug) — never the
  // array index, so React reconciliation is stable as the strip's contents change between reads.
  const gateRows = snapshot.attention.gates.map((g) => ({
    key: `${g.runId}:${g.gateId}`,
    line: `⚠ ${gateLabel(g, nowMs)}`,
    expired: gateExpired(g, nowMs),
  }));
  const failed: StripRow[] = snapshot.attention.failedRuns.map((r) => ({
    key: r.runId,
    line: `✗ ${runLabel(r, nowMs)}`,
  }));
  const sessions: StripRow[] = snapshot.recentSessions.map((s) => ({
    key: s.sessionId,
    line: sessionLabel(s, nowMs),
  }));
  const runs: StripRow[] = snapshot.recentRuns.map((r) => ({
    key: r.runId,
    line: runLabel(r, nowMs),
  }));
  const agents: StripRow[] = snapshot.recentAgents.map((a) => ({
    key: a.agentSlug,
    line: agentLabel(a, nowMs),
  }));

  return (
    <Box flexDirection="column">
      <Text {...colorProps(color, 'cyan')} bold wrap="truncate-end">
        relavium
      </Text>

      {snapshot.isEmpty ? (
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
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {(gateRows.length > 0 || failed.length > 0) && (
            <Box flexDirection="column" marginBottom={1}>
              <Text {...colorProps(color, 'yellow')} wrap="truncate-end">
                Attention required
              </Text>
              <Box flexDirection="column" marginLeft={2}>
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

      {notice !== undefined && (
        // The `/doctor` report — ONE dim Text holding the \n-joined block (no keyed list ⇒ no array-index key,
        // mirroring chat-ink's warnings). NO `wrap="truncate-end"`: cli-truncate would drop whole lines from a
        // multi-line string. Already sanitized at the source (formatDoctorReport).
        <Box marginTop={1}>
          <Text {...dimProps(color)}>{notice}</Text>
        </Box>
      )}

      {paletteOpen !== true && (
        <Box marginTop={1} flexDirection="column">
          <PromptEditor editor={editor} color={color} />
          {/* The context-aware Home hint bar (2.5.C S6): at an empty prompt, surface the `/` palette (it only opens
              from an empty buffer) alongside the start-a-chat affordance; once composing, swap to the submit hint
              (which surfaces Ctrl+J for a newline). */}
          <Text {...dimProps(color)} wrap="truncate-end">
            {editor.text.length === 0
              ? '/ for commands · type a message to start a chat · Ctrl-C to exit'
              : 'Enter to start the chat · Ctrl+J newline · Ctrl-C to exit'}
          </Text>
        </Box>
      )}
    </Box>
  );
}
