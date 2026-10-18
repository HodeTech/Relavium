import { describe, expect, it } from 'vitest';

import { RunSchema, RunStatusSchema } from './run.js';

const run = {
  id: '3a398e0e-0000-4000-8000-000000000000',
  workflowId: 'b1a2c3d4-0000-4000-8000-000000000000', // workflows.id surrogate UUID (ADR-0022)
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

  it('rejects a non-object inputs (pins the record boundary)', () => {
    expect(RunSchema.safeParse({ ...run, inputs: 'x' }).success).toBe(false);
    expect(RunSchema.safeParse({ ...run, inputs: [] }).success).toBe(false);
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

  it('requires a UUID workflowId (FK to workflows.id, not the kebab slug) — ADR-0022', () => {
    expect(RunSchema.safeParse({ ...run, workflowId: 'code-review-pipeline' }).success).toBe(false);
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
    const backwardsFinish = RunSchema.safeParse({
      ...run,
      status: 'completed',
      startedAt: 2000,
      completedAt: 1000,
    });
    expect(backwardsFinish.success).toBe(false);
    if (!backwardsFinish.success)
      expect(backwardsFinish.error.issues).toEqual([
        expect.objectContaining({
          path: ['completedAt'],
          message: 'completedAt must be >= startedAt',
        }),
      ]);
    const backwardsUpdate = RunSchema.safeParse({ ...run, createdAt: 2000, updatedAt: 1000 });
    expect(backwardsUpdate.success).toBe(false);
    if (!backwardsUpdate.success)
      expect(backwardsUpdate.error.issues).toEqual([
        expect.objectContaining({
          path: ['updatedAt'],
          message: 'updatedAt must be >= createdAt',
        }),
      ]);
    expect(
      RunSchema.safeParse({ ...run, status: 'completed', startedAt: 1000, completedAt: 2000 })
        .success,
    ).toBe(true);
    expect(
      RunSchema.safeParse({ ...run, status: 'completed', startedAt: 1000, completedAt: 1000 })
        .success,
    ).toBe(true);
  });

  // Explicit contract matrix, independent of the implementation's status predicates.
  const lifecycle = [
    { status: 'pending', startedAt: false, completedAt: false, error: false },
    { status: 'running', startedAt: true, completedAt: false, error: false },
    { status: 'paused', startedAt: true, completedAt: false, error: false },
    { status: 'completed', startedAt: true, completedAt: true, error: false },
    { status: 'failed', startedAt: true, completedAt: true, error: true },
    { status: 'cancelled', startedAt: true, completedAt: true, error: false },
  ] as const;
  const completionFields = {
    startedAt: 1000,
    completedAt: 2000,
    error: { code: 'internal', message: 'PRIVATE_ERROR_SENTINEL', retryable: false },
  };

  describe.each(lifecycle)('$status logical record compatibility', (row) => {
    it('allows missing legacy lifecycle fields and retains optional outputs', () => {
      const absent = { ...run, status: row.status };
      expect(RunSchema.parse(absent)).toEqual(absent);
      const withOutputs = { ...absent, outputs: { partial: 'legacy-result' } };
      expect(RunSchema.parse(withOutputs)).toEqual(withOutputs);
    });

    it.each(['startedAt', 'completedAt', 'error'] as const)(
      'enforces the present %s contract independently',
      (field) => {
        const value = { ...run, status: row.status, [field]: completionFields[field] };
        const result = RunSchema.safeParse(value);
        expect(result.success).toBe(row[field]);
        if (result.success) expect(result.data).toEqual(value);
        else {
          expect(result.error.issues).toHaveLength(1);
          expect(result.error.issues[0]?.path).toEqual([field]);
          expect(result.error.message).not.toContain('PRIVATE_ERROR_SENTINEL');
        }
      },
    );
  });

  it('accepts the optional completion fields (error, startedAt, completedAt) when present', () => {
    // Absence is covered by the base `run` fixture (a running run with none of them).
    expect(
      RunSchema.safeParse({
        ...run,
        status: 'failed',
        error: { code: 'internal', message: 'boom', retryable: false, nodeId: 'scan' },
        startedAt: 1717459210000,
        completedAt: 1717459260000,
      }).success,
    ).toBe(true);
  });

  it('binds error.code to the closed ErrorCode taxonomy and requires retryable', () => {
    const base = { ...run, status: 'failed' };
    // A free-string code is rejected now that the taxonomy is closed (matches run:failed).
    expect(
      RunSchema.safeParse({ ...base, error: { code: 'E_FAIL', message: 'x', retryable: false } })
        .success,
    ).toBe(false);
    // `retryable` is required when an error is present.
    expect(
      RunSchema.safeParse({ ...base, error: { code: 'internal', message: 'x' } }).success,
    ).toBe(false);
    expect(
      RunSchema.safeParse({
        ...base,
        error: { code: 'run_timeout', message: 'x', retryable: true },
      }).success,
    ).toBe(true);
    // a root-cause nodeId, when present, is never empty
    expect(
      RunSchema.safeParse({
        ...base,
        error: { code: 'internal', message: 'x', retryable: false, nodeId: '' },
      }).success,
    ).toBe(false);
  });
});
