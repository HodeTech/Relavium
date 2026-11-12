import type { ToolPreview } from '@relavium/core';
import { secretMaskRanges } from '@relavium/llm/scrub-secrets';
import { sanitizeUntrusted, stripTerminalControls } from '../sanitize.js';
import { displayWidth } from './viewport.js';

export interface SourceRange {
  readonly field: number;
  readonly start: number;
  readonly end: number;
}
export interface ReviewMask extends SourceRange {
  readonly id: number;
  readonly bytes: number;
  readonly flagged: boolean;
}
export interface ReviewField {
  readonly text: string;
  readonly masks: readonly ReviewMask[];
  readonly byteIndex: readonly { offset: number; bytes: number }[];
}
export interface ReviewSourceLine extends SourceRange {
  readonly label: string;
  readonly ending: 'lf' | 'crlf' | 'none' | 'field';
  readonly changed: boolean;
  readonly trailingStart?: number;
}
export interface ReviewDocument {
  readonly valid: boolean;
  readonly preview: ToolPreview;
  readonly fields: readonly ReviewField[];
  readonly lines: readonly ReviewSourceLine[];
  readonly masks: readonly ReviewMask[];
  readonly required: readonly SourceRange[];
  readonly sourceBytes: number;
  readonly changedBytes: number;
  readonly changedLines: number;
  readonly remainingBytes: readonly number[];
}
export interface ReviewCursor {
  readonly line: number;
  readonly offset: number;
}
export const REVIEW_START: ReviewCursor = Object.freeze({ line: 0, offset: 0 });
const encoder = new TextEncoder();
export const reviewBytes = (text: string): number => encoder.encode(text).byteLength;

/** Compose the diagnostic floor without guessing where replacement strings came from. */
function maskField(text: string, field: number, firstId: number): ReviewField {
  let spans = secretMaskRanges(text);
  let projected = '',
    cursor = 0;
  for (const span of spans) {
    projected += text.slice(cursor, span.start) + '[REDACTED]';
    cursor = span.end;
  }
  projected += text.slice(cursor);
  if (stripTerminalControls(projected) !== sanitizeUntrusted(text))
    spans = [{ start: 0, end: text.length }];
  const byteIndex = [{ offset: 0, bytes: 0 }];
  let offset = 0,
    bytes = 0,
    next = 1024;
  for (const char of text) {
    offset += char.length;
    const cp = char.codePointAt(0) ?? 0;
    bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (offset >= next) {
      byteIndex.push({ offset, bytes });
      next += 1024;
    }
  }
  return {
    text,
    byteIndex,
    masks: spans.map((span, index) => ({
      ...span,
      field,
      id: firstId + index,
      bytes: reviewBytes(text.slice(span.start, span.end)),
      flagged: !/^[\p{L}\p{N}\-_.+/=~:]*$/u.test(text.slice(span.start, span.end)),
    })),
  };
}

/** Source snapshots occur once; row indexes and masks refer to absolute original UTF-16 offsets. */
export function createReviewDocument(preview: ToolPreview): ReviewDocument {
  const invalid = (): ReviewDocument => ({
    valid: false,
    preview: { kind: preview.kind, fields: [] },
    fields: [],
    lines: [],
    masks: [],
    required: [],
    sourceBytes: 0,
    changedBytes: 0,
    changedLines: 0,
    remainingBytes: [0],
  });
  if (
    (preview.target?.length ?? 0) > 4096 ||
    preview.fields.length > 64 ||
    preview.fields.some((field) => field.name.length > 256 || field.value.length > 4096) ||
    (preview.diff?.before?.length ?? 0) > 8 * 1024 * 1024 ||
    (preview.diff?.after.length ?? 0) > 8 * 1024 * 1024 ||
    (preview.diff?.lines.length ?? 0) > 200_000
  )
    return invalid();
  if (preview.kind === 'saved-result' && preview.diff !== undefined) return invalid();
  if (preview.diff !== undefined) {
    const beforeBytes = reviewBytes(preview.diff.before ?? '');
    const afterBytes = reviewBytes(preview.diff.after);
    if (
      beforeBytes > 8 * 1024 * 1024 ||
      afterBytes > 8 * 1024 * 1024 ||
      beforeBytes !== preview.diff.stats.beforeBytes ||
      afterBytes !== preview.diff.stats.afterBytes
    )
      return invalid();
    const positions = { before: 0, after: 0 },
      numbers = { before: 1, after: 1 };
    let added = 0,
      removed = 0;
    for (const line of preview.diff.lines) {
      if (
        (line.kind !== 'added' && line.before === undefined) ||
        (line.kind !== 'removed' && line.after === undefined) ||
        (line.kind === 'added' && line.before !== undefined) ||
        (line.kind === 'removed' && line.after !== undefined) ||
        (line.text.length === 0 && line.ending === 'none')
      )
        return invalid();
      if (line.kind === 'added') added++;
      if (line.kind === 'removed') removed++;
      for (const side of ['before', 'after'] as const) {
        const span = line[side];
        if (span === undefined) continue;
        const source = side === 'before' ? (preview.diff.before ?? '') : preview.diff.after;
        const ending = line.ending === 'crlf' ? '\r\n' : line.ending === 'lf' ? '\n' : '';
        if (
          !Number.isSafeInteger(span.start) ||
          !Number.isSafeInteger(span.end) ||
          span.start !== positions[side] ||
          span.line !== numbers[side] ||
          span.start < 0 ||
          span.end > source.length ||
          span.end < span.start ||
          source.slice(span.start, span.end) !== line.text + ending
        )
          return invalid();
        positions[side] = span.end;
        numbers[side]++;
      }
    }
    if (
      positions.before !== (preview.diff.before?.length ?? 0) ||
      positions.after !== preview.diff.after.length ||
      added !== preview.diff.stats.addedLines ||
      removed !== preview.diff.stats.removedLines
    )
      return invalid();
  }
  const fields: ReviewField[] = [],
    lines: ReviewSourceLine[] = [],
    masks: ReviewMask[] = [];
  const add = (text: string): number => {
    const field = fields.length;
    const value = maskField(text, field, masks.length + 1);
    fields.push(value);
    masks.push(...value.masks);
    return field;
  };
  const fieldLines = (field: number, label: string): void => {
    const text = fields[field]?.text ?? '';
    lines.push({ field, start: 0, end: text.length, label, ending: 'field', changed: false });
  };
  if (preview.target !== undefined) fieldLines(add(preview.target), 'target');
  for (const item of preview.fields) {
    fieldLines(add(item.name), 'field name');
    fieldLines(add(item.value), 'field value');
  }
  let changedBytes = 0,
    changedLines = 0;
  const diff = preview.diff;
  if (diff !== undefined) {
    const before = add(diff.before ?? ''),
      after = add(diff.after);
    for (const line of diff.lines) {
      if (line.kind === 'context' && line.before !== undefined && line.after !== undefined) {
        const endingLength = line.ending === 'crlf' ? 2 : line.ending === 'lf' ? 1 : 0;
        lines.push({
          field: before,
          start: line.before.start,
          end: line.before.end - endingLength,
          label: `=before ${line.before.line}`,
          ending: line.ending,
          changed: false,
        });
      }
      const side = line.kind === 'removed' ? line.before : (line.after ?? line.before);
      if (side === undefined) continue;
      const field = line.kind === 'removed' ? before : after;
      const endingLength = line.ending === 'crlf' ? 2 : line.ending === 'lf' ? 1 : 0;
      lines.push({
        field,
        start: side.start,
        end: side.end - endingLength,
        label: `${line.kind === 'removed' ? '-' : line.kind === 'added' ? '+' : '='}${side.line}`,
        ending: line.ending,
        changed: line.kind !== 'context',
      });
      if (line.kind !== 'context') {
        changedLines++;
        changedBytes += reviewBytes((fields[field]?.text ?? '').slice(side.start, side.end));
      }
    }
  }
  const indexedLines = lines.map((line) => {
    const text = fields[line.field]?.text ?? '';
    let trailingStart = line.end;
    while (trailingStart > line.start && /[ \t]/u.test(text[trailingStart - 1] ?? ''))
      trailingStart--;
    return { ...line, trailingStart };
  });
  const remainingBytes: number[] = Array.from({ length: lines.length + 1 }, () => 0);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (line !== undefined)
      remainingBytes[index] =
        (remainingBytes[index + 1] ?? 0) +
        fieldRangeBytes(fields[line.field], line.start, line.end) +
        (line.ending === 'crlf' ? 2 : line.ending === 'lf' ? 1 : 0);
  }
  const required: SourceRange[] = masks.filter((mask) => mask.flagged);
  for (const line of lines) {
    if (!line.changed) continue;
    const field = fields[line.field];
    if (field === undefined) continue;
    const endingLength = line.ending === 'crlf' ? 2 : line.ending === 'lf' ? 1 : 0;
    const end = line.end + endingLength;
    let low = 0,
      high = field.masks.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((field.masks[middle]?.end ?? 0) <= line.start) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < field.masks.length; index++) {
      const mask = field.masks[index];
      if (mask === undefined || mask.start >= end) break;
      if (!mask.flagged)
        required.push({
          field: line.field,
          start: Math.max(mask.start, line.start),
          end: Math.min(mask.end, end),
        });
    }
  }
  return {
    valid: required.length <= 8192,
    preview,
    fields,
    lines: indexedLines,
    masks,
    required,
    remainingBytes,
    sourceBytes: fields.reduce((sum, field) => sum + reviewBytes(field.text), 0),
    changedBytes,
    changedLines,
  };
}

const INVISIBLE = /[\p{C}\p{Z}\p{Default_Ignorable_Code_Point}]/u;
const BLANKS = new Set([0x2800, 0x16fe4, 0x1d159]);
export function escapeReviewCharacter(char: string, trailing: boolean, numeric = false): string {
  const cp = char.codePointAt(0) ?? 0;
  if (char === '\t' && !numeric) return '<TAB>';
  if (char === ' ' && trailing && !numeric) return '<SP>';
  if (numeric || char === '<' || (char !== ' ' && INVISIBLE.test(char)) || BLANKS.has(cp))
    return `<U+${cp.toString(16).toUpperCase().padStart(4, '0')}>`;
  return char;
}
export interface ReviewPage {
  readonly rows: readonly string[];
  /** Masked companion of exactly these emitted rows, never a second viewport projection. */
  readonly maskedRows: readonly string[];
  /** Source actually readable in this frame: placeholders do not prove their hidden bytes. */
  readonly visibleSource: readonly SourceRange[];
  readonly shown: readonly SourceRange[];
  readonly requiredTarget?: SourceRange;
  readonly next: ReviewCursor | undefined;
  readonly hiddenLines: number;
  readonly hiddenBytes: number;
  readonly valid: boolean;
}

/** Expand only this bounded viewport. Synthetic tokens are indivisible and never rescanned as source. */
export function projectReviewPage(
  document: ReviewDocument,
  cursor: ReviewCursor,
  columns: number,
  rowLimit: number,
  reveal = false,
  numeric = false,
): ReviewPage {
  const rows: string[] = [],
    maskedRows: string[] = [],
    visibleSource: SourceRange[] = [],
    shown: SourceRange[] = [];
  const emit = (
    line: ReviewSourceLine,
    start: number,
    end: number,
    row: string,
    ending = '',
  ): void => {
    const field = document.fields[line.field];
    if (field === undefined) return;
    let masked = `${line.label} `;
    for (let position = start; position < end; ) {
      const mask = maskAt(field.masks, position);
      if (mask !== undefined) {
        const stop = Math.min(end, mask.end);
        masked += `<MASK:id=${mask.id};bytes=${fieldRangeBytes(field, position, stop)}>`;
        if (reveal) visibleSource.push({ field: line.field, start: position, end: stop });
        position = stop;
      } else {
        const char = String.fromCodePoint(field.text.codePointAt(position) ?? 0);
        masked += escapeReviewCharacter(
          char,
          line.ending === 'field'
            ? /^[ \t]*(?:\r?\n|$)/u.test(field.text.slice(position, line.end))
            : position >= (line.trailingStart ?? line.end),
          numeric,
        );
        const stop = position + char.length;
        const last = visibleSource.at(-1);
        if (last !== undefined && last.field === line.field && last.end === position)
          visibleSource[visibleSource.length - 1] = { ...last, end: stop };
        else visibleSource.push({ field: line.field, start: position, end: stop });
        position = stop;
      }
    }
    rows.push(row);
    maskedRows.push(masked + ending);
  };
  let lineIndex = cursor.line,
    offset = cursor.offset,
    valid = document.valid && columns >= 32 && rowLimit >= 1;
  let work = 0;
  for (; valid && lineIndex < document.lines.length && rows.length < rowLimit; lineIndex++) {
    const line = document.lines[lineIndex];
    if (line === undefined) break;
    const field = document.fields[line.field];
    if (field === undefined) {
      valid = false;
      break;
    }
    let position = Math.max(line.start, offset),
      row = `${line.label} `;
    const start = position;
    let width = displayWidth(row);
    const trailingStart = line.trailingStart ?? line.end;
    for (; position < line.end; ) {
      if (++work > 65_536) {
        valid = false;
        break;
      }
      const mask = reveal ? undefined : maskAt(field.masks, position);
      const char = String.fromCodePoint(field.text.codePointAt(position) ?? 0);
      const token =
        mask === undefined
          ? escapeReviewCharacter(
              char,
              line.ending === 'field'
                ? /^[ \t]*(?:\r?\n|$)/u.test(field.text.slice(position, line.end))
                : position >= trailingStart,
              numeric,
            )
          : `<MASK:id=${mask.id};bytes=${fieldRangeBytes(field, position, Math.min(line.end, mask.end))}>`;
      const tokenWidth = displayWidth(token);
      if (width + tokenWidth > columns) {
        if (position === start) valid = false;
        break;
      }
      row += token;
      width += tokenWidth;
      position = mask === undefined ? position + char.length : Math.min(line.end, mask.end);
    }
    if (!valid) break;
    if (position === line.end) {
      const ending =
        line.ending === 'field'
          ? ''
          : line.ending === 'none'
            ? '<EOF:NO_NEWLINE>'
            : line.ending === 'crlf'
              ? '<CRLF>'
              : '<LF>';
      if (width + ending.length > columns) {
        if (position === start) {
          valid = false;
          break;
        }
        // Endings are their own source-backed row when the notation does not fit.
        emit(line, start, position, row);
        shown.push({ field: line.field, start, end: position });
        if (rows.length >= rowLimit) {
          offset = position;
          break;
        }
        row = `${line.label} ${ending}`;
        emit(line, position, position, row, ending);
      } else {
        row += ending;
        emit(line, start, position, row, ending);
      }
      if (reveal)
        shown.push({
          field: line.field,
          start,
          end: position + (line.ending === 'crlf' ? 2 : line.ending === 'lf' ? 1 : 0),
        });
      offset = 0;
    } else {
      emit(line, start, position, row);
      if (reveal) shown.push({ field: line.field, start, end: position });
      offset = position;
      lineIndex--;
    }
  }
  const next = lineIndex >= document.lines.length ? undefined : { line: lineIndex, offset };
  const nextLine = next === undefined ? undefined : document.lines[next.line];
  const hiddenBytes =
    (document.remainingBytes[next?.line ?? document.lines.length] ?? 0) -
    (nextLine === undefined || next === undefined
      ? 0
      : fieldRangeBytes(
          document.fields[nextLine.field],
          nextLine.start,
          Math.max(nextLine.start, next.offset),
        ));
  return {
    rows,
    maskedRows,
    visibleSource,
    shown: reveal ? shown : [],
    next,
    hiddenLines: document.lines.length - (next?.line ?? document.lines.length),
    hiddenBytes,
    valid,
  };
}

function maskAt(masks: readonly ReviewMask[], position: number): ReviewMask | undefined {
  let low = 0,
    high = masks.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((masks[middle]?.end ?? 0) <= position) low = middle + 1;
    else high = middle;
  }
  const mask = masks[low];
  return mask !== undefined && mask.start <= position && position < mask.end ? mask : undefined;
}
function fieldByteOffset(field: ReviewField, position: number): number {
  let low = 0,
    high = field.byteIndex.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if ((field.byteIndex[middle]?.offset ?? 0) <= position) low = middle;
    else high = middle;
  }
  const anchor = field.byteIndex[low] ?? { offset: 0, bytes: 0 };
  return anchor.bytes + reviewBytes(field.text.slice(anchor.offset, position));
}
function fieldRangeBytes(field: ReviewField | undefined, start: number, end: number): number {
  return field === undefined ? 0 : fieldByteOffset(field, end) - fieldByteOffset(field, start);
}
