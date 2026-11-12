import { utf8ByteLength } from '@relavium/shared';
import type { ToolDiffLine, ToolFileDiff, ToolFileEndings } from './types.js';

interface DiffLine {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly ending: '\n' | '\r\n' | '';
  readonly line: number;
}
type LineDiffOperation =
  | { readonly kind: 'equal'; readonly before: DiffLine; readonly after: DiffLine }
  | { readonly kind: 'delete'; readonly before: DiffLine }
  | { readonly kind: 'insert'; readonly after: DiffLine };
export class DiffLimitError extends Error {
  constructor() {
    super('The change is too large to review; reduce the change.');
    this.name = 'DiffLimitError';
  }
}
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_LINES = 100_000;
const MAX_WORK = 1_000_000;
const MAX_TRACE_BYTES = 8 * 1024 * 1024;
const MAX_OPERATIONS = 200_000;

function lines(source: string): DiffLine[] {
  const result: DiffLine[] = [];
  let start = 0;
  while (start < source.length) {
    const newline = source.indexOf('\n', start);
    const end = newline === -1 ? source.length : newline + 1;
    const crlf = newline !== -1 && newline > start && source[newline - 1] === '\r';
    const ending = newline === -1 ? '' : crlf ? '\r\n' : '\n';
    result.push({
      start,
      end,
      line: result.length + 1,
      text: source.slice(start, end - ending.length),
      ending,
    });
    if (result.length > MAX_LINES) throw new DiffLimitError();
    start = end;
  }
  return result;
}
function same(a: DiffLine, b: DiffLine): boolean {
  return a.text === b.text && a.ending === b.ending;
}
function endings(source: readonly DiffLine[]): ToolFileEndings {
  if (source.length === 0) return 'empty';
  const values = new Set(source.map((line) => line.ending));
  if (values.size > 1) return 'mixed';
  return source[0]!.ending === '\n' ? 'lf' : source[0]!.ending === '\r\n' ? 'crlf' : 'none';
}
function span(line: DiffLine): { line: number; start: number; end: number } {
  return { line: line.line, start: line.start, end: line.end };
}
function project(op: LineDiffOperation): ToolDiffLine {
  const line = op.kind === 'insert' ? op.after : op.before;
  const ending = line.ending === '\n' ? 'lf' : line.ending === '\r\n' ? 'crlf' : 'none';
  if (op.kind === 'equal')
    return {
      kind: 'context',
      text: line.text,
      ending,
      before: span(op.before),
      after: span(op.after),
    };
  if (op.kind === 'delete')
    return { kind: 'removed', text: line.text, ending, before: span(op.before) };
  return { kind: 'added', text: line.text, ending, after: span(op.after) };
}

/** Bounded Myers shortest edit script. Refusal never returns a partial review. */
export async function diffLines(
  before: string | null,
  after: string,
  options: { readonly yield?: () => Promise<void>; readonly checkCancelled?: () => void } = {},
): Promise<ToolFileDiff> {
  options.checkCancelled?.();
  const beforeBytes = utf8ByteLength(before ?? '');
  const afterBytes = utf8ByteLength(after);
  if (beforeBytes > MAX_BYTES || afterBytes > MAX_BYTES) throw new DiffLimitError();
  const old = lines(before ?? '');
  const next = lines(after);
  let work = 0;
  let traceBytes = 0;
  const trace: Int32Array[] = [];
  let previous = new Int32Array(1);
  let found = false;
  let distance = 0;
  for (let d = 0; d <= old.length + next.length && !found; d++) {
    const width = 2 * d + 1;
    traceBytes += width * Int32Array.BYTES_PER_ELEMENT;
    if (traceBytes > MAX_TRACE_BYTES) throw new DiffLimitError();
    const current = new Int32Array(width);
    for (let k = -d; k <= d; k += 2) {
      if (++work > MAX_WORK) throw new DiffLimitError();
      let x: number;
      if (d === 0) x = 0;
      else if (k === -d || (k !== d && previous[k - 1 + d - 1]! < previous[k + 1 + d - 1]!))
        x = previous[k + 1 + d - 1]!;
      else x = previous[k - 1 + d - 1]! + 1;
      let y = x - k;
      while (x < old.length && y < next.length && same(old[x]!, next[y]!)) {
        x++;
        y++;
        if (++work > MAX_WORK) throw new DiffLimitError();
        if ((work & 4095) === 0) {
          options.checkCancelled?.();
          await options.yield?.();
          options.checkCancelled?.();
        }
      }
      current[k + d] = x;
      if ((work & 4095) === 0) {
        options.checkCancelled?.();
        await options.yield?.();
        options.checkCancelled?.();
      }
      if (x >= old.length && y >= next.length) {
        found = true;
        distance = d;
        break;
      }
    }
    trace.push(current);
    previous = current;
  }
  if (!found) throw new DiffLimitError();
  let x = old.length;
  let y = next.length;
  const reversed: LineDiffOperation[] = [];
  for (let d = distance; d > 0; d--) {
    const prior = trace[d - 1]!;
    const k = x - y;
    const previousK =
      k === -d || (k !== d && prior[k - 1 + d - 1]! < prior[k + 1 + d - 1]!) ? k + 1 : k - 1;
    const previousX = prior[previousK + d - 1]!;
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      x--;
      y--;
      reversed.push({ kind: 'equal', before: old[x]!, after: next[y]! });
    }
    if (x === previousX) {
      y--;
      reversed.push({ kind: 'insert', after: next[y]! });
    } else {
      x--;
      reversed.push({ kind: 'delete', before: old[x]! });
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    reversed.push({ kind: 'equal', before: old[x]!, after: next[y]! });
  }
  if (reversed.length > MAX_OPERATIONS) throw new DiffLimitError();
  const operations = reversed.reverse();
  let addedLines = 0;
  let removedLines = 0;
  for (const operation of operations) {
    if (operation.kind === 'insert') addedLines++;
    else if (operation.kind === 'delete') removedLines++;
  }
  options.checkCancelled?.();
  const projected = operations.map((operation) => {
    const line = project(operation);
    if (line.before !== undefined) Object.freeze(line.before);
    if (line.after !== undefined) Object.freeze(line.after);
    return Object.freeze(line);
  });
  return Object.freeze({
    before,
    after,
    lines: Object.freeze(projected),
    beforeEndings: endings(old),
    afterEndings: endings(next),
    stats: Object.freeze({ addedLines, removedLines, beforeBytes, afterBytes }),
  });
}
