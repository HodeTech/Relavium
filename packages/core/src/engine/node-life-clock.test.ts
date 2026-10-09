import { RunEventSchema, RunSuspensionReducer, type RunEvent } from '@relavium/shared';
import { describe, expect, it } from 'vitest';
import { NodeLifeClockReducer } from './node-life-clock.js';

function history() {
  const clock = new NodeLifeClockReducer();
  const suspension = new RunSuspensionReducer();
  let sequenceNumber = 0;
  const append = (ms: number, fields: Readonly<Record<string, unknown>>): RunEvent => {
    const event = RunEventSchema.parse({
      runId: 'node-life',
      timestamp: new Date(ms).toISOString(),
      sequenceNumber: sequenceNumber++,
      ...fields,
    });
    clock.apply(event, suspension.apply(event));
    return event;
  };
  const start = (ms: number, attemptNumber?: number) =>
    append(ms, { type: 'node:started', nodeId: 'a', nodeType: 'agent', attemptNumber });
  const approve = (ms: number, gateId: string, native = false) => {
    const allowance = { kind: 'legacy_no_allowance' };
    if (native)
      append(ms, {
        type: 'budget:authorization',
        nodeId: 'a',
        gateId,
        authorization: { state: 'paused', allowance, spentMicrocents: 2, limitMicrocents: 1 },
      });
    else
      append(ms, {
        type: 'budget:paused',
        nodeId: 'a',
        gateId,
        spentMicrocents: 2,
        limitMicrocents: 1,
      });
    if (native)
      append(ms, {
        type: 'budget:authorization',
        nodeId: 'a',
        gateId,
        authorization: { state: 'decided', allowance, decision: 'approved', decidedBy: 'offline' },
      });
    append(ms, {
      type: 'human_gate:resumed',
      nodeId: 'a',
      gateId,
      decision: 'approved',
      decidedBy: 'offline',
    });
  };
  return { clock, append, start, approve };
}

describe('parked logical node life — ADR-0103', () => {
  it('a running crash opens T1 rather than using the original T0', () => {
    const h = history();
    h.start(0);
    h.start(1000);
    expect(h.clock.snapshot().get('a')).toEqual({ kind: 'valid', startedAtMs: 1000 });
  });
  for (const native of [false, true])
    it(`genuine ${native ? 'typed' : 'legacy'} approvals preserve T1 and a consumed companion cannot mint credit`, () => {
      const h = history();
      h.start(0);
      h.start(1000);
      h.approve(2000, 'g1', native);
      h.start(2100);
      h.approve(2200, 'g2', native);
      h.start(2300);
      expect(h.clock.snapshot().get('a')).toEqual({ kind: 'valid', startedAtMs: 1000 });
      h.append(2400, {
        type: 'human_gate:resumed',
        nodeId: 'a',
        gateId: 'g2',
        decision: 'approved',
        decidedBy: 'offline',
      });
      h.start(2500);
      expect(h.clock.snapshot().get('a')).toEqual({ kind: 'valid', startedAtMs: 2500 });
    });
  it('a crash after approval but before start consumes precisely its pending credit', () => {
    const h = history();
    h.start(1000);
    h.approve(2000, 'g');
    h.start(3000);
    expect(h.clock.snapshot().get('a')).toEqual({ kind: 'valid', startedAtMs: 1000 });
    h.start(4000);
    expect(h.clock.snapshot().get('a')).toEqual({ kind: 'valid', startedAtMs: 4000 });
  });
  it('a validated retry preserves the life while a missing retry transition invalidates it', () => {
    const h = history();
    h.start(1000);
    h.append(1500, {
      type: 'node:retrying',
      nodeId: 'a',
      attemptNumber: 1,
      error: { code: 'provider_unavailable', message: 'offline', retryable: true },
      delayMs: 0,
    });
    h.start(1600, 2);
    expect(h.clock.snapshot().get('a')).toEqual({ kind: 'valid', startedAtMs: 1000 });
    h.start(1700, 3);
    expect(h.clock.snapshot().get('a')).toEqual({ kind: 'invalid' });
  });
  it('a retry without an initial start never invents a basis', () => {
    const h = history();
    h.start(1000, 2);
    expect(h.clock.snapshot().get('a')).toEqual({ kind: 'invalid' });
  });
  it('approval without a prior start cannot grant a newly timed life', () => {
    const h = history();
    h.approve(2000, 'missing-start');
    h.start(3000);
    expect(h.clock.snapshot().get('a')).toEqual({ kind: 'invalid' });
  });
  it('a media submission preserves the current basis without inventing a start', () => {
    const h = history();
    h.start(1000);
    h.append(2000, {
      type: 'media_job:submitted',
      nodeId: 'a',
      jobId: 'offline-job',
      provider: 'openai',
      model: 'offline-model',
      modality: 'image',
      startedAt: new Date(2000).toISOString(),
      deadlineAt: new Date(30000).toISOString(),
    });
    expect(h.clock.snapshot().get('a')).toEqual({ kind: 'valid', startedAtMs: 1000 });
  });
  it('a mismatched retry transition does not extend the deadline', () => {
    const h = history();
    h.start(1000);
    h.append(1500, {
      type: 'node:retrying',
      nodeId: 'a',
      attemptNumber: 2,
      error: { code: 'provider_unavailable', message: 'offline', retryable: true },
      delayMs: 0,
    });
    h.start(1600, 3);
    expect(h.clock.snapshot().get('a')).toEqual({ kind: 'invalid' });
  });
  it('an invalid start timestamp refuses a basis even if the caller bypassed event parsing', () => {
    const clock = new NodeLifeClockReducer();
    const h = history();
    clock.apply({ ...h.start(1000), timestamp: 'invalid' }, undefined);
    expect(clock.snapshot().get('a')).toEqual({ kind: 'invalid' });
  });
  it('a node terminal clears both the old life and its approval credit', () => {
    const h = history();
    h.start(1000);
    h.approve(2000, 'g');
    h.append(2500, {
      type: 'node:failed',
      nodeId: 'a',
      error: { code: 'internal', message: 'offline', retryable: false },
    });
    expect(h.clock.snapshot().has('a')).toBe(false);
    h.start(3000);
    expect(h.clock.snapshot().get('a')).toEqual({ kind: 'valid', startedAtMs: 3000 });
  });
});
