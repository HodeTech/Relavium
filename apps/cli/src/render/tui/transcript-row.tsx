import type { ReactElement } from 'react';

import type { ChatGrid, MarginForm } from './chat-grid.js';
import { Emph } from './emphasis-view.js';
import { SELECTED_ROW } from './emphasis.js';
import { MarginRow } from './margin-row.js';
import { MarkdownText } from './markdown-text.js';
import { colorProps, transcriptStyleProps } from './projection.js';
import type { RowSegments } from './selection.js';
import { Text } from './text.js';
import type { DisplayLine } from './viewport.js';

/**
 * What one display row of the transcript is drawn as, for BOTH renderers: the full-screen viewport (`transcript-viewport.tsx`, which the Home's
 * hosted chat also reaches) and the inline renderer's `TranscriptLine` (`chat-ink.tsx`). One row means the two cannot disagree about a row.
 *
 * **The grid** ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §6, MVP-11 unit 9): a row is a MARGIN cell and a
 * CONTENT cell side by side. The margin cell is {@link marginCell} of the row's `margin` role (a role of a closed set the host sets, `marginCell`
 * takes no text); the content cell starts at the content column and is the content column wide, and holds the row's text, every word a person or
 * a model wrote. So a reply row that begins with the host's glyph is drawn in the content column, where it is text, and cannot stand where the mark
 * does, whatever it says or however long it is (an over-wide content would wrap inside its own cell, never into the margin).
 *
 * **The person's turn** (OD-18): the host's mark in the accent (cyan, bold) on its first row, and the words in bold on every row of the turn; the
 * reply is plain and its margin is blank (the inline renderer draws the word `agent`). Bold is not colour, so it is written with colour on and off
 * alike (`emphasis.ts`), and with colour off the mark is the ASCII `>` in bold.
 */

/** One stretch of a person's row that is drawn in one style. */
export interface UserRowPiece {
  readonly text: string;
  /** The stretch is inside the mouse selection (drawn inverse, as every selection is). */
  readonly selected: boolean;
}

/**
 * The row's text cut into the stretches that are drawn differently: the mouse selection's highlight (a code-unit range of the same text) and the
 * rest. Every piece is non-empty, the pieces are in order and their texts join to the row's text, so nothing the row says is lost or moved,
 * whatever the selection covers. Pure, so the arrangement is pinned without an ink render.
 */
export function userRowPieces(
  text: string,
  selected?: { readonly start: number; readonly end: number },
): readonly UserRowPiece[] {
  const within = (at: number): number => Math.min(text.length, Math.max(0, at));
  const cuts = new Set<number>([0, text.length]);
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
      selected: selected !== undefined && start >= selected.start && end <= selected.end,
    });
  }
  return pieces;
}

/** The person's row: the words in bold, the selection inverse on top. */
function UserRowText(
  props: Readonly<{
    text: string;
    selected: { readonly start: number; readonly end: number } | undefined;
  }>,
): ReactElement {
  return (
    <>
      {userRowPieces(props.text, props.selected).map((piece, index) => (
        <Emph key={index} kinds={piece.selected ? SELECTED_ROW : 'bold'}>
          {piece.text}
        </Emph>
      ))}
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
  if (line.style === 'user') return <UserRowText text={text} selected={selected} />;
  if (segments === undefined) return <>{text}</>;
  return (
    <>
      {segments.before}
      <Emph kinds="inverse">{segments.selected}</Emph>
      {segments.after}
    </>
  );
}

/**
 * One row of the transcript on the grid: a {@link MarginRow} (the margin cell, absent when the grid has no margin, and the content cell exactly the
 * content column wide). The person's own turn draws its mark in the accent and bold; every other mark takes the row's style (a tool call's `▸`
 * and a notice's lead are dim, as their rows are). `form` is the margin's form (`marginFormFor`): the glyph (or its ASCII form without
 * colour) full-screen, the role word inline. `segments` is the row's text split by the mouse selection (the full-screen viewport's), so a
 * highlight covers the content and never the margin.
 *
 * **One row is one physical row, full-screen** (MVP-11 unit 9, review round 3, R3S-1): the full-screen viewport counts its rows (its scroll
 * geometry, the measured-frame acknowledgement), so its content cell never wraps: a row the layout measures wider than the content column (none
 * should be: the screen's filter runs before the layout) is cut at the cell's edge, never wrapped into a physical row the count does not know.
 * The inline renderer prints a row once into the terminal's history and keeps every word of it: there the cell wraps, inside the content column.
 */
export function TranscriptRow(
  props: Readonly<{
    line: DisplayLine;
    grid: ChatGrid;
    color: boolean;
    form: MarginForm;
    segments?: RowSegments | undefined;
  }>,
): ReactElement {
  const { line, grid, color } = props;
  const accent = line.margin === 'yourTurn' && line.style === 'user';
  return (
    <MarginRow
      role={line.margin}
      grid={grid}
      form={props.form}
      mark={accent ? colorProps(color, 'cyan') : transcriptStyleProps(line.style, color)}
      markEmphasis={accent ? 'bold' : undefined}
    >
      <Text
        {...transcriptStyleProps(line.style, color)}
        wrap={props.form === 'word' ? 'wrap' : 'truncate-end'}
      >
        <TranscriptRowBody line={line} color={color} segments={props.segments} />
      </Text>
    </MarginRow>
  );
}
