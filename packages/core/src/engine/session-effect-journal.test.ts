import { EffectConflictError, type EffectCorrelation } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { createInMemoryEffectJournalStore } from './execution-host.js';

describe('session effect privacy in the reference journal (ADR-0098)', () => {
  const correlation: EffectCorrelation = { kind: 'session', sessionId: 's1', turn: 1 };

  it('settles without examining or retaining session output', async () => {
    const store = createInMemoryEffectJournalStore();
    const port = store.for(correlation);
    await port.prepare(0, 'http_request', 3, {});
    await expect(
      (async () =>
        port.settle(0, 'http_request', 'committed', {
          secret: 'synthetic-session-output-token',
          toJSON: () => {
            throw new Error('session output must not be examined');
          },
        }))(),
    ).resolves.toBeUndefined();
    expect(store.rows()[0]).toMatchObject({ state: 'committed' });
    expect(store.rows()[0]).not.toHaveProperty('result');
    expect(JSON.stringify(store.rows())).not.toContain('synthetic-session-output-token');
  });

  it('refuses a matching committed session identity rather than replaying it', async () => {
    const store = createInMemoryEffectJournalStore();
    const port = store.for(correlation);
    await expect(port.inspectReplay(0, 'http_request', {})).resolves.toEqual({ outcome: 'miss' });
    await port.prepare(0, 'http_request', 3, {});
    await port.settle(0, 'http_request', 'committed', { secret: 'synthetic-output-token' });
    await expect(port.inspectReplay(0, 'http_request', {})).rejects.toBeInstanceOf(
      EffectConflictError,
    );
    await expect(port.prepare(0, 'http_request', 3, {})).rejects.toBeInstanceOf(
      EffectConflictError,
    );
  });

  it('preserves run result retention and replay', async () => {
    const store = createInMemoryEffectJournalStore();
    const port = store.for({ kind: 'run', runId: 'r1', nodeId: 'n1', attempt: 1 });
    await port.prepare(0, 'http_request', 3, {});
    await port.settle(0, 'http_request', 'committed', {
      v: 2,
      hasValue: true,
      value: { output: 'run output' },
      hasMappedValue: false,
      outputMapping: null,
      truncated: false,
      summary: '',
    });
    expect(store.rows()[0]).toHaveProperty('result', {
      v: 2,
      hasValue: true,
      value: { output: 'run output' },
      hasMappedValue: false,
      outputMapping: null,
      truncated: false,
      summary: '',
    });
    await expect(port.prepare(0, 'http_request', 3, {})).resolves.toEqual({
      outcome: 'replay',
      result: {
        v: 2,
        hasValue: true,
        value: { output: 'run output' },
        hasMappedValue: false,
        outputMapping: null,
        truncated: false,
        summary: '',
      },
    });
  });
  it.each([
    {},
    [],
    null,
    7,
    { v: 1, value: 'old' },
    {
      v: 2,
      hasValue: true,
      hasMappedValue: false,
      outputMapping: null,
      truncated: false,
      summary: '',
    },
  ])('memory gate and both replay entry points reject unusable evidence %#', async (result) => {
    const store = createInMemoryEffectJournalStore();
    const port = store.for({ kind: 'run', runId: 'r', nodeId: 'n', attempt: 1 });
    await expect(port.inspectReplay(0, 'edit_file', {})).resolves.toEqual({ outcome: 'miss' });
    expect(store.rows()).toEqual([]);
    await port.prepare(0, 'edit_file', 3, {});
    await port.settle(0, 'edit_file', 'committed', result);
    expect(await store.resume.unresolvedForRun('r')).toHaveLength(1);
    await expect(port.inspectReplay(0, 'edit_file', {})).rejects.toBeInstanceOf(
      EffectConflictError,
    );
    await expect(port.prepare(0, 'edit_file', 3, {})).rejects.toBeInstanceOf(EffectConflictError);
  });
  it('memory inspection and atomic replay retain legitimate explicitly absent values', async () => {
    const store = createInMemoryEffectJournalStore();
    const port = store.for({ kind: 'run', runId: 'r', nodeId: 'n', attempt: 1 });
    const result = {
      v: 2,
      hasValue: false,
      hasMappedValue: false,
      outputMapping: {},
      truncated: false,
      summary: '',
    };
    await port.prepare(0, 'edit_file', 3, {});
    await port.settle(0, 'edit_file', 'committed', result);
    expect(await store.resume.unresolvedForRun('r')).toEqual([]);
    await expect(port.inspectReplay(0, 'edit_file', {})).resolves.toEqual({
      outcome: 'replay',
      result,
    });
    await expect(port.prepare(0, 'edit_file', 3, {})).resolves.toEqual({
      outcome: 'replay',
      result,
    });
  });
});
