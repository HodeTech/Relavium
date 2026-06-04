import { describe, expect, it } from 'vitest';

import { RunSchema, RunStatusSchema } from './run.js';

const run = {
  id: '3a398e0e-0000-4000-8000-000000000000',
  workflowId: 'code-review-pipeline',
  status: 'running',
  executionMode: 'local',
  triggerType: 'manual',
  inputs: { file_path: 'src/x.ts' },
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostMicrocents: 0,
  createdAt: 1717459200000,
  updatedAt: 1717459200000,
};

describe('RunSchema', () => {
  it('accepts a run record', () => {
    expect(RunSchema.safeParse(run).success).toBe(true);
  });

  it('pins the run-status set to the DB CHECK enum', () => {
    expect(RunStatusSchema.options).toEqual([
      'pending',
      'running',
      'paused',
      'completed',
      'failed',
      'cancelled',
    ]);
  });

  it('rejects an unknown status', () => {
    expect(RunSchema.safeParse({ ...run, status: 'frozen' }).success).toBe(false);
  });

  it('rejects an unknown execution mode', () => {
    expect(RunSchema.safeParse({ ...run, executionMode: 'turbo' }).success).toBe(false);
  });

  it('rejects a fractional token count (integers only)', () => {
    expect(RunSchema.safeParse({ ...run, totalInputTokens: 1.5 }).success).toBe(false);
  });

  it('requires a UUID run id', () => {
    expect(RunSchema.safeParse({ ...run, id: 'not-a-uuid' }).success).toBe(false);
  });

  it('accepts a completed run with outputs, and a running run without', () => {
    expect(RunSchema.safeParse(run).success).toBe(true); // no outputs
    expect(
      RunSchema.safeParse({
        ...run,
        status: 'completed',
        outputs: { report: 'done' },
        completedAt: 1717459260000,
      }).success,
    ).toBe(true);
  });

  it('enforces temporal invariants (completedAt >= startedAt, updatedAt >= createdAt)', () => {
    expect(RunSchema.safeParse({ ...run, startedAt: 2000, completedAt: 1000 }).success).toBe(false);
    expect(RunSchema.safeParse({ ...run, createdAt: 2000, updatedAt: 1000 }).success).toBe(false);
    expect(RunSchema.safeParse({ ...run, startedAt: 1000, completedAt: 2000 }).success).toBe(true);
  });
});
