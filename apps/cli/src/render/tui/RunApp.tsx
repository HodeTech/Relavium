import { Box, useWindowSize } from 'ink';
import { Text } from './text.js';
import { useSyncExternalStore, type ReactElement } from 'react';

import {
  formatReportedCost,
  formatProducedMedia,
  formatTokens,
  NODE_STATUS_ROLE,
  spinnerFrame,
  statusColor,
} from './format.js';
import {
  blankMarkerGlyphs,
  glyphOf,
  statusCellOf,
  STATUS_WORD_WIDTH,
  withGlyphForm,
  wordOf,
} from './glyphs.js';
import { colorProps, dimProps, nodeSuffix } from './projection.js';
import type { RunStore } from './run-store.js';
import { MAX_ACTIVE_TOKEN_LINES, type NodeView } from './run-view-model.js';
import { sanitizeInline, stripTerminalControls } from '../sanitize.js';
import { screenText } from './screen-text.js';
import { inkRows } from './sheet-frame.js';
import { expandTabs } from './viewport.js';

/**
 * The thin `ink` projection of the {@link RunStore}'s snapshot (workstream **2.E**). It holds NO logic of
 * its own — every value comes from the pure reducer (`run-view-model.ts`), the pure formatters
 * (`format.ts`), and the pure projection helpers (`projection.ts`), all unit-tested without a TTY. It
 * re-renders on the store's (throttled) frame ticks via `useSyncExternalStore`, so a high token rate never
 * floods React. Color is applied only when enabled (`--no-color` passes `color: false` through the snapshot).
 */

function NodeLine(
  props: Readonly<{ node: NodeView; tick: number; useColor: boolean }>,
): ReactElement {
  const { node, tick, useColor } = props;
  const role = NODE_STATUS_ROLE[node.status];
  // A running node animates (the spinner is not a table glyph) in the column the static glyphs use; the others draw the table's glyph, in
  // its plain form when colour is off. The status word stands beside the glyph, and the row is cut at the terminal's edge from the END, so
  // a long node id is what is lost, never the word.
  const mark =
    node.status === 'running'
      ? spinnerFrame(tick).padEnd(statusCellOf(role, !useColor).length)
      : statusCellOf(role, !useColor);
  return (
    <Text {...colorProps(useColor, statusColor(node.status))} wrap="truncate-end">
      {mark} {wordOf(role).padEnd(STATUS_WORD_WIDTH)} {sanitizeInline(node.nodeId)}
      {sanitizeInline(nodeSuffix(node))}
    </Text>
  );
}

export function RunApp(props: Readonly<{ store: RunStore }>): ReactElement {
  const { state, tick, color } = useSyncExternalStore(
    props.store.subscribe,
    props.store.getSnapshot,
  );
  // A model's line (its reasoning, its tokens, a tool line, a warning) through the screen's filter, its marker glyphs blanked (the host's marks are
  // its own, as the chat's rows do) and its tabs spread to the stops a terminal draws, then cut by the layout's measure where ink would count it
  // narrower than a terminal draws it (MVP-11 unit 9, review round 5): ink cuts every other row itself.
  const { columns } = useWindowSize();
  const modelRow = (text: string): string =>
    inkRows(expandTabs(blankMarkerGlyphs(screenText(text))), Math.max(1, columns), 'truncate')[0] ??
    '';

  const activeNode = state.activeNodeId === undefined ? undefined : state.nodes[state.activeNodeId];
  const activeLines =
    state.activeTokens === '' ? [] : state.activeTokens.split('\n').slice(-MAX_ACTIVE_TOKEN_LINES);

  const reasoningLines =
    state.activeReasoning === ''
      ? []
      : state.activeReasoning.split('\n').slice(-MAX_ACTIVE_TOKEN_LINES);

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

      {/* Live-only reasoning has the same bounded rows/control sanitization as answer text. */}
      {activeNode !== undefined && reasoningLines.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text {...dimProps(color)}>thinking · {sanitizeInline(activeNode.nodeId)}</Text>
          {reasoningLines.map((line, i) => (
            <Text key={i} {...dimProps(color)} wrap="truncate-end">
              {modelRow(stripTerminalControls(line))}
            </Text>
          ))}
        </Box>
      ) : null}

      {/* The active node's live token stream (trailing lines) */}
      {activeNode !== undefined && activeLines.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text {...colorProps(color, 'cyan')}>
            {/* the model's id is the provider's text: one row, cut by the layout's measure as the rows below it are (review round 6, I-4) */}
            {modelRow(
              `${glyphOf('activeBar', !color)} ${sanitizeInline(activeNode.nodeId)}${state.activeModel === undefined ? '' : ` · ${sanitizeInline(state.activeModel)}`}`,
            )}
          </Text>
          {/* `truncate-end` bounds each logical line to one terminal row — a newline-free token blast or a
              narrow terminal can't blow the live region up to dozens of wrapped rows (§2.E narrow-terminal). */}
          {activeLines.map((line, i) => (
            <Text key={i} {...dimProps(color)} wrap="truncate-end">
              {modelRow(stripTerminalControls(line))}
            </Text>
          ))}
        </Box>
      ) : null}

      {/* Recent tool activity */}
      {state.toolLines.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {state.toolLines.map((line, i) => (
            <Text key={i} {...dimProps(color)} wrap="truncate-end">
              {modelRow(sanitizeInline(line))}
            </Text>
          ))}
        </Box>
      ) : null}

      {/* Produced media deliverables (handle-only, never bytes) */}
      {state.producedMedia.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {state.producedMedia.map((media) => (
            // The content-addressed handle is unique (the view-model dedups by it) + stable — a sound React key.
            <Text key={media.handle} {...colorProps(color, 'magenta')} wrap="truncate-end">
              {sanitizeInline(withGlyphForm(!color, () => formatProducedMedia(media)))}
            </Text>
          ))}
        </Box>
      ) : null}

      {/* Warnings (gap / budget / gate / timeout) */}
      {state.warnings.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {state.warnings.map((w, i) => (
            <Text key={i} {...colorProps(color, 'yellow')} wrap="truncate-end">
              {modelRow(`${glyphOf('warning', !color)} ${sanitizeInline(w)}`)}
            </Text>
          ))}
        </Box>
      ) : null}

      {/* Running cost footer (and total tokens once the run completes) */}
      <Box marginTop={1}>
        {/* one row however long the id: the footer is cut at the terminal's edge from the end, never wrapped */}
        <Text {...colorProps(color, 'gray')} wrap="truncate-end">
          {state.runId === undefined ? '' : `run ${sanitizeInline(state.runId)}  ·  `}
          cost{' '}
          {formatReportedCost(
            state.cumulativeCostMicrocents,
            state.usageCoverage,
            state.unpricedCalls,
          )}
          {state.summary?.totalTokens === undefined
            ? ''
            : `  ·  ${formatTokens(state.summary.totalTokens)}`}
        </Text>
      </Box>
    </Box>
  );
}
