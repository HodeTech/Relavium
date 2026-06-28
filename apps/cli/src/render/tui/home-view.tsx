import { Box, Text } from 'ink';
import { type ReactElement } from 'react';

import type { HomeSnapshot } from '../../home/home-store.js';
import { stripTerminalControls } from './chat-projection.js';
import type { StatusColor } from './format.js';
import {
  agentLabel,
  gateLabel,
  homeFitsTerminal,
  runLabel,
  sessionLabel,
  tooSmallMessage,
} from './home-projection.js';
import { colorProps, dimProps } from './projection.js';

/**
 * The PURE render of the bare-invocation Home (2.5.B / ADR-0054): a read-only management strip — an "Attention
 * required" section (pending human gates, then failed runs) above a "Continue" list (recent sessions / runs /
 * agents) — with a live prompt below it. No `useInput`, no state, no store: the single raw-mode owner is the
 * Home's `RootApp`, which passes the snapshot + the prompt buffer + the terminal size + a clock here. Below the
 * 80×24 minimum the whole view degrades to a single resize line (the `RootApp` holds it until a resize). The
 * strip labels come from the unit-tested `home-projection`; the prompt echo is sanitized at this boundary.
 */

interface HomeViewProps {
  readonly snapshot: HomeSnapshot;
  /** The current prompt buffer (owned by the `RootApp`). */
  readonly input: string;
  /** Injected clock for the relative-time labels (the projection is clock-free). */
  readonly nowMs: number;
  readonly cols: number;
  readonly rows: number;
  readonly color: boolean;
}

/** A labeled list section ("Sessions", "Runs", …) — renders nothing when empty so the strip stays compact. An
 *  empty `title` renders just the lines (the attention sub-lists sit under one "Attention required" heading). */
function Section(
  props: Readonly<{ title: string; lines: readonly string[]; color: boolean; tint?: StatusColor }>,
): ReactElement | null {
  if (props.lines.length === 0) return null;
  return (
    <Box flexDirection="column" marginLeft={2}>
      {props.title.length > 0 && <Text {...dimProps(props.color)}>{props.title}</Text>}
      {props.lines.map((line, i) => (
        <Text key={i} {...(props.tint === undefined ? {} : colorProps(props.color, props.tint))}>
          {'  '}
          {line}
        </Text>
      ))}
    </Box>
  );
}

export function HomeView(props: Readonly<HomeViewProps>): ReactElement {
  const { snapshot, input, nowMs, cols, rows, color } = props;

  // Below the minimum, render ONLY the resize line — the RootApp suspends the strip until a resize arrives.
  if (!homeFitsTerminal(cols, rows)) {
    return (
      <Text {...colorProps(color, 'yellow')} wrap="truncate-end">
        {tooSmallMessage(cols, rows)}
      </Text>
    );
  }

  const gates = snapshot.attention.gates.map((g) => `⚠ ${gateLabel(g, nowMs)}`);
  const failed = snapshot.attention.failedRuns.map((r) => `✗ ${runLabel(r, nowMs)}`);
  const sessions = snapshot.recentSessions.map((s) => sessionLabel(s, nowMs));
  const runs = snapshot.recentRuns.map((r) => runLabel(r, nowMs));
  const agents = snapshot.recentAgents.map((a) => agentLabel(a, nowMs));

  return (
    <Box flexDirection="column">
      <Text {...colorProps(color, 'cyan')}>relavium</Text>

      {snapshot.isEmpty ? (
        <Box marginLeft={2} marginTop={1}>
          <Text {...dimProps(color)}>
            No chats or runs yet — type a message below to start your first chat.
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {(gates.length > 0 || failed.length > 0) && (
            <Box flexDirection="column" marginBottom={1}>
              <Text {...colorProps(color, 'yellow')}>Attention required</Text>
              <Section title="" lines={gates} color={color} tint="yellow" />
              <Section title="" lines={failed} color={color} tint="red" />
            </Box>
          )}
          <Text {...dimProps(color)}>Continue</Text>
          <Section title="Sessions" lines={sessions} color={color} />
          <Section title="Runs" lines={runs} color={color} />
          <Section title="Agents" lines={agents} color={color} />
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text {...colorProps(color, 'cyan')}>
          {'> '}
          {stripTerminalControls(input)}
        </Text>
        <Text {...dimProps(color)}>type a message to start a new chat · Ctrl-C to exit</Text>
      </Box>
    </Box>
  );
}
