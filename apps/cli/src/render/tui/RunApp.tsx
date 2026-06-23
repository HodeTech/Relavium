import { Box, Text } from 'ink';
import { useSyncExternalStore, type ReactElement } from 'react';

import { formatCostUsd, formatTokens, spinnerFrame, statusColor, statusGlyph } from './format.js';
import { colorProps, dimProps, nodeSuffix } from './projection.js';
import type { RunStore } from './run-store.js';
import { MAX_ACTIVE_TOKEN_LINES, type NodeView } from './run-view-model.js';

/**
 * The thin `ink` projection of the {@link RunStore}'s snapshot (workstream **2.E**). It holds NO logic of
 * its own — every value comes from the pure reducer (`run-view-model.ts`), the pure formatters
 * (`format.ts`), and the pure projection helpers (`projection.ts`), all unit-tested without a TTY. It
 * re-renders on the store's (throttled) frame ticks via `useSyncExternalStore`, so a high token rate never
 * floods React. Color is applied only when enabled (`--no-color` passes `color: false` through the snapshot).
 */

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
  const activeLines =
    state.activeTokens === '' ? [] : state.activeTokens.split('\n').slice(-MAX_ACTIVE_TOKEN_LINES);

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
          {/* `truncate-end` bounds each logical line to one terminal row — a newline-free token blast or a
              narrow terminal can't blow the live region up to dozens of wrapped rows (§2.E narrow-terminal). */}
          {activeLines.map((line, i) => (
            <Text key={i} {...dimProps(color)} wrap="truncate-end">
              {line}
            </Text>
          ))}
        </Box>
      ) : null}

      {/* Recent tool activity */}
      {state.toolLines.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {state.toolLines.map((line, i) => (
            <Text key={i} {...dimProps(color)} wrap="truncate-end">
              {line}
            </Text>
          ))}
        </Box>
      ) : null}

      {/* Warnings (gap / budget / gate / timeout) */}
      {state.warnings.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {state.warnings.map((w, i) => (
            <Text key={i} {...colorProps(color, 'yellow')} wrap="truncate-end">
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
