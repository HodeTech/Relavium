import { Box } from 'ink';
import { Text } from './text.js';
import type { ReactElement } from 'react';

import { sanitizeInline } from '../sanitize.js';
import { exitKey, legend } from './legend.js';
import type { PaletteEntry } from './palette-entries.js';
import type { PaletteList, PaletteState } from './palette-reducer.js';
import { withGlyphForm } from './glyphs.js';
import { paletteGapCount, paletteLines, paletteRowBudget } from './palette-window.js';
import { colorProps, dimProps } from './projection.js';
import { SelectableNote, SelectableText, selectionMarker } from './selectable-text.js';
import { keepStart } from './status-line.js';
import { displayWidth, inkSafe } from './viewport.js';

/**
 * The interactive `/` command-palette overlay (2.5.C S3b) — a PURE ink view over the palette's rows ({@link PaletteList.rows}), the very list
 * the key fold reads. It owns NO `useInput`: the single raw-mode owner (the standalone `ChatApp` or the Home's `RootApp`) routes keys to
 * {@link reducePaletteKey}/{@link stepPalette} and re-renders this from the resulting {@link PaletteState}. Every rendered free-form field —
 * the query echo, the command name, and its description or reason — is sanitized at the display boundary, so a crafted command name/description
 * or a pasted control sequence can never forge a row or inject an escape.
 *
 * **Direction** (ADR-0145 §7.1): the first row touches the prompt. `down` (the Home) draws the legend last, under the list and its query line
 * first. `up` (a chat) draws the entries reversed (the LAST entry at the top, the FIRST beside the prompt) and NOTHING ELSE: the host draws the
 * typed `/query` on the prompt's own row (the person is typing there) and the legend on the hint row ({@link paletteLegend}), so there is no query
 * line, no legend line and no blank row between the list and the prompt, and the list ends on the row above the prompt (ADR-0146 §4, MVP-11
 * §4.8). `maxRows` is the same budget in both: the most rows the palette takes with what goes with it, which in a chat is the prompt row, the
 * rule and the hint row (so a list of `maxRows − 3` lines).
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
  /**
   * Draw the list alone, whichever way it runs (the landing's list under its prompt): the host draws the query on its own prompt row and the legend
   * on its own row, as a chat's list above the prompt does by its layout. `maxRows` is then the whole block's (the prompt row, the rule, the list
   * and the legend row: the chrome of three rows is the same). Absent ⇒ the layout decides.
   */
  readonly bare?: boolean | undefined;
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

/** What the legend says when nothing matches: there is no entry to select or run, so only the key that closes is named. */
const NO_MATCH_LEGEND = legend([], exitKey.close());

/**
 * The palette's legend: what a chat draws on its hint row while the palette is open (the Home's palette draws the same words on its own legend
 * line). One function, so the two layouts cannot say different things.
 */
export function paletteLegend(list: Pick<PaletteList, 'rows'>): string {
  return list.rows.length === 0 ? NO_MATCH_LEGEND : LEGEND;
}

/**
 * The rows a chat gives its open palette, with its prompt row, rule and hint row: half the terminal, never more than every entry (and every
 * group gap) asks for, never fewer than the least a window with both markers needs and never the whole terminal ({@link paletteRowBudget}), so
 * the transcript above keeps the other half in a full-screen chat and an inline frame stays far short of the terminal's height. The same budget
 * as the landing's, which the palette-fit tests pin.
 */
export function chatPaletteRows(terminalRows: number, list: Pick<PaletteList, 'rows'>): number {
  return paletteRowBudget(
    terminalRows,
    list.rows.length,
    paletteGapCount(list.rows.map((entry) => entry.groupStart)),
  );
}

/**
 * The widest the name column is drawn, the slash included (OB7-L8). A name wider than this is cut with the host's ellipsis, so one long name never
 * pushes every description of the list away from the margin. The longest name a command has today is `/permissions`, twelve columns.
 */
export const PALETTE_NAME_COLUMN_MAX = 16;

/** A command's name as the palette draws it: the slash and the sanitised name. */
const nameLabel = (entry: PaletteEntry): string => `/${sanitizeInline(entry.command.name)}`;

/**
 * The width of the name column of the lines drawn now: the widest NAME of the entries in the window (a name the window hides does not widen it),
 * by display width and never more than {@link PALETTE_NAME_COLUMN_MAX}, so the descriptions of the rows in view start in one column (OB7-L8).
 */
function nameColumnOf(labels: readonly string[]): number {
  return Math.min(PALETTE_NAME_COLUMN_MAX, Math.max(0, ...labels.map(displayWidth)));
}

function EntryRow(
  props: Readonly<{ entry: PaletteEntry; selected: boolean; color: boolean; nameColumn: number }>,
): ReactElement {
  const { entry, selected, color } = props;
  const words = entry.enabled
    ? sanitizeInline(entry.description)
    : `${UNAVAILABLE_PREFIX}${sanitizeInline(entry.reason ?? '')}`;
  // the same cut as every other free text of the chat's chrome: the start kept, the host's one `…`, a wide character never split
  const name = keepStart(nameLabel(entry), props.nameColumn);
  const padding = ' '.repeat(Math.max(0, props.nameColumn - displayWidth(name)));
  return (
    <Text
      {...(selected ? colorProps(color, 'cyan') : entry.enabled ? {} : dimProps(color))}
      wrap="truncate-end"
    >
      <SelectableText selected={selected}>
        {`${selectionMarker(selected, color)} ${name}${padding}  `}
      </SelectableText>
      <Text {...dimProps(color)}>
        {/* the dimmed words of the selected row are inverse with it but not bold: the two contradict, and both close with ESC[22m */}
        <SelectableNote selected={selected}>{words}</SelectableNote>
      </Text>
    </Text>
  );
}

export function PaletteView(props: Readonly<PaletteViewProps>): ReactElement {
  const { list, state, color } = props;
  const rows = list.rows;
  const query = (
    <Text key="query" {...dimProps(color)} wrap="truncate-end">
      {`/${inkSafe(sanitizeInline(state.query))}`}
    </Text>
  );
  const legendLine = (
    <Text key="legend" {...dimProps(color)} wrap="truncate-end">
      {paletteLegend(list)}
    </Text>
  );
  // The lines the window draws, once: the name column is the widest name among the entries IN it.
  const lines = withGlyphForm(!color, () =>
    paletteLines(
      rows.length,
      state.index,
      props.maxRows,
      rows.map((entry) => entry.groupStart),
      list.layout,
    ),
  );
  const nameColumn = nameColumnOf(
    lines.flatMap((line) => {
      const entry = line.kind === 'entry' ? rows[line.index] : undefined;
      return entry === undefined ? [] : [nameLabel(entry)];
    }),
  );
  const body =
    rows.length === 0 ? (
      <Text key="none" {...dimProps(color)} wrap="truncate-end">
        no matching command
      </Text>
    ) : (
      lines.map((line, position) => {
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
            nameColumn={nameColumn}
          />
        );
      })
    );
  // A chat's list is the body alone, directly above the prompt: its query is the prompt's text and its legend is the hint row. The landing's
  // `bare` list is the same body, in the order of its layout, under its prompt.
  if (list.layout === 'up' || props.bare === true) {
    return (
      <Box flexDirection="column" flexShrink={0}>
        {body}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" flexShrink={0} marginTop={1}>
      {[query, body, legendLine]}
    </Box>
  );
}
