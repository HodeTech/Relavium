import { sanitizeInline } from '../sanitize.js';
import { displayWidth } from '../tui/viewport.js';
import { highlightCode } from './highlight/index.js';
import { parseInline } from './inline.js';
import type { MarkdownBlock, MarkdownDisplayLine, MarkdownSpan } from './types.js';

function appendRows(target: MarkdownDisplayLine[], rows: readonly MarkdownDisplayLine[]): void {
  for (const row of rows) target.push(row);
}
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function sameStyle(left: MarkdownSpan, right: MarkdownSpan): boolean {
  return (
    Boolean(left.strong) === Boolean(right.strong) &&
    Boolean(left.emphasis) === Boolean(right.emphasis) &&
    Boolean(left.code) === Boolean(right.code) &&
    Boolean(left.strike) === Boolean(right.strike) &&
    left.heading === right.heading &&
    Boolean(left.quote) === Boolean(right.quote) &&
    Boolean(left.dim) === Boolean(right.dim) &&
    left.linkURL === right.linkURL &&
    left.token === right.token
  );
}

/**
 * A fenced block's text as spans. A block whose info string names a supported language is classed by the highlighter
 * (ADR-0144), which only splits the text; any other block stays one plain code span, as it always was.
 */
function codeSpans(block: MarkdownBlock): MarkdownSpan[] {
  const segments = highlightCode(block.text, block.highlightInfo ?? block.info);
  if (!segments) return [{ text: block.text, code: true }];
  return segments.map((segment) => ({ text: segment.text, code: true, token: segment.token }));
}

/** Merge only adjacent equal styles; text and grapheme ownership stay unchanged. */
function line(spans: readonly MarkdownSpan[]): MarkdownDisplayLine {
  const merged: MarkdownSpan[] = [];
  let style: MarkdownSpan | undefined;
  let pieces: string[] = [];
  const flush = (): void => {
    if (style) merged.push({ ...style, text: pieces.join('') });
    style = undefined;
    pieces = [];
  };
  for (const span of spans) {
    if (!span.text) continue;
    if (style && !sameStyle(style, span)) flush();
    style ??= span;
    pieces.push(span.text);
  }
  flush();
  return { text: merged.map((span) => span.text).join(''), spans: merged };
}
function wrap(
  spans: readonly MarkdownSpan[],
  columns: number,
  firstPrefix = '',
  continuation = firstPrefix,
  tabOffset = 0,
  dropBreakSpace = false,
): MarkdownDisplayLine[] {
  if (columns < 1 || !Number.isFinite(columns)) return [];
  const limit = Math.trunc(columns);
  const full = spans.map((span) => span.text).join('');
  const offsets: number[] = [];
  let offset = 0;
  for (const span of spans) {
    offset += span.text.length;
    offsets.push(offset);
  }
  const logical: MarkdownSpan[][] = [[]];
  let logicalColumn =
    displayWidth(firstPrefix) +
    (Number.isFinite(tabOffset) ? Math.max(0, Math.trunc(tabOffset)) : 0);
  let spanIndex = 0;
  for (const item of segmenter.segment(full)) {
    while ((offsets[spanIndex] ?? Infinity) <= item.index) spanIndex++;
    const style = spans[spanIndex] ?? { text: '' };
    if (item.segment === '\n') {
      logical.push([]);
      logicalColumn = displayWidth(continuation);
      continue;
    }
    if (item.segment === '\t') {
      const spaces = 8 - (logicalColumn % 8);
      for (let count = 0; count < spaces; count++)
        logical[logical.length - 1]?.push({ ...style, text: ' ' });
      logicalColumn += spaces;
    } else {
      logical[logical.length - 1]?.push({ ...style, text: item.segment });
      logicalColumn += displayWidth(item.segment);
    }
  }
  const result: MarkdownDisplayLine[] = [];
  let prefix = firstPrefix;
  for (const group of logical) {
    if (!group.length) {
      result.push(line(prefix ? [{ text: prefix, dim: true }] : []));
      prefix = continuation;
      continue;
    }
    let start = 0;
    while (start < group.length) {
      // A line the wrap broke at a space starts at its text: the space was the break, not content. A line the source
      // broke keeps its indentation, which is why only a wrap-created continuation (start > 0) is trimmed.
      if (dropBreakSpace && start > 0)
        while (start < group.length && /^\s+$/u.test(group[start]?.text ?? '')) start++;
      if (start >= group.length) break;
      const available = limit - displayWidth(prefix);
      let end = start;
      let width = 0;
      let boundary = start;
      while (end < group.length) {
        const item = group[end];
        if (!item) break;
        const originalWidth = displayWidth(item.text);
        const cellWidth = originalWidth > available ? 1 : originalWidth;
        if (width + cellWidth > available) break;
        width += cellWidth;
        end++;
        if (/^\s+$/u.test(item.text)) boundary = end;
      }
      if (end < group.length && !/^\s+$/u.test(group[end]?.text ?? '') && boundary > start)
        end = boundary;
      if (end === start) end++;
      const pieces: MarkdownSpan[] = prefix ? [{ text: prefix, dim: true }] : [];
      for (let at = start; at < end; at++) {
        const item = group[at];
        if (!item) continue;
        pieces.push(displayWidth(item.text) > available ? { ...item, text: '?' } : item);
      }
      result.push(line(pieces));
      prefix = continuation;
      start = end;
    }
  }
  return result;
}
function expandCell(spans: readonly MarkdownSpan[], start: number): MarkdownSpan[] {
  const text = spans.map((span) => span.text).join('');
  const offsets: number[] = [];
  let end = 0;
  for (const span of spans) {
    end += span.text.length;
    offsets.push(end);
  }
  let spanIndex = 0;
  let column = start;
  const result: MarkdownSpan[] = [];
  for (const item of segmenter.segment(text)) {
    while ((offsets[spanIndex] ?? Infinity) <= item.index) spanIndex++;
    const style = spans[spanIndex] ?? { text: '' };
    const expanded = item.segment === '\t' ? ' '.repeat(8 - (column % 8)) : item.segment;
    result.push({ ...style, text: expanded });
    column += displayWidth(expanded);
  }
  return result;
}
/**
 * `'no-fit'`: the table is well formed, but its aligned grid cannot be drawn at this width or tab phase, so it
 * becomes a wrapped grid, or records below the floors (ADR-0143). `undefined` keeps the table literal: no rows, or a hard
 * break inside a cell.
 */
function table(
  block: MarkdownBlock,
  columns: number,
  contentPrefixWidth: number,
): MarkdownDisplayLine[] | 'no-fit' | undefined {
  const rows = block.rows;
  if (!rows?.length) return undefined;
  const source = rows.map((row) => row.map((cell) => parseInline(cell)));
  if (source.some((row) => row.some((cell) => cell.some((span) => span.text.includes('\n')))))
    return undefined;
  const rendered: MarkdownSpan[][][] = source.map(() => []);
  const widths: number[] = [];
  let columnStart = contentPrefixWidth + 2;
  for (let column = 0; column < (rows[0]?.length ?? 0); column++) {
    const alignment = block.align?.[column] ?? 'left';
    const period = alignment === 'center' ? 16 : 8;
    // Each residue stores the smallest admissible width for every row seen so far.
    const bounds = Array<number>(period).fill(0);
    const measures: number[][] = [];
    for (const row of source) {
      const cell = row[column] ?? [];
      const text = cell.map((span) => span.text).join('');
      const widthsByStart = text.includes('\t')
        ? Array.from({ length: 8 }, (_, residue) =>
            displayWidth(
              expandCell(cell, residue)
                .map((span) => span.text)
                .join(''),
            ),
          )
        : Array<number>(8).fill(displayWidth(text));
      measures.push(widthsByStart);
      const possible = Array<number>(period).fill(Infinity);
      if (alignment === 'left') {
        possible.fill(widthsByStart[columnStart % 8] ?? 0);
      } else {
        for (let residue = 0; residue < 8; residue++) {
          const offset = (residue - (columnStart % 8) + 8) % 8;
          const measured = widthsByStart[residue] ?? 0;
          const base = measured + (alignment === 'center' ? 2 * offset : offset);
          const variants = alignment === 'center' ? 2 : 1;
          for (let parity = 0; parity < variants; parity++) {
            const minimum = base + parity;
            const key = minimum % period;
            possible[key] = Math.min(possible[key] ?? Infinity, minimum);
          }
        }
      }
      for (let residue = 0; residue < period; residue++)
        bounds[residue] = Math.max(bounds[residue] ?? 0, possible[residue] ?? Infinity);
    }
    let width = Infinity;
    for (let residue = 0; residue < period; residue++) {
      const minimum = bounds[residue] ?? Infinity;
      if (Number.isFinite(minimum))
        width = Math.min(width, minimum + ((residue - (minimum % period) + period) % period));
    }
    if (!Number.isFinite(width)) return 'no-fit';
    widths.push(width);
    for (let row = 0; row < source.length; row++) {
      const cell = source[row]?.[column] ?? [];
      const starts = measures[row] ?? [];
      let before = 0;
      if (alignment !== 'left') {
        const match = starts.findIndex((measured, residue) => {
          const padding = width - measured;
          const leading = alignment === 'right' ? padding : Math.floor(padding / 2);
          return padding >= 0 && (columnStart + leading) % 8 === residue;
        });
        if (match < 0) return 'no-fit';
        const padding = width - (starts[match] ?? 0);
        before = alignment === 'right' ? padding : Math.floor(padding / 2);
      }
      rendered[row]?.push(expandCell(cell, columnStart + before));
    }
    columnStart += width + 3;
  }
  if (widths.reduce((a, b) => a + b + 3, 1) > columns) return 'no-fit';
  const border = (left: string, mid: string, right: string): MarkdownDisplayLine =>
    line([{ text: left + widths.map((w) => '─'.repeat(w + 2)).join(mid) + right, dim: true }]);
  const output = [border('┌', '┬', '┐')];
  rendered.forEach((row, index) => {
    const spans: MarkdownSpan[] = [{ text: '│', dim: true }];
    row.forEach((cell, column) => {
      const width = displayWidth(cell.map((s) => s.text).join(''));
      const padding = (widths[column] ?? 0) - width;
      const alignment = block.align?.[column] ?? 'left';
      const before =
        alignment === 'right' ? padding : alignment === 'center' ? Math.floor(padding / 2) : 0;
      spans.push({ text: ' '.repeat(before + 1) });
      spans.push(...cell.map((s) => (index === 0 ? { ...s, strong: true } : s)));
      spans.push({ text: ' '.repeat(padding - before + 1) }, { text: '│', dim: true });
    });
    output.push(line(spans));
    if (index === 0) output.push(border('├', '┼', '┤'));
  });
  output.push(border('└', '┴', '┘'));
  return output;
}
/** A column never narrows below this, unless its longest word is shorter (ADR-0143). */
const CELL_FLOOR = 8;
/** A column's floor follows its longest word up to this many columns; a longer word breaks instead (ADR-0143). */
const CELL_WORD_CAP = 24;

function cellText(spans: readonly MarkdownSpan[]): string {
  return spans.map((span) => span.text).join('');
}

/** The display width of the longest run of non-space text in a cell. */
function longestCellWord(spans: readonly MarkdownSpan[]): number {
  let longest = 0;
  for (const word of cellText(spans).split(/\s+/u)) longest = Math.max(longest, displayWidth(word));
  return longest;
}

/**
 * Removes the spaces a wrap leaves at the end of a line: the space it broke at stays on the previous line, and counting
 * it would pull a right-aligned or centred cell one column off. A plain loop, so a long run of spaces stays linear.
 */
function stripTrailingSpace(spans: readonly MarkdownSpan[]): MarkdownSpan[] {
  const result = [...spans];
  while (result.length > 0) {
    const last = result[result.length - 1];
    if (last === undefined) break;
    let end = last.text.length;
    while (end > 0 && /\s/u.test(last.text.charAt(end - 1))) end--;
    if (end === last.text.length) break;
    if (end > 0) {
      result[result.length - 1] = { ...last, text: last.text.slice(0, end) };
      break;
    }
    result.pop();
  }
  return result;
}

/** The width of the widest grapheme cluster in a cell: a column can never be narrower than one cluster. */
function widestGrapheme(spans: readonly MarkdownSpan[]): number {
  let widest = 0;
  for (const { segment } of segmenter.segment(cellText(spans)))
    widest = Math.max(widest, displayWidth(segment));
  return widest;
}

/** Removes the spaces a wrap leaves at the start of a continuation line; cell text is never indented. */
function stripLeadingSpace(spans: readonly MarkdownSpan[]): MarkdownSpan[] {
  const result = [...spans];
  while (result.length > 0) {
    const first = result[0];
    if (first === undefined) break;
    const rest = first.text.replace(/^\s+/u, '');
    if (rest.length === first.text.length) break;
    if (rest.length > 0) {
      result[0] = { ...first, text: rest };
      break;
    }
    result.shift();
  }
  return result;
}

/**
 * A table too wide for one line keeps its grid, with each cell wrapped to its column (ADR-0143). A row is as tall as
 * its tallest cell. The columns give up the excess in proportion to how far each sits above its floor, so no column
 * drops below its floor and no text is cropped or lost. Alignment applies to every wrapped line. Returns `undefined`
 * when the floors do not fit, which hands the table to records. A header-only table, a hard break in a cell, and a
 * width too narrow for any record value stay literal, as before.
 */
function wrappedGrid(block: MarkdownBlock, columns: number): MarkdownDisplayLine[] | undefined {
  const rows = block.rows ?? [];
  if (rows.length < 2) return undefined;
  const cells = rows.map((row) => row.map((cell) => expandCell(parseInline(cell), 0)));
  const count = cells[0]?.length ?? 0;
  const budget = columns - (1 + 3 * count);
  if (count === 0 || budget < count) return undefined;
  const padded = cells.map((row) =>
    Array.from({ length: count }, (_, column) => row[column] ?? []),
  );

  const natural: number[] = [];
  const floors: number[] = [];
  for (let column = 0; column < count; column++) {
    let width = 1;
    let word = 0;
    let grapheme = 0;
    for (const row of padded) {
      const cell = row[column] ?? [];
      width = Math.max(width, displayWidth(cellText(cell)));
      word = Math.max(word, longestCellWord(cell));
      grapheme = Math.max(grapheme, widestGrapheme(cell));
    }
    natural.push(width);
    // A grapheme wider than the word cap still needs its whole column, or wrap would replace it with '?'.
    floors.push(Math.min(width, Math.max(CELL_FLOOR, Math.min(word, CELL_WORD_CAP), grapheme)));
  }
  const floorSum = floors.reduce((sum, floor) => sum + floor, 0);
  if (floorSum > budget) return undefined;

  const widths = [...natural];
  const naturalSum = natural.reduce((sum, width) => sum + width, 0);
  if (naturalSum > budget) {
    // The floors fit, so the room above them is at least the excess and the proportional shares never overdraw it.
    const headroom = natural.map((width, column) => width - (floors[column] ?? width));
    const room = headroom.reduce((sum, spare) => sum + spare, 0);
    const excess = naturalSum - budget;
    const share = headroom.map((spare) => Math.floor((excess * spare) / room));
    let rest = excess - share.reduce((sum, taken) => sum + taken, 0);
    for (let column = 0; rest > 0 && column < count; column++) {
      const spare = (headroom[column] ?? 0) - (share[column] ?? 0);
      const take = Math.min(spare, rest);
      share[column] = (share[column] ?? 0) + take;
      rest -= take;
    }
    for (let column = 0; column < count; column++)
      widths[column] = (natural[column] ?? 1) - (share[column] ?? 0);
  }

  const wrapped = padded.map((row) =>
    row.map((cell, column) => {
      if (isBlankCell(cell)) return [[] as MarkdownSpan[]];
      // A run of spaces inside a cell wraps into lines with no text; those are dropped, so the row stays compact.
      // Only a continuation loses its leading space: on the first line a leading space can be code-span content.
      return wrap(cell, widths[column] ?? 1)
        .map((wrappedLine, index) =>
          stripTrailingSpace(
            index === 0 ? wrappedLine.spans : stripLeadingSpace(wrappedLine.spans),
          ),
        )
        .filter((spans, index) => index === 0 || cellText(spans).trim() !== '');
    }),
  );
  const multiLine = wrapped.some((row) => row.some((lines) => lines.length > 1));
  const border = (left: string, mid: string, right: string): MarkdownDisplayLine =>
    line([{ text: left + widths.map((w) => '─'.repeat(w + 2)).join(mid) + right, dim: true }]);
  const output: MarkdownDisplayLine[] = [border('┌', '┬', '┐')];
  wrapped.forEach((row, index) => {
    const height = Math.max(1, ...row.map((lines) => lines.length));
    for (let at = 0; at < height; at++) {
      const spans: MarkdownSpan[] = [{ text: '│', dim: true }];
      row.forEach((lines, column) => {
        const content = lines[at] ?? [];
        const padding = Math.max(0, (widths[column] ?? 1) - displayWidth(cellText(content)));
        const alignment = block.align?.[column] ?? 'left';
        const before =
          alignment === 'right' ? padding : alignment === 'center' ? Math.floor(padding / 2) : 0;
        spans.push({ text: ' '.repeat(before + 1) });
        spans.push(...content.map((span) => (index === 0 ? { ...span, strong: true } : span)));
        spans.push({ text: ' '.repeat(padding - before + 1) }, { text: '│', dim: true });
      });
      output.push(line(spans));
    }
    // The header is always ruled off; body rows are ruled apart only when some cell wraps, so a compact table stays compact.
    if (index === 0 || (multiLine && index < wrapped.length - 1))
      output.push(border('├', '┼', '┤'));
  });
  output.push(border('└', '┴', '┘'));
  return output;
}

const RECORD_INDENT = '  ';
const EMPTY_CELL: MarkdownSpan = { text: '—', dim: true };

function isBlankCell(spans: readonly MarkdownSpan[]): boolean {
  return spans.every((span) => span.text.trim() === '');
}

/**
 * A table whose column floors do not fit, drawn as records (ADR-0143, last resort): one dim notice, then for each body row a blank
 * line and, per column, the header as a bold label with its cell text on the lines below, indented and wrapped to
 * the width. No cell is cropped, no grid is narrowed, and no gutter is added, so a record inside a quote does not
 * stack bars. Alignment is not drawn. A header-only table, a hard cell break, or a width with no room past the
 * indent stays literal (`undefined`).
 */
function records(block: MarkdownBlock, columns: number): MarkdownDisplayLine[] | undefined {
  const rows = block.rows ?? [];
  if (rows.length < 2 || columns <= displayWidth(RECORD_INDENT)) return undefined;
  const cells = rows.map((row) => row.map((cell) => parseInline(cell)));
  const [headers = [], ...body] = cells;
  const labels = headers.map((header, column) =>
    isBlankCell(header)
      ? [{ text: `column ${column + 1}`, dim: true }]
      : header.map((span) => ({ ...span, strong: true })),
  );
  // Every record repeats every label, so the output grows as labels times body rows. Past four times the source's size
  // the records would turn a small table into a large transcript, so the table stays literal instead (ADR-0143).
  const labelCharacters = labels.reduce((sum, label) => sum + cellText(label).length, 0);
  if (labelCharacters * body.length > 4 * Math.max(1, block.source.length)) return undefined;
  // A grapheme wider than its line would be replaced with '?', so such a table stays literal and keeps every character.
  const widestLabel = Math.max(0, ...labels.map((label) => widestGrapheme(label)));
  const widestValue = Math.max(0, ...body.flat().map((cell) => widestGrapheme(cell)));
  if (widestLabel > columns || widestValue > columns - displayWidth(RECORD_INDENT))
    return undefined;
  const result = wrap(
    [{ text: 'table shown as records: its grid does not fit this width', dim: true }],
    columns,
    '',
    '',
    0,
    true,
  );
  for (const row of body) {
    result.push(line([]));
    row.forEach((cell, column) => {
      result.push(...wrap(labels[column] ?? [], columns, '', '', 0, true));
      result.push(
        ...wrap(
          isBlankCell(cell) ? [EMPTY_CELL] : cell,
          columns,
          RECORD_INDENT,
          RECORD_INDENT,
          0,
          true,
        ),
      );
    });
  }
  return result;
}

/** Lay out parsed blocks into terminal rows, without emitting ANSI. */
export function layoutMarkdown(
  blocks: readonly MarkdownBlock[],
  columns: number,
): readonly MarkdownDisplayLine[] {
  if (!Number.isFinite(columns) || columns < 1) return [];
  const result: MarkdownDisplayLine[] = [];
  for (const block of blocks) {
    const containerPrefix = block.prefix ?? '';
    if (block.kind === 'table') {
      const continuationPrefix = block.continuation ?? containerPrefix;
      const contentColumns =
        columns - Math.max(displayWidth(containerPrefix), displayWidth(continuationPrefix));
      const grid = table(block, contentColumns, displayWidth(continuationPrefix));
      const rendered =
        grid === 'no-fit'
          ? (wrappedGrid(block, contentColumns) ?? records(block, contentColumns))
          : grid;
      if (rendered) {
        for (const [index, row] of rendered.entries())
          result.push(
            line([
              {
                text: index === 0 ? containerPrefix : continuationPrefix,
                dim: true,
                quote: block.quoted ?? false,
              },
              ...row.spans,
            ]),
          );
        continue;
      }
      appendRows(result, wrap([{ text: block.source }], columns, '', '', block.tabOffset, true));
      continue;
    }
    if (block.kind === 'rule') {
      if (displayWidth(containerPrefix) >= columns)
        appendRows(result, wrap([{ text: block.source }], columns, '', '', block.tabOffset));
      else
        result.push(
          line([
            { text: containerPrefix, dim: true },
            { text: '─'.repeat(Math.floor(columns - displayWidth(containerPrefix))), dim: true },
          ]),
        );
      continue;
    }
    const prefix = block.kind === 'code' ? containerPrefix + '│ ' : containerPrefix;
    if (prefix && displayWidth(prefix) >= columns) {
      appendRows(result, wrap([{ text: block.source }], columns, '', '', block.tabOffset));
      continue;
    }
    if (block.kind === 'code') {
      if (block.info)
        appendRows(
          result,
          wrap([{ text: sanitizeInline(block.info), dim: true }], columns, containerPrefix),
        );
      appendRows(
        result,
        wrap(
          codeSpans(block),
          columns,
          block.info && block.continuation ? block.continuation + '│ ' : prefix,
          block.continuation ? block.continuation + '│ ' : prefix,
          block.tabOffset,
        ),
      );
      continue;
    }
    const literal = block.kind === 'literal';
    const style =
      block.kind === 'heading'
        ? { strong: true, heading: block.heading ?? 1 }
        : block.kind === 'quote'
          ? { quote: true }
          : {};
    const baseStyle = { ...style, ...(block.quoted ? { quote: true } : {}) };
    const spans = literal
      ? [{ text: containerPrefix ? block.text : block.source }]
      : (block.spans?.map((span) => ({ ...baseStyle, ...span })) ??
        parseInline(block.text, baseStyle));
    const continuation =
      block.continuation ?? (block.kind === 'list' ? ' '.repeat(displayWidth(prefix)) : prefix);
    appendRows(
      result,
      wrap(spans, columns, prefix, continuation, block.tabOffset, block.tableSource === true),
    );
  }
  return result;
}
