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
    bytes += codePointBytes(cp);
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
  if (!validPreviewBounds(preview) || !validPreviewDiff(preview)) return invalid();
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
  if (preview.diff !== undefined) {
    const changes = appendDiffLines(preview.diff, add, fields, lines);
    changedBytes = changes.changedBytes;
    changedLines = changes.changedLines;
  }
  const indexedLines = lines.map((line) => indexTrailingWhitespace(line, fields));
  const remainingBytes = indexRemainingBytes(lines, fields);
  const required = requiredInspectionRanges(lines, fields, masks);
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
  const page: PageProjection = {
    document,
    columns,
    rowLimit,
    reveal,
    numeric,
    rows: [],
    maskedRows: [],
    visibleSource: [],
    shown: [],
    lineIndex: cursor.line,
    offset: cursor.offset,
    valid: document.valid && columns >= 32 && rowLimit >= 1,
    work: 0,
  };
  while (page.valid && page.lineIndex < document.lines.length && page.rows.length < rowLimit) {
    if (!appendReviewLine(page)) break;
  }
  const next =
    page.lineIndex >= document.lines.length
      ? undefined
      : { line: page.lineIndex, offset: page.offset };
  return {
    rows: page.rows,
    maskedRows: page.maskedRows,
    visibleSource: page.visibleSource,
    shown: reveal ? page.shown : [],
    next,
    hiddenLines: document.lines.length - (next?.line ?? document.lines.length),
    hiddenBytes: hiddenReviewBytes(document, next),
    valid: page.valid,
  };
}

interface PageProjection {
  readonly document: ReviewDocument;
  readonly columns: number;
  readonly rowLimit: number;
  readonly reveal: boolean;
  readonly numeric: boolean;
  readonly rows: string[];
  readonly maskedRows: string[];
  readonly visibleSource: SourceRange[];
  readonly shown: SourceRange[];
  lineIndex: number;
  offset: number;
  valid: boolean;
  work: number;
}
interface ReviewRow {
  readonly start: number;
  readonly position: number;
  readonly text: string;
  readonly width: number;
}
function isTrailingCharacter(
  line: ReviewSourceLine,
  field: ReviewField,
  position: number,
): boolean {
  if (line.ending === 'field')
    return /^[ \t]*(?:\r?\n|$)/u.test(field.text.slice(position, line.end));
  return position >= (line.trailingStart ?? line.end);
}
function maskToken(mask: ReviewMask, field: ReviewField, position: number, end: number): string {
  return `<MASK:id=${mask.id};bytes=${fieldRangeBytes(field, position, Math.min(end, mask.end))}>`;
}
function appendVisibleRange(
  visible: SourceRange[],
  field: number,
  start: number,
  end: number,
): void {
  const last = visible.at(-1);
  if (last?.field === field && last.end === start) visible[visible.length - 1] = { ...last, end };
  else visible.push({ field, start, end });
}
/** The masked companion is derived from exactly the source range emitted in the visible row. */
function emitReviewRow(
  page: PageProjection,
  line: ReviewSourceLine,
  start: number,
  end: number,
  row: string,
  ending = '',
): void {
  const field = page.document.fields[line.field];
  if (field === undefined) return;
  let masked = `${line.label} `,
    position = start;
  while (position < end) {
    const mask = maskAt(field.masks, position);
    if (mask !== undefined) {
      const stop = Math.min(end, mask.end);
      masked += maskToken(mask, field, position, end);
      if (page.reveal) page.visibleSource.push({ field: line.field, start: position, end: stop });
      position = stop;
    } else {
      const char = String.fromCodePoint(field.text.codePointAt(position) ?? 0);
      masked += escapeReviewCharacter(
        char,
        isTrailingCharacter(line, field, position),
        page.numeric,
      );
      const stop = position + char.length;
      appendVisibleRange(page.visibleSource, line.field, position, stop);
      position = stop;
    }
  }
  page.rows.push(row);
  page.maskedRows.push(masked + ending);
}
function projectReviewRow(
  page: PageProjection,
  line: ReviewSourceLine,
  field: ReviewField,
): ReviewRow {
  let position = Math.max(line.start, page.offset),
    text = `${line.label} `;
  const start = position;
  let width = displayWidth(text);
  while (position < line.end) {
    if (++page.work > 65_536) {
      page.valid = false;
      break;
    }
    const mask = page.reveal ? undefined : maskAt(field.masks, position);
    const char = String.fromCodePoint(field.text.codePointAt(position) ?? 0);
    const token =
      mask === undefined
        ? escapeReviewCharacter(char, isTrailingCharacter(line, field, position), page.numeric)
        : maskToken(mask, field, position, line.end);
    const tokenWidth = displayWidth(token);
    if (width + tokenWidth > page.columns) {
      if (position === start) page.valid = false;
      break;
    }
    text += token;
    width += tokenWidth;
    position = mask === undefined ? position + char.length : Math.min(line.end, mask.end);
  }
  return { start, position, text, width };
}
function reviewEnding(ending: ReviewSourceLine['ending']): string {
  switch (ending) {
    case 'field':
      return '';
    case 'none':
      return '<EOF:NO_NEWLINE>';
    case 'crlf':
      return '<CRLF>';
    case 'lf':
      return '<LF>';
  }
}
function appendReviewLine(page: PageProjection): boolean {
  const line = page.document.lines[page.lineIndex];
  if (line === undefined) return false;
  const field = page.document.fields[line.field];
  if (field === undefined) {
    page.valid = false;
    return false;
  }
  const row = projectReviewRow(page, line, field);
  if (!page.valid) return false;
  if (row.position === line.end) return appendReviewLineEnding(page, line, row);
  emitReviewRow(page, line, row.start, row.position, row.text);
  if (page.reveal) page.shown.push({ field: line.field, start: row.start, end: row.position });
  page.offset = row.position;
  return true;
}
function appendReviewLineEnding(
  page: PageProjection,
  line: ReviewSourceLine,
  row: ReviewRow,
): boolean {
  const ending = reviewEnding(line.ending);
  if (row.width + ending.length > page.columns) {
    if (row.position === row.start) {
      page.valid = false;
      return false;
    }
    // Endings are their own source-backed row when the notation does not fit.
    emitReviewRow(page, line, row.start, row.position, row.text);
    page.shown.push({ field: line.field, start: row.start, end: row.position });
    if (page.rows.length >= page.rowLimit) {
      page.offset = row.position;
      return false;
    }
    emitReviewRow(page, line, row.position, row.position, `${line.label} ${ending}`, ending);
  } else emitReviewRow(page, line, row.start, row.position, row.text + ending, ending);
  if (page.reveal)
    page.shown.push({
      field: line.field,
      start: row.start,
      end: row.position + endingLength(line.ending),
    });
  page.offset = 0;
  page.lineIndex++;
  return true;
}
function hiddenReviewBytes(document: ReviewDocument, next: ReviewCursor | undefined): number {
  const nextLine = next === undefined ? undefined : document.lines[next.line];
  const remaining = document.remainingBytes[next?.line ?? document.lines.length] ?? 0;
  if (nextLine === undefined || next === undefined) return remaining;
  return (
    remaining -
    fieldRangeBytes(
      document.fields[nextLine.field],
      nextLine.start,
      Math.max(nextLine.start, next.offset),
    )
  );
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

type PreviewDiff = NonNullable<ToolPreview['diff']>;
type PreviewDiffLine = PreviewDiff['lines'][number];
function codePointBytes(cp: number): number {
  if (cp <= 0x7f) return 1;
  if (cp <= 0x7ff) return 2;
  return cp <= 0xffff ? 3 : 4;
}
function endingLength(ending: ReviewSourceLine['ending']): number {
  if (ending === 'crlf') return 2;
  return ending === 'lf' ? 1 : 0;
}
function endingText(ending: PreviewDiffLine['ending']): string {
  if (ending === 'crlf') return '\r\n';
  return ending === 'lf' ? '\n' : '';
}
function diffLineMark(kind: PreviewDiffLine['kind']): string {
  if (kind === 'removed') return '-';
  return kind === 'added' ? '+' : '=';
}
function validPreviewBounds(preview: ToolPreview): boolean {
  return (
    (preview.target?.length ?? 0) <= 4096 &&
    preview.fields.length <= 64 &&
    !preview.fields.some((field) => field.name.length > 256 || field.value.length > 4096) &&
    (preview.diff?.before?.length ?? 0) <= 8 * 1024 * 1024 &&
    (preview.diff?.after.length ?? 0) <= 8 * 1024 * 1024 &&
    (preview.diff?.lines.length ?? 0) <= 200_000
  );
}
function validDiffLineShape(line: PreviewDiffLine): boolean {
  return !(
    (line.kind !== 'added' && line.before === undefined) ||
    (line.kind !== 'removed' && line.after === undefined) ||
    (line.kind === 'added' && line.before !== undefined) ||
    (line.kind === 'removed' && line.after !== undefined) ||
    (line.text.length === 0 && line.ending === 'none')
  );
}
function validDiffSpan(
  span: NonNullable<PreviewDiffLine['before']>,
  source: string,
  line: PreviewDiffLine,
  position: number,
  number: number,
): boolean {
  return (
    Number.isSafeInteger(span.start) &&
    Number.isSafeInteger(span.end) &&
    span.start === position &&
    span.line === number &&
    span.start >= 0 &&
    span.end <= source.length &&
    span.end >= span.start &&
    source.slice(span.start, span.end) === line.text + endingText(line.ending)
  );
}
function validDiffSources(diff: PreviewDiff): boolean {
  const positions = { before: 0, after: 0 },
    numbers = { before: 1, after: 1 };
  let added = 0,
    removed = 0;
  for (const line of diff.lines) {
    if (!validDiffLineShape(line)) return false;
    if (line.kind === 'added') added++;
    if (line.kind === 'removed') removed++;
    if (!advanceDiffPositions(diff, line, positions, numbers)) return false;
  }
  return (
    positions.before === (diff.before?.length ?? 0) &&
    positions.after === diff.after.length &&
    added === diff.stats.addedLines &&
    removed === diff.stats.removedLines
  );
}
function validPreviewDiff(preview: ToolPreview): boolean {
  const diff = preview.diff;
  if (diff === undefined) return true;
  if (preview.kind === 'saved-result') return false;
  const beforeBytes = reviewBytes(diff.before ?? ''),
    afterBytes = reviewBytes(diff.after);
  return (
    beforeBytes <= 8 * 1024 * 1024 &&
    afterBytes <= 8 * 1024 * 1024 &&
    beforeBytes === diff.stats.beforeBytes &&
    afterBytes === diff.stats.afterBytes &&
    validDiffSources(diff)
  );
}
function appendDiffLines(
  diff: PreviewDiff,
  add: (text: string) => number,
  fields: readonly ReviewField[],
  lines: ReviewSourceLine[],
): { changedBytes: number; changedLines: number } {
  const before = add(diff.before ?? ''),
    after = add(diff.after);
  let changedBytes = 0,
    changedLines = 0;
  for (const line of diff.lines) {
    if (line.kind === 'context' && line.before !== undefined && line.after !== undefined) {
      lines.push({
        field: before,
        start: line.before.start,
        end: line.before.end - endingLength(line.ending),
        label: `=before ${line.before.line}`,
        ending: line.ending,
        changed: false,
      });
    }
    const side = line.kind === 'removed' ? line.before : (line.after ?? line.before);
    if (side === undefined) continue;
    const field = line.kind === 'removed' ? before : after;
    lines.push({
      field,
      start: side.start,
      end: side.end - endingLength(line.ending),
      label: `${diffLineMark(line.kind)}${side.line}`,
      ending: line.ending,
      changed: line.kind !== 'context',
    });
    if (line.kind !== 'context') {
      changedLines++;
      changedBytes += reviewBytes((fields[field]?.text ?? '').slice(side.start, side.end));
    }
  }
  return { changedBytes, changedLines };
}
function indexTrailingWhitespace(
  line: ReviewSourceLine,
  fields: readonly ReviewField[],
): ReviewSourceLine {
  const text = fields[line.field]?.text ?? '';
  let trailingStart = line.end;
  while (trailingStart > line.start && /[ \t]/u.test(text[trailingStart - 1] ?? ''))
    trailingStart--;
  return { ...line, trailingStart };
}
function indexRemainingBytes(
  lines: readonly ReviewSourceLine[],
  fields: readonly ReviewField[],
): number[] {
  const remaining: number[] = Array.from({ length: lines.length + 1 }, () => 0);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (line !== undefined)
      remaining[index] =
        (remaining[index + 1] ?? 0) +
        fieldRangeBytes(fields[line.field], line.start, line.end) +
        endingLength(line.ending);
  }
  return remaining;
}
function requiredInspectionRanges(
  lines: readonly ReviewSourceLine[],
  fields: readonly ReviewField[],
  masks: readonly ReviewMask[],
): SourceRange[] {
  const required: SourceRange[] = masks.filter((mask) => mask.flagged);
  for (const line of lines) {
    if (!line.changed) continue;
    const field = fields[line.field];
    if (field === undefined) continue;
    appendChangedMasks(required, line, field);
  }
  return required;
}
function appendChangedMasks(
  required: SourceRange[],
  line: ReviewSourceLine,
  field: ReviewField,
): void {
  const end = line.end + endingLength(line.ending);
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

function advanceDiffPositions(
  diff: PreviewDiff,
  line: PreviewDiffLine,
  positions: { before: number; after: number },
  numbers: { before: number; after: number },
): boolean {
  for (const side of ['before', 'after'] as const) {
    const span = line[side];
    if (span === undefined) continue;
    const source = side === 'before' ? (diff.before ?? '') : diff.after;
    if (!validDiffSpan(span, source, line, positions[side], numbers[side])) return false;
    positions[side] = span.end;
    numbers[side]++;
  }
  return true;
}
