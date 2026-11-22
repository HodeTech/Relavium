import { Box, Text, type DOMElement } from 'ink';
import { useLayoutEffect, useRef, type ReactElement } from 'react';

import { layoutColumns } from './layout-columns.js';
import { colorProps, dimProps } from './projection.js';
import {
  projectRunCard,
  type RunCardProjection,
  type RunCardRole,
  type RunCardRow,
  type RunCardSnapshot,
} from './run-card-model.js';

/**
 * The Home's human-gate card as the terminal shows it
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §4): a PURE ink view over
 * {@link projectRunCard}. It owns no `useInput` (the Home's one input owner routes keys to the card) and no state.
 *
 * - **A glyph and a word for every state**, in the title row; colour only reinforces them, so the card reads the same under
 *   `NO_COLOR`.
 * - **The author's message sits behind the host's `│ ` gutter** and is the only text there; the card's own words never do.
 * - **Below 80×24** the card is the enlarge line and the key line, and no key answers.
 * - **`onFrame`** receives the card's box after every commit, the way the Home's landing hands its own to the measured-frame
 *   acknowledgement: the dwell before `Ctrl+Y` counts only from a frame that was measured and flushed.
 */
export interface RunCardViewProps {
  readonly snapshot: RunCardSnapshot;
  readonly columns: number;
  readonly rows: number;
  /** Wall-clock milliseconds: the only clock the card reads, for the overdue words. */
  readonly nowMs: number;
  readonly color: boolean;
  readonly onFrame?: ((node: DOMElement | null) => void) | undefined;
}

function rowProps(
  color: boolean,
  row: RunCardRow,
  projection: RunCardProjection,
): Record<string, unknown> {
  const role: RunCardRole = row.role;
  switch (role) {
    case 'title':
      return color ? { color: projection.tone, bold: true } : {};
    case 'warn':
      return colorProps(color, 'yellow');
    case 'cursor':
      return color ? { color: 'cyan', bold: true } : {};
    case 'note':
      return projection.state === 'not-answered' ? colorProps(color, 'red') : {};
    case 'fact':
    case 'keys':
      return dimProps(color);
    case 'author':
    case 'list':
      return {};
  }
}

export function RunCardView(props: Readonly<RunCardViewProps>): ReactElement {
  const frame = useRef<DOMElement | null>(null);
  useLayoutEffect(() => {
    props.onFrame?.(frame.current);
  });
  const projection = projectRunCard(props.snapshot, {
    columns: props.columns,
    rows: props.rows,
    nowMs: props.nowMs,
  });
  const { color } = props;
  return (
    <Box ref={frame} flexDirection="column" width={layoutColumns(props.columns)}>
      {projection.tooSmall !== undefined && (
        <Text {...colorProps(color, 'yellow')} wrap="truncate-end">
          {projection.tooSmall}
        </Text>
      )}
      {projection.rows.map((row, index) => (
        <Text
          key={`${String(index)}:${row.role}:${row.text}`}
          {...rowProps(color, row, projection)}
          wrap="truncate-end"
        >
          {row.text}
        </Text>
      ))}
    </Box>
  );
}
