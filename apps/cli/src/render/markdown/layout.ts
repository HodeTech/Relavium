import { sanitizeInline } from '../sanitize.js';
import { displayWidth } from '../tui/viewport.js';
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
    left.linkURL === right.linkURL
  );
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
function table(
  block: MarkdownBlock,
  columns: number,
  contentPrefixWidth: number,
): MarkdownDisplayLine[] | undefined {
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
    if (!Number.isFinite(width)) return undefined;
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
        if (match < 0) return undefined;
        const padding = width - (starts[match] ?? 0);
        before = alignment === 'right' ? padding : Math.floor(padding / 2);
      }
      rendered[row]?.push(expandCell(cell, columnStart + before));
    }
    columnStart += width + 3;
  }
  if (widths.reduce((a, b) => a + b + 3, 1) > columns) return undefined;
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
      const grid = table(
        block,
        columns -
          Math.max(
            displayWidth(containerPrefix),
            displayWidth(block.continuation ?? containerPrefix),
          ),
        displayWidth(block.continuation ?? containerPrefix),
      );
      if (grid) {
        for (const [index, row] of grid.entries())
          result.push(
            line([
              {
                text: index === 0 ? containerPrefix : (block.continuation ?? containerPrefix),
                dim: true,
                quote: block.quoted ?? false,
              },
              ...row.spans,
            ]),
          );
        continue;
      }
      appendRows(result, wrap([{ text: block.source }], columns, '', '', block.tabOffset));
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
          [{ text: block.text, code: true }],
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
    appendRows(result, wrap(spans, columns, prefix, continuation, block.tabOffset));
  }
  return result;
}
