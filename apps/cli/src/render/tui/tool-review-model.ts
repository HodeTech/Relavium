import { sanitizeApprovalReason } from './chat-projection.js';
import type { ChatKey } from './chat-input.js';
import {
  projectReviewPage,
  REVIEW_START,
  type ReviewCursor,
  type ReviewDocument,
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
    screen: kind === 'approval' ? 'card' : document === undefined ? 'list' : 'full',
    callId,
    document,
    cursor: REVIEW_START,
    previous: [],
    reveal: false,
    numeric: false,
    inspected: [],
    query: undefined,
    searching: false,
    selected: 0,
    denial: undefined,
    message: '',
  };
}
export function reviewInspected(state: ToolReviewState): boolean {
  return (
    state.document?.required.every((required) =>
      state.inspected.some(
        (seen) =>
          seen.field === required.field && seen.start <= required.start && seen.end >= required.end,
      ),
    ) ?? true
  );
}
export function acknowledgeToolReview(state: ToolReviewState, page: ReviewPage): ToolReviewState {
  if (!state.reveal || state.screen !== 'full' || !page.valid) return state;
  const needed = page.shown.flatMap((shown) =>
    (state.document?.required ?? []).flatMap((required) => {
      if (shown.field !== required.field) return [];
      const start = Math.max(shown.start, required.start),
        end = Math.min(shown.end, required.end);
      return start < end ? [{ field: shown.field, start, end }] : [];
    }),
  );
  const merged = [...state.inspected, ...needed].sort(
    (a, b) => a.field - b.field || a.start - b.start || a.end - b.end,
  );
  const inspected: SourceRange[] = [];
  for (const range of merged) {
    const last = inspected.at(-1);
    if (last !== undefined && last.field === range.field && range.start <= last.end)
      inspected[inspected.length - 1] = { ...last, end: Math.max(last.end, range.end) };
    else inspected.push(range);
  }
  if (inspected.length > 8192)
    return { ...state, message: 'Inspection limit exceeded — narrow the change.', inspected: [] };
  if (JSON.stringify(inspected) === JSON.stringify(state.inspected)) return state;
  return { ...state, inspected };
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
  const change = (patch: Partial<ToolReviewState>): ReviewKeyAction => ({
    kind: 'state',
    state: { ...state, ...patch },
  });
  if (state.denial !== undefined) {
    if (!visible) return { kind: 'none' };
    if (key.return) {
      const reason = sanitizeApprovalReason(state.denial);
      return reason === undefined ? { kind: 'deny' } : { kind: 'deny', reason };
    }
    if (key.backspace || key.delete) return change({ denial: state.denial.slice(0, -1) });
    if ([...input].length === 1 && state.denial.length < 300)
      return change({ denial: state.denial + input });
    return { kind: 'none' };
  }
  if (state.screen === 'list') {
    if (!visible) return { kind: 'none' };
    if (key.upArrow) return change({ selected: Math.max(0, state.selected - 1) });
    if (key.downArrow)
      return change({ selected: Math.min(Math.max(0, callCount - 1), state.selected + 1) });
    if (key.return) return { kind: 'select' };
    return { kind: 'none' };
  }
  if (state.searching) {
    if (!visible) return { kind: 'none' };
    if (key.return) {
      const query = state.query ?? '';
      const document = state.document;
      if (document === undefined || query.length === 0) return change({ searching: false });
      for (let index = state.cursor.line; index < document.lines.length; index++) {
        const line = document.lines[index];
        if (line === undefined) continue;
        const field = document.fields[line.field];
        const searchStart = Math.max(
          line.start,
          index === state.cursor.line ? state.cursor.offset : 0,
        );
        const relative = field?.text.slice(searchStart, line.end).indexOf(query) ?? -1;
        const found = relative < 0 ? -1 : searchStart + relative;
        if (found < line.start || found >= line.end) continue;
        if (
          !state.reveal &&
          field?.masks.some((mask) => found < mask.end && found + query.length > mask.start)
        )
          continue;
        return change({
          cursor: { line: index, offset: found },
          previous: [...state.previous.slice(-4095), state.cursor],
          searching: false,
          message: 'Match found',
        });
      }
      return change({ searching: false, message: 'No later visible match' });
    }
    if (key.backspace || key.delete) return change({ query: (state.query ?? '').slice(0, -1) });
    if (input.length > 0 && [...input].length === 1 && (state.query?.length ?? 0) < 256)
      return change({ query: (state.query ?? '') + input });
    return { kind: 'none' };
  }
  if (input === 'v' && state.screen === 'card') return change({ screen: 'full' });
  if (state.screen === 'full' && input === 'p') return change({ numeric: !state.numeric });
  if (!visible) return { kind: 'none' };
  if (state.screen === 'full') {
    if (key.home) return change({ cursor: REVIEW_START, previous: [] });
    if (input === 'r') return change({ reveal: !state.reveal, message: '' });
    if (input === '/') return change({ searching: true, query: '' });
    if (input === 'c') return { kind: 'copy' };
    if (input === 'b')
      return state.kind === 'approval'
        ? change({ screen: 'card', reveal: false, cursor: REVIEW_START, previous: [] })
        : change({
            screen: 'list',
            reveal: false,
            document: undefined,
            callId: undefined,
            cursor: REVIEW_START,
            previous: [],
          });
    if ((key.pageDown || key.downArrow) && page?.next !== undefined)
      return change({
        cursor: page.next,
        previous: [...state.previous.slice(-4095), state.cursor],
      });
    if ((key.pageUp || key.upArrow) && state.previous.length > 0)
      return change({
        cursor: state.previous.at(-1) ?? REVIEW_START,
        previous: state.previous.slice(0, -1),
      });
  }
  if (state.kind === 'approval') {
    if (input === 'c' && state.screen === 'card') return change({ denial: '' });
    if (input === 'n') return { kind: 'deny' };
    if (
      reviewInspected(state) &&
      page?.valid !== false &&
      (input === 'y' || (input === 'a' && cacheable))
    )
      return { kind: 'approve', scope: input === 'a' ? 'always' : 'once' };
  }
  return { kind: 'none' };
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
    Math.max(1, rows - 16),
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
  const page = projectReviewPage(
    state.document,
    state.cursor,
    Math.max(0, columns - 2),
    Math.max(
      1,
      Math.min(
        state.screen === 'card' ? 4 : 200,
        rows -
          13 -
          (target?.rows.length ?? 0) -
          (state.searching ? 2 : 0) -
          (state.denial === undefined ? 0 : 2) -
          (state.message === '' ? 0 : 2),
      ),
    ),
    state.reveal,
    state.numeric,
  );
  return { ...page, valid: page.valid && target?.next === undefined && target?.valid !== false };
}
