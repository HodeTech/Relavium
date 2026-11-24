/**
 * The keyset position of a run summary ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §4): what the History pager and the Active tab's "N more" count both start a next page from. The one rule worth pinning is the refusal:
 * a time that is not a safe integer is not a position, because the store answers such a cursor with `invalid_cursor`.
 */
import type { RunSummaryRecord } from '@relavium/db';
import { describe, expect, it } from 'vitest';

import { keysetCursorOf } from './keyset-cursor.js';

const record = (createdAt: string): RunSummaryRecord => ({
  id: 'run-1',
  workflowId: 'wf',
  status: 'completed',
  executionMode: 'local',
  triggerType: 'manual',
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostMicrocents: 0,
  createdAt,
  updatedAt: createdAt,
});

describe('keysetCursorOf', () => {
  it('is the creation time in epoch milliseconds and the id', () => {
    expect(keysetCursorOf(record('2026-11-24T10:00:00.123Z'))).toEqual({
      createdAt: Date.parse('2026-11-24T10:00:00.123Z'),
      id: 'run-1',
    });
  });

  it('is nothing for a record that is not there, and for a time that cannot be a position', () => {
    expect(keysetCursorOf(undefined)).toBeUndefined();
    for (const bad of ['', 'not a date', '2026-13-45T99:00:00Z', 'Invalid Date'])
      expect(keysetCursorOf(record(bad)), bad).toBeUndefined();
  });
});
