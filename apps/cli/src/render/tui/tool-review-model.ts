import { sanitizeApprovalReason } from './chat-projection.js';
import type { ChatKey } from './chat-input.js';
import {
  projectReviewPage,
  REVIEW_START,
  type ReviewCursor,
  type ReviewDocument,
  type ReviewField,
  type ReviewPage,
  type SourceRange,
} from './tool-review-projection.js';

export interface ToolReviewState {
  readonly kind: 'approval' | 'details';
  readonly screen: 'card' | 'full' | 'list';
  readonly callId: string | undefined;
  readonly document: ReviewDocument | undefined;
  readonly cursor: ReviewCursor;
  readonly previous: readonly ReviewCursor[];
  readonly reveal: boolean;
  readonly numeric: boolean;
  readonly inspected: readonly SourceRange[];
  readonly requiredTarget: SourceRange | undefined;
  readonly query: string | undefined;
  readonly searching: boolean;
  readonly selected: number;
  readonly denial: string | undefined;
  readonly message: string;
}
export function initialToolReview(
  kind: 'approval' | 'details',
  callId?: string,
  document?: ReviewDocument,
): ToolReviewState {
  return {
    kind,
    screen: initialReviewScreen(kind, document),
    callId,
    document,
    cursor: REVIEW_START,
    previous: [],
    reveal: false,
    numeric: false,
    inspected: [],
    requiredTarget: undefined,
    query: undefined,
    searching: false,
    selected: 0,
    denial: undefined,
    message: '',
  };
}
export function reviewInspected(state: ToolReviewState): boolean {
  const requirements = [
    ...(state.document?.required ?? []),
    ...(state.requiredTarget === undefined ? [] : [state.requiredTarget]),
  ];
  return requirements.every((required) =>
    state.inspected.some(
      (seen) =>
        seen.field === required.field && seen.start <= required.start && seen.end >= required.end,
    ),
  );
}
export function acknowledgeToolReview(state: ToolReviewState, page: ReviewPage): ToolReviewState {
  if (!page.valid) return state;
  const requiredTarget = state.requiredTarget ?? page.requiredTarget;
  const intersect = (
    shown: readonly SourceRange[],
    required: readonly SourceRange[],
  ): SourceRange[] =>
    shown.flatMap((source) =>
      required.flatMap((range) => {
        if (source.field !== range.field) return [];
        const start = Math.max(source.start, range.start),
          end = Math.min(source.end, range.end);
        return start < end ? [{ field: source.field, start, end }] : [];
      }),
    );
  const needed =
    state.screen !== 'full'
      ? []
      : [
          ...(state.reveal ? intersect(page.shown, state.document?.required ?? []) : []),
          ...intersect(page.visibleSource, requiredTarget === undefined ? [] : [requiredTarget]),
        ];
  const merged = [...state.inspected, ...needed].sort(
    (a, b) => a.field - b.field || a.start - b.start || a.end - b.end,
  );
  const inspected: SourceRange[] = [];
  for (const range of merged) {
    const last = inspected.at(-1);
    if (last?.field === range.field && range.start <= last.end)
      inspected[inspected.length - 1] = { ...last, end: Math.max(last.end, range.end) };
    else inspected.push(range);
  }
  if (inspected.length > 8192)
    return {
      ...state,
      requiredTarget,
      message: 'Inspection limit exceeded — narrow the change.',
      inspected: [],
    };
  if (
    requiredTarget === state.requiredTarget &&
    JSON.stringify(inspected) === JSON.stringify(state.inspected)
  )
    return state;
  return { ...state, requiredTarget, inspected };
}
export type ReviewKeyAction =
  | { readonly kind: 'state'; readonly state: ToolReviewState }
  | { readonly kind: 'approve'; readonly scope: 'once' | 'always' }
  | { readonly kind: 'deny'; readonly reason?: string }
  | { readonly kind: 'abort' | 'copy' | 'close' | 'select' | 'none' };

/** All navigation/reveal transitions invalidate the current frame before another key can approve. */
export function reduceToolReviewKey(
  state: ToolReviewState,
  input: string,
  key: ChatKey,
  visible: boolean,
  page: ReviewPage | undefined,
  cacheable: boolean,
  callCount: number,
): ReviewKeyAction {
  if (key.escape || (key.ctrl && !key.meta && input === 'c'))
    return { kind: state.kind === 'approval' ? 'abort' : 'close' };
  if (key.ctrl || key.meta) return { kind: 'none' };
  const modal = reduceModalReviewKey(state, input, key, visible, callCount);
  if (modal !== undefined) return modal;
  if (input === 'v' && state.screen === 'card') return reviewChange(state, { screen: 'full' });
  if (state.screen === 'full' && input === 'p')
    return reviewChange(state, { numeric: !state.numeric });
  if (!visible) return { kind: 'none' };
  if (state.screen === 'full') {
    const navigation = reduceFullReviewKey(state, input, key, page);
    if (navigation.kind !== 'none') return navigation;
  }
  return state.kind === 'approval'
    ? reduceApprovalKey(state, input, page, cacheable)
    : { kind: 'none' };
}

export function toolReviewTarget(
  state: ToolReviewState,
  columns: number,
  rows: number,
): ReviewPage | undefined {
  const document = state.document;
  const line = document?.preview.target === undefined ? undefined : document.lines[0];
  if (document === undefined || line === undefined) return undefined;
  const target = {
    ...document,
    lines: [line],
    remainingBytes: [
      document.fields[line.field] === undefined
        ? 0
        : new TextEncoder().encode(document.fields[line.field]?.text ?? '').byteLength,
      0,
    ],
  };
  return projectReviewPage(
    target,
    REVIEW_START,
    Math.max(0, columns - 2),
    Math.max(1, Math.min(2, rows - 16)),
    false,
    false,
  );
}
export function toolReviewPage(
  state: ToolReviewState,
  columns: number,
  rows: number,
): ReviewPage | undefined {
  if (state.document === undefined || state.screen === 'list') return undefined;
  const target = toolReviewTarget(state, columns, rows);
  const shortenedTarget = target?.next !== undefined || target?.valid === false;
  const targetLine =
    state.document.preview.target === undefined ? undefined : state.document.lines[0];
  const shortenedRows = shortenedTarget ? 1 : 0;
  const headerRows = state.screen === 'card' ? (target?.rows.length ?? 0) + shortenedRows : 0;
  const page = projectReviewPage(
    state.document,
    state.screen === 'card' && targetLine !== undefined ? { line: 1, offset: 0 } : state.cursor,
    Math.max(0, columns - 2),
    Math.max(
      1,
      Math.min(
        state.screen === 'card' ? 4 : 200,
        rows -
          15 -
          headerRows -
          (state.searching ? 2 : 0) -
          (state.denial === undefined ? 0 : 2) -
          (state.message === '' ? 0 : 2),
      ),
    ),
    state.reveal,
    state.numeric,
  );
  return {
    ...page,
    ...(shortenedTarget && targetLine !== undefined
      ? {
          requiredTarget: { field: targetLine.field, start: targetLine.start, end: targetLine.end },
        }
      : {}),
    valid: page.valid && (state.screen !== 'card' || target?.valid !== false),
  };
}

function initialReviewScreen(
  kind: ToolReviewState['kind'],
  document: ReviewDocument | undefined,
): ToolReviewState['screen'] {
  if (kind === 'approval') return 'card';
  return document === undefined ? 'list' : 'full';
}
function reviewChange(state: ToolReviewState, patch: Partial<ToolReviewState>): ReviewKeyAction {
  return { kind: 'state', state: { ...state, ...patch } };
}
function reduceDenialKey(state: ToolReviewState, input: string, key: ChatKey): ReviewKeyAction {
  const denial = state.denial ?? '';
  if (key.return) {
    const reason = sanitizeApprovalReason(denial);
    return reason === undefined ? { kind: 'deny' } : { kind: 'deny', reason };
  }
  if (key.backspace || key.delete) return reviewChange(state, { denial: denial.slice(0, -1) });
  if ([...input].length === 1 && denial.length < 300)
    return reviewChange(state, { denial: denial + input });
  return { kind: 'none' };
}
function reduceListKey(state: ToolReviewState, key: ChatKey, callCount: number): ReviewKeyAction {
  if (key.upArrow) return reviewChange(state, { selected: Math.max(0, state.selected - 1) });
  if (key.downArrow)
    return reviewChange(state, {
      selected: Math.min(Math.max(0, callCount - 1), state.selected + 1),
    });
  if (key.return) return { kind: 'select' };
  return { kind: 'none' };
}
function reduceFullReviewKey(
  state: ToolReviewState,
  input: string,
  key: ChatKey,
  page: ReviewPage | undefined,
): ReviewKeyAction {
  if (key.home) return reviewChange(state, { cursor: REVIEW_START, previous: [] });
  if (input === 'r') return reviewChange(state, { reveal: !state.reveal, message: '' });
  if (input === '/') return reviewChange(state, { searching: true, query: '' });
  if (input === 'c') return { kind: 'copy' };
  if (input === 'b')
    return state.kind === 'approval'
      ? reviewChange(state, { screen: 'card', reveal: false, cursor: REVIEW_START, previous: [] })
      : reviewChange(state, {
          screen: 'list',
          reveal: false,
          document: undefined,
          callId: undefined,
          requiredTarget: undefined,
          inspected: [],
          cursor: REVIEW_START,
          previous: [],
        });
  if ((key.pageDown || key.downArrow) && page?.next !== undefined)
    return reviewChange(state, {
      cursor: page.next,
      previous: [...state.previous.slice(-4095), state.cursor],
    });
  if ((key.pageUp || key.upArrow) && state.previous.length > 0)
    return reviewChange(state, {
      cursor: state.previous.at(-1) ?? REVIEW_START,
      previous: state.previous.slice(0, -1),
    });
  return { kind: 'none' };
}
function reduceApprovalKey(
  state: ToolReviewState,
  input: string,
  page: ReviewPage | undefined,
  cacheable: boolean,
): ReviewKeyAction {
  if (input === 'c' && state.screen === 'card') return reviewChange(state, { denial: '' });
  if (input === 'n') return { kind: 'deny' };
  if (
    reviewInspected(state) &&
    page?.valid !== false &&
    (input === 'y' || (input === 'a' && cacheable))
  )
    return { kind: 'approve', scope: input === 'a' ? 'always' : 'once' };
  return { kind: 'none' };
}

function reduceSearchKey(state: ToolReviewState, input: string, key: ChatKey): ReviewKeyAction {
  if (key.return) {
    const query = state.query ?? '';
    if (state.document === undefined || query.length === 0)
      return reviewChange(state, { searching: false });
    const cursor = findReviewMatch(state.document, state.cursor, query, state.reveal);
    if (cursor === undefined)
      return reviewChange(state, { searching: false, message: 'No later visible match' });
    return reviewChange(state, {
      cursor,
      previous: [...state.previous.slice(-4095), state.cursor],
      searching: false,
      message: 'Match found',
    });
  }
  if (key.backspace || key.delete)
    return reviewChange(state, { query: (state.query ?? '').slice(0, -1) });
  if (input.length > 0 && [...input].length === 1 && (state.query?.length ?? 0) < 256)
    return reviewChange(state, { query: (state.query ?? '') + input });
  return { kind: 'none' };
}
function findReviewMatch(
  document: ReviewDocument,
  cursor: ReviewCursor,
  query: string,
  reveal: boolean,
): ReviewCursor | undefined {
  for (let index = cursor.line; index < document.lines.length; index++) {
    const line = document.lines[index];
    if (line === undefined) continue;
    const field = document.fields[line.field];
    if (field === undefined) continue;
    const start = Math.max(line.start, index === cursor.line ? cursor.offset : 0);
    const offset = findLineMatch(field, start, line.end, query, reveal);
    if (offset !== undefined) return { line: index, offset };
  }
  return undefined;
}
function findLineMatch(
  field: ReviewField,
  start: number,
  end: number,
  query: string,
  reveal: boolean,
): number | undefined {
  // Search only this line; a field can contain a complete multi-MiB diff side.
  const source = field.text.slice(start, end);
  let from = 0;
  while (from <= source.length - query.length) {
    const relative = source.indexOf(query, from);
    if (relative < 0) break;
    const found = start + relative;
    const maskEnd = reveal ? undefined : intersectingMaskEnd(field, found, query.length);
    if (maskEnd === undefined) return found;
    // Every start before this mask ends intersects it, including overlaps.
    from = Math.max(relative + 1, maskEnd - start);
  }
  return undefined;
}
function intersectingMaskEnd(
  field: ReviewField,
  found: number,
  length: number,
): number | undefined {
  let low = 0,
    high = field.masks.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((field.masks[middle]?.end ?? 0) <= found) low = middle + 1;
    else high = middle;
  }
  const mask = field.masks[low];
  return mask !== undefined && mask.start < found + length ? mask.end : undefined;
}

function reduceModalReviewKey(
  state: ToolReviewState,
  input: string,
  key: ChatKey,
  visible: boolean,
  callCount: number,
): ReviewKeyAction | undefined {
  if (state.denial !== undefined)
    return visible ? reduceDenialKey(state, input, key) : { kind: 'none' };
  if (state.screen === 'list')
    return visible ? reduceListKey(state, key, callCount) : { kind: 'none' };
  if (state.searching) return visible ? reduceSearchKey(state, input, key) : { kind: 'none' };
  return undefined;
}
