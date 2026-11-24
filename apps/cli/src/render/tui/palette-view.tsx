import { Box, Text } from 'ink';
import type { ReactElement } from 'react';

import { sanitizeInline } from './chat-projection.js';
import { exitKey, legend } from './legend.js';
import type { PaletteEntry } from './palette-entries.js';
import type { PaletteList, PaletteState } from './palette-reducer.js';
import { glyphOf, withGlyphForm } from './glyphs.js';
import { paletteLines } from './palette-window.js';
import { colorProps, dimProps } from './projection.js';

/**
 * The interactive `/` command-palette overlay (2.5.C S3b) — a PURE ink view over the palette's rows ({@link PaletteList.rows}), the very list
 * the key fold reads. It owns NO `useInput`: the single raw-mode owner (the standalone `ChatApp` or the Home's `RootApp`) routes keys to
 * {@link reducePaletteKey}/{@link stepPalette} and re-renders this from the resulting {@link PaletteState}. Every rendered free-form field —
 * the query echo, the command name, and its description or reason — is sanitized at the display boundary, so a crafted command name/description
 * or a pasted control sequence can never forge a row or inject an escape.
 *
 * **Direction** (ADR-0145 §7.1): the first row touches the prompt. `down` draws the legend last, under the list and its query line first;
 * `up` (a chat) draws the legend at the top, the entries reversed (the LAST entry at the top, the FIRST beside the query line) and the query
 * echo at the bottom, nearest the prompt.
 */
export interface PaletteViewProps {
  readonly list: PaletteList;
  readonly state: PaletteState;
  readonly color: boolean;
  /**
   * The most rows the whole palette may draw, its gap, query line and legend included. When the matching entries do not all fit, a window of
   * them is drawn ({@link paletteLines}) with a `▲ N more` / `▼ N more` marker for the entries it hides, and the highlighted entry is always
   * inside it. Absent ⇒ every entry is drawn, as it always was.
   */
  readonly maxRows?: number | undefined;
}

/** The words a dim row carries instead of its description: they read without colour (`unavailable · no conversation to clear`). */
const UNAVAILABLE_PREFIX = 'unavailable · ';

/** What the legend says (ADR-0145 §3): `Esc` closes the palette and nothing changes (the draft stays as it was). */
const LEGEND = legend(
  [
    { keys: '↑/↓', verb: 'select' },
    { keys: 'Enter', verb: 'run' },
  ],
  exitKey.close(),
);

function EntryRow(
  props: Readonly<{ entry: PaletteEntry; selected: boolean; color: boolean }>,
): ReactElement {
  const { entry, selected, color } = props;
  const words = entry.enabled
    ? sanitizeInline(entry.description)
    : `${UNAVAILABLE_PREFIX}${sanitizeInline(entry.reason ?? '')}`;
  return (
    <Text
      {...(selected ? colorProps(color, 'cyan') : entry.enabled ? {} : dimProps(color))}
      wrap="truncate-end"
    >
      {`${selected ? glyphOf('selection', !color) : ' '} /${sanitizeInline(entry.command.name)}  `}
      <Text {...dimProps(color)}>{words}</Text>
    </Text>
  );
}

export function PaletteView(props: Readonly<PaletteViewProps>): ReactElement {
  const { list, state, color } = props;
  const rows = list.rows;
  const query = (
    <Text key="query" {...dimProps(color)} wrap="truncate-end">
      {`/${sanitizeInline(state.query)}`}
    </Text>
  );
  const legend = (
    <Text key="legend" {...dimProps(color)} wrap="truncate-end">
      {LEGEND}
    </Text>
  );
  const body =
    rows.length === 0 ? (
      <Text key="none" {...dimProps(color)} wrap="truncate-end">
        no matching command
      </Text>
    ) : (
      withGlyphForm(!color, () =>
        paletteLines(
          rows.length,
          state.index,
          props.maxRows,
          rows.map((entry) => entry.groupStart),
          list.layout,
        ),
      ).map((line, position) => {
        if (line.kind === 'gap') return <Text key={`gap-${String(position)}`}> </Text>;
        if (line.kind === 'marker')
          return (
            <Text key={line.position} {...dimProps(color)} wrap="truncate-end">
              {`  ${line.text}`}
            </Text>
          );
        const entry = rows[line.index];
        if (entry === undefined) return null;
        return (
          <EntryRow
            key={entry.command.name}
            entry={entry}
            selected={line.index === state.index}
            color={color}
          />
        );
      })
    );
  return (
    <Box flexDirection="column" marginTop={1}>
      {list.layout === 'down' ? [query, body, legend] : [legend, body, query]}
    </Box>
  );
}
