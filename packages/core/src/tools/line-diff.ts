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
type DiffOptions = { readonly yield?: () => Promise<void>; readonly checkCancelled?: () => void };

function lineEnding(newline: number, crlf: boolean): DiffLine['ending'] {
  if (newline === -1) return '';
  return crlf ? '\r\n' : '\n';
}

function endingLabel(ending: DiffLine['ending']): 'lf' | 'crlf' | 'none' {
  if (ending === '\n') return 'lf';
  return ending === '\r\n' ? 'crlf' : 'none';
}

function lines(source: string): DiffLine[] {
  const result: DiffLine[] = [];
  let start = 0;
  while (start < source.length) {
    const newline = source.indexOf('\n', start);
    const end = newline === -1 ? source.length : newline + 1;
    const crlf = newline !== -1 && newline > start && source[newline - 1] === '\r';
    const ending = lineEnding(newline, crlf);
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
  return endingLabel(source[0]!.ending);
}
function span(line: DiffLine): { line: number; start: number; end: number } {
  return { line: line.line, start: line.start, end: line.end };
}
function project(op: LineDiffOperation): ToolDiffLine {
  const line = op.kind === 'insert' ? op.after : op.before;
  const ending = endingLabel(line.ending);
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

function startingX(d: number, k: number, previous: Int32Array): number {
  if (d === 0) return 0;
  if (k === -d || (k !== d && previous[k - 1 + d - 1]! < previous[k + 1 + d - 1]!))
    return previous[k + 1 + d - 1]!;
  return previous[k - 1 + d - 1]! + 1;
}

class DiffWork {
  private work = 0;

  consume(): void {
    if (++this.work > MAX_WORK) throw new DiffLimitError();
  }

  shouldYield(): boolean {
    return (this.work & 4095) === 0;
  }
}

async function advanceFrontier(
  d: number,
  previous: Int32Array,
  old: readonly DiffLine[],
  next: readonly DiffLine[],
  budget: DiffWork,
  options: DiffOptions,
): Promise<{ current: Int32Array; found: boolean }> {
  const current = new Int32Array(2 * d + 1);
  for (let k = -d; k <= d; k += 2) {
    budget.consume();
    let x = startingX(d, k, previous);
    let y = x - k;
    while (x < old.length && y < next.length && same(old[x]!, next[y]!)) {
      x++;
      y++;
      budget.consume();
      if (budget.shouldYield()) {
        options.checkCancelled?.();
        await options.yield?.();
        options.checkCancelled?.();
      }
    }
    current[k + d] = x;
    if (budget.shouldYield()) {
      options.checkCancelled?.();
      await options.yield?.();
      options.checkCancelled?.();
    }
    if (x >= old.length && y >= next.length) return { current, found: true };
  }
  return { current, found: false };
}

async function shortestPath(
  old: readonly DiffLine[],
  next: readonly DiffLine[],
  options: DiffOptions,
): Promise<{ trace: readonly Int32Array[]; distance: number }> {
  const budget = new DiffWork();
  let traceBytes = 0;
  const trace: Int32Array[] = [];
  let previous: Int32Array = new Int32Array(1);
  for (let d = 0; d <= old.length + next.length; d++) {
    const width = 2 * d + 1;
    traceBytes += width * Int32Array.BYTES_PER_ELEMENT;
    if (traceBytes > MAX_TRACE_BYTES) throw new DiffLimitError();
    const { current, found } = await advanceFrontier(d, previous, old, next, budget, options);
    trace.push(current);
    if (found) return { trace, distance: d };
    previous = current;
  }
  throw new DiffLimitError();
}

function backtrack(
  old: readonly DiffLine[],
  next: readonly DiffLine[],
  trace: readonly Int32Array[],
  distance: number,
): LineDiffOperation[] {
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
  reversed.reverse();
  return reversed;
}

async function matchingEdges(
  old: readonly DiffLine[],
  next: readonly DiffLine[],
  tick: () => boolean,
  yieldWork: () => Promise<void>,
): Promise<{ prefix: number; oldEnd: number; nextEnd: number }> {
  let prefix = 0;
  while (prefix < old.length && prefix < next.length && same(old[prefix]!, next[prefix]!)) {
    prefix++;
    if (tick()) await yieldWork();
  }
  let oldEnd = old.length;
  let nextEnd = next.length;
  while (oldEnd > prefix && nextEnd > prefix && same(old[oldEnd - 1]!, next[nextEnd - 1]!)) {
    oldEnd--;
    nextEnd--;
    if (tick()) await yieldWork();
  }
  return { prefix, oldEnd, nextEnd };
}

async function appendDirectOperations(
  old: readonly DiffLine[],
  next: readonly DiffLine[],
  add: (operation: LineDiffOperation) => void,
  tick: () => boolean,
  yieldWork: () => Promise<void>,
): Promise<void> {
  for (const line of old) {
    add({ kind: 'delete', before: line });
    if (tick()) await yieldWork();
  }
  for (const line of next) {
    add({ kind: 'insert', after: line });
    if (tick()) await yieldWork();
  }
}

async function boundedOperations(
  old: readonly DiffLine[],
  next: readonly DiffLine[],
  options: DiffOptions,
): Promise<LineDiffOperation[]> {
  const operations: LineDiffOperation[] = [];
  let work = 0;
  const tick = (): boolean => ++work % 4096 === 0;
  const yieldWork = async (): Promise<void> => {
    options.checkCancelled?.();
    await options.yield?.();
    options.checkCancelled?.();
  };
  const { prefix, oldEnd, nextEnd } = await matchingEdges(old, next, tick, yieldWork);
  const add = (operation: LineDiffOperation): void => {
    if (operations.length >= MAX_OPERATIONS) throw new DiffLimitError();
    operations.push(operation);
  };
  for (let i = 0; i < prefix; i++) {
    add({ kind: 'equal', before: old[i]!, after: next[i]! });
    if (tick()) await yieldWork();
  }
  const middleOld = old.slice(prefix, oldEnd);
  const middleNext = next.slice(prefix, nextEnd);
  if (middleOld.length === 0 || middleNext.length === 0) {
    await appendDirectOperations(middleOld, middleNext, add, tick, yieldWork);
  } else {
    const { trace, distance } = await shortestPath(middleOld, middleNext, options);
    for (const operation of backtrack(middleOld, middleNext, trace, distance)) {
      add(operation);
      if (tick()) await yieldWork();
    }
  }
  for (let i = 0; i < old.length - oldEnd; i++) {
    add({ kind: 'equal', before: old[oldEnd + i]!, after: next[nextEnd + i]! });
    if (tick()) await yieldWork();
  }
  return operations;
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
  let operations: LineDiffOperation[];
  // Small diffs retain the established Myers tie choices. Large inputs use one
  // trimmed frontier; matching context and output passes are separately bounded
  // by MAX_LINES and MAX_OPERATIONS and do not reset the frontier budget.
  if (old.length === 0 || next.length === 0 || old.length + next.length >= 1414) {
    operations = await boundedOperations(old, next, options);
  } else {
    const { trace, distance } = await shortestPath(old, next, options);
    operations = backtrack(old, next, trace, distance);
  }
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
