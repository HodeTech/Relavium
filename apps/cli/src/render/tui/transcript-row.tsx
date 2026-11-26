import type { ReactElement } from 'react';

import { Emph } from './emphasis-view.js';
import { SELECTED_ROW } from './emphasis.js';
import { MarkdownText } from './markdown-text.js';
import { colorProps } from './projection.js';
import type { RowSegments } from './selection.js';
import { Text } from './text.js';
import type { DisplayLine } from './viewport.js';

/**
 * What one display row of the transcript is drawn as, for BOTH renderers: the full-screen viewport (`transcript-viewport.tsx`, which the Home's
 * hosted chat also reaches) and the inline renderer's `TranscriptLine` (`chat-ink.tsx`). One body means the two cannot disagree about a row.
 *
 * **The person's turn** ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §6, OD-18): the host's marker in the
 * accent (cyan, bold) and the words in bold, on every row of the turn; the reply is plain and carries no marker. Bold is not colour, so it is
 * written with colour on and off alike (`emphasis.ts`), and with colour off the marker is the ASCII `>` in bold.
 *
 * **The marker is data, never a reading of the text.** Only the row's `marker` field says the start of its text is the host's marker; a row whose
 * text starts with the same glyph and has no `marker` is drawn as the plain text it is. `wrapEntry` sets the field on the first row of the
 * person's turn and nowhere else, and the guard blanks the glyph from every other row (`transcript-guard.ts`), so neither a reply nor a pasted
 * line can draw a turn by looking like one.
 */

/** One stretch of a person's row that is drawn in one style. */
export interface UserRowPiece {
  readonly text: string;
  /** The stretch is the host's marker (the accent), not the person's words. */
  readonly marker: boolean;
  /** The stretch is inside the mouse selection (drawn inverse, as every selection is). */
  readonly selected: boolean;
}

/**
 * The row's text cut into the stretches that are drawn differently: the host's marker (when the row has one and the text starts with it), and the
 * mouse selection's highlight (a code-unit range of the same text). Every piece is non-empty, the pieces are in order and their texts join to the
 * row's text, so nothing the row says is lost or moved, whatever the selection covers. Pure, so the arrangement is pinned without an ink render.
 */
export function userRowPieces(
  text: string,
  marker: string | undefined,
  selected?: { readonly start: number; readonly end: number },
): readonly UserRowPiece[] {
  const markerEnd =
    marker !== undefined && marker !== '' && text.startsWith(marker) ? marker.length : 0;
  const within = (at: number): number => Math.min(text.length, Math.max(0, at));
  const cuts = new Set<number>([0, text.length, markerEnd]);
  if (selected !== undefined) {
    cuts.add(within(selected.start));
    cuts.add(within(selected.end));
  }
  const ordered = [...cuts].sort((a, b) => a - b);
  const pieces: UserRowPiece[] = [];
  for (let index = 0; index + 1 < ordered.length; index += 1) {
    const start = ordered[index] ?? 0;
    const end = ordered[index + 1] ?? text.length;
    pieces.push({
      text: text.slice(start, end),
      marker: end <= markerEnd,
      selected: selected !== undefined && start >= selected.start && end <= selected.end,
    });
  }
  return pieces;
}

/** The person's row: the marker in the accent and bold, the words in bold, the selection inverse on top. */
function UserRowText(
  props: Readonly<{
    text: string;
    marker: string | undefined;
    color: boolean;
    selected: { readonly start: number; readonly end: number } | undefined;
  }>,
): ReactElement {
  return (
    <>
      {userRowPieces(props.text, props.marker, props.selected).map((piece, index) => {
        const kinds = piece.selected ? SELECTED_ROW : 'bold';
        if (!piece.marker)
          return (
            <Emph key={index} kinds={kinds}>
              {piece.text}
            </Emph>
          );
        return (
          <Text key={index} {...colorProps(props.color, 'cyan')}>
            <Emph kinds={kinds}>{piece.text}</Emph>
          </Text>
        );
      })}
    </>
  );
}

/**
 * The content of one display row, inside the `<Text>` the caller draws for it. `segments` is the row split by the mouse selection (the full-screen
 * viewport's; the inline renderer has no selection), in the row's own text; an empty row is drawn as a space so that it still occupies a row.
 */
export function TranscriptRowBody(
  props: Readonly<{ line: DisplayLine; color: boolean; segments?: RowSegments | undefined }>,
): ReactElement {
  const { line, color, segments } = props;
  const text = line.text === '' ? ' ' : line.text;
  const selected =
    segments === undefined
      ? undefined
      : { start: segments.before.length, end: segments.before.length + segments.selected.length };
  if (line.spans !== undefined)
    return (
      <MarkdownText
        spans={line.spans.length === 0 ? [{ text: ' ' }] : line.spans}
        color={color}
        selected={selected}
      />
    );
  if (line.style === 'user')
    return <UserRowText text={text} marker={line.marker} color={color} selected={selected} />;
  if (segments === undefined) return <>{text}</>;
  return (
    <>
      {segments.before}
      <Emph kinds="inverse">{segments.selected}</Emph>
      {segments.after}
    </>
  );
}
