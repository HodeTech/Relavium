import { Box, Text } from 'ink';
import { useSyncExternalStore, type ReactElement } from 'react';

import {
  formatCostUsd,
  formatDuration,
  formatTokens,
  spinnerFrame,
  statusColor,
  statusGlyph,
  type StatusColor,
} from './format.js';
import type { RunStore } from './run-store.js';
import type { NodeView } from './run-view-model.js';

/**
 * The thin `ink` projection of the {@link RunStore}'s snapshot (workstream **2.E**). It holds NO logic of
 * its own — every value comes from the pure reducer (`run-view-model.ts`) and the pure formatters
 * (`format.ts`), both unit-tested without a TTY. It re-renders on the store's (throttled) frame ticks via
 * `useSyncExternalStore`, so a high token rate never floods React. Color is applied only when enabled
 * (`--no-color` passes `color: false` through the snapshot).
 */

/**
 * The `color` prop for an `ink` `<Text>` — present only when color output is enabled (else omitted, so no
 * ANSI). Returned as a spreadable object rather than `color={undefined}` to satisfy
 * `exactOptionalPropertyTypes` (an optional prop may be absent, never explicitly `undefined`).
 */
function colorProps(enabled: boolean, c: StatusColor): { color?: StatusColor } {
  return enabled ? { color: c } : {};
}

function nodeSuffix(node: NodeView): string {
  if (node.status === 'completed' && node.durationMs !== undefined) {
    return ` (${formatDuration(node.durationMs)})`;
  }
  if (node.status === 'failed' && node.errorCode !== undefined) {
    return ` — ${node.errorCode}`;
  }
  if (node.status === 'retrying' && node.attempt !== undefined) {
    return ` (retry ${node.attempt})`;
  }
  return '';
}

function NodeLine(props: { node: NodeView; tick: number; useColor: boolean }): ReactElement {
  const { node, tick, useColor } = props;
  const glyph = node.status === 'running' ? spinnerFrame(tick) : statusGlyph(node.status);
  return (
    <Text {...colorProps(useColor, statusColor(node.status))}>
      {glyph} {node.nodeId}
      {nodeSuffix(node)}
    </Text>
  );
}

export function RunApp(props: { store: RunStore }): ReactElement {
  const { state, tick, color } = useSyncExternalStore(
    props.store.subscribe,
    props.store.getSnapshot,
  );

  const activeNode = state.activeNodeId === undefined ? undefined : state.nodes[state.activeNodeId];
  const activeLines = state.activeTokens === '' ? [] : state.activeTokens.split('\n').slice(-6);

  return (
    <Box flexDirection="column">
      {/* Per-node status list */}
      <Box flexDirection="column">
        {state.nodeOrder.map((id) => {
          const node = state.nodes[id];
          return node === undefined ? null : (
            <NodeLine key={id} node={node} tick={tick} useColor={color} />
          );
        })}
      </Box>

      {/* The active node's live token stream (trailing lines) */}
      {activeNode !== undefined && activeLines.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text {...colorProps(color, 'cyan')}>
            ▌ {activeNode.nodeId}
            {state.activeModel === undefined ? '' : ` · ${state.activeModel}`}
          </Text>
          {activeLines.map((line, i) => (
            <Text key={i} dimColor>
              {line}
            </Text>
          ))}
        </Box>
      ) : null}

      {/* Recent tool activity */}
      {state.toolLines.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {state.toolLines.map((line, i) => (
            <Text key={i} dimColor>
              {line}
            </Text>
          ))}
        </Box>
      ) : null}

      {/* Warnings (gap / budget / gate / timeout) */}
      {state.warnings.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {state.warnings.map((w, i) => (
            <Text key={i} {...colorProps(color, 'yellow')}>
              ⚠ {w}
            </Text>
          ))}
        </Box>
      ) : null}

      {/* Running cost / duration footer */}
      <Box marginTop={1}>
        <Text {...colorProps(color, 'gray')}>
          cost {formatCostUsd(state.cumulativeCostMicrocents)}
          {state.summary?.totalTokens === undefined
            ? ''
            : `  ·  ${formatTokens(state.summary.totalTokens)}`}
        </Text>
      </Box>
    </Box>
  );
}
