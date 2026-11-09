import { sanitizeInline } from '../sanitize.js';
import { displayWidth } from '../tui/viewport.js';
import { parseInline } from './inline.js';
import type { MarkdownBlock, MarkdownDisplayLine, MarkdownSpan } from './types.js';

function appendRows(target: MarkdownDisplayLine[], rows: readonly MarkdownDisplayLine[]): void {
  for (const row of rows) target.push(row);
}
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function line(spans: readonly MarkdownSpan[]): MarkdownDisplayLine {
  return { text: spans.map((span) => span.text).join(''), spans };
}
function wrap(
  spans: readonly MarkdownSpan[],
  columns: number,
  firstPrefix = '',
  continuation = firstPrefix,
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
  let logicalColumn = displayWidth(firstPrefix);
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
  prefixWidth: number,
): MarkdownDisplayLine[] | undefined {
  const rows = block.rows;
  if (!rows?.length) return undefined;
  const source = rows.map((row) => row.map((cell) => parseInline(cell)));
  if (source.some((row) => row.some((cell) => cell.some((span) => span.text.includes('\n')))))
    return undefined;
  const rendered: MarkdownSpan[][][] = source.map(() => []);
  const widths: number[] = [];
  let columnStart = prefixWidth + 2;
  for (let column = 0; column < (rows[0]?.length ?? 0); column++) {
    const unaligned = source.map((row) => expandCell(row[column] ?? [], columnStart));
    const width = Math.max(
      ...unaligned.map((cell) => displayWidth(cell.map((span) => span.text).join(''))),
    );
    widths.push(width);
    for (let row = 0; row < source.length; row++) {
      rendered[row]?.push(unaligned[row] ?? []);
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
        columns - displayWidth(containerPrefix),
        displayWidth(containerPrefix),
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
      appendRows(result, wrap([{ text: block.source }], columns));
      continue;
    }
    if (block.kind === 'rule') {
      if (displayWidth(containerPrefix) >= columns)
        appendRows(result, wrap([{ text: block.source }], columns));
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
      appendRows(result, wrap([{ text: block.source }], columns));
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
    appendRows(result, wrap(spans, columns, prefix, continuation));
  }
  return result;
}
