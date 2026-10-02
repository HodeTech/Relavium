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
    await port.prepare(0, 'http_request', 3, {});
    await port.settle(0, 'http_request', 'committed', { secret: 'synthetic-output-token' });
    await expect(port.prepare(0, 'http_request', 3, {})).rejects.toBeInstanceOf(
      EffectConflictError,
    );
  });

  it('preserves run result retention and replay', async () => {
    const store = createInMemoryEffectJournalStore();
    const port = store.for({ kind: 'run', runId: 'r1', nodeId: 'n1', attempt: 1 });
    await port.prepare(0, 'http_request', 3, {});
    await port.settle(0, 'http_request', 'committed', { output: 'run output' });
    expect(store.rows()[0]).toHaveProperty('result', { output: 'run output' });
    await expect(port.prepare(0, 'http_request', 3, {})).resolves.toEqual({
      outcome: 'replay',
      result: { output: 'run output' },
    });
  });
});
