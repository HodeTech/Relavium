import type { RunSummaryRecord } from '@relavium/db';

/**
 * The keyset position of a run summary, the `before` that `listRunSummaries` takes: its creation time as epoch milliseconds and its id
 * ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §4). The one place the
 * browsers derive it, so the History pager and the Active tab's "N more" count cannot disagree on what makes a position unusable.
 */
export interface KeysetCursor {
  readonly createdAt: number;
  readonly id: string;
}

/**
 * The cursor of `record`, or `undefined` when its time cannot be one (an unparseable `createdAt` reads as `NaN`, and the store refuses a
 * position that is not a safe integer with `invalid_cursor`). A caller treats `undefined` as "the list ends here": a page whose last row
 * has no usable position is the last page it can show, never a read that throws and takes the whole tab with it.
 */
export function keysetCursorOf(record: RunSummaryRecord | undefined): KeysetCursor | undefined {
  if (record === undefined) return undefined;
  const createdAt = Date.parse(record.createdAt);
  return Number.isSafeInteger(createdAt) ? { createdAt, id: record.id } : undefined;
}
