import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EffectConflictError, type EffectCorrelation } from '@relavium/shared';
import { createClient, runMigrations, type DbClient } from './client.js';
import {
  createEffectJournalPort,
  createEffectJournalStore,
  createEffectResumePort,
} from './effect-journal-store.js';

const run: EffectCorrelation = { kind: 'run', runId: 'run', nodeId: 'node', attempt: 1 };
const evidence = {
  v: 2,
  hasValue: false,
  hasMappedValue: false,
  truncated: false,
  summary: '',
  outputMapping: null,
};
let client: DbClient;
beforeEach(() => {
  client = createClient(':memory:');
  runMigrations(client.db);
});
afterEach(() => {
  if (client.sqlite.open) client.sqlite.close();
});
function fixture(correlation = run) {
  const store = createEffectJournalStore(client.db, { uuid: randomUUID, now: () => 100 });
  return {
    store,
    port: createEffectJournalPort(store, correlation, { providerAttempt: 1, toolCallId: 'call' }),
    resume: createEffectResumePort(store),
  };
}
describe('native retained effect inspection', () => {
  it('proves absence read-only, then shares exact matching evidence with atomic prepare', async () => {
    const f = fixture();
    await expect(f.port.inspectReplay(0, 'edit_file', { path: 'a', old: 'x' })).resolves.toEqual({
      outcome: 'miss',
    });
    expect(f.store.recordsFor(run)).toEqual([]);
    await f.port.prepare(0, 'edit_file', 3, { path: 'a', old: 'x' });
    await expect(
      f.port.inspectReplay(0, 'edit_file', { path: 'a', old: 'x' }),
    ).rejects.toBeInstanceOf(EffectConflictError);
    await f.port.settle(0, 'edit_file', 'committed', evidence);
    for (const operation of [
      () => f.port.inspectReplay(0, 'edit_file', { old: 'x', path: 'a' }),
      () => f.port.prepare(0, 'edit_file', 3, { old: 'x', path: 'a' }),
    ])
      await expect(operation()).resolves.toEqual({ outcome: 'replay', result: evidence });
    await expect(
      f.port.inspectReplay(0, 'edit_file', { path: 'a', old: 'different' }),
    ).rejects.toBeInstanceOf(EffectConflictError);
    expect(await f.resume.unresolvedForRun('run')).toEqual([]);
    expect(f.store.recordsFor(run)).toHaveLength(1);
  });
  it.each([
    {},
    [],
    null,
    7,
    { v: 1, hasValue: true, value: 'x' },
    { ...evidence, v: 3 },
    { ...evidence, value: null },
    { ...evidence, hasValue: true },
    { ...evidence, hasMappedValue: true },
    { ...evidence, outputMapping: [] },
  ])('native gate and both lookup paths refuse unusable JSON %#', async (result) => {
    const f = fixture();
    await f.port.prepare(0, 'edit_file', 3, {});
    await f.port.settle(0, 'edit_file', 'committed', result);
    expect(await f.resume.unresolvedForRun('run')).toHaveLength(1);
    await expect(f.port.inspectReplay(0, 'edit_file', {})).rejects.toBeInstanceOf(
      EffectConflictError,
    );
    await expect(f.port.prepare(0, 'edit_file', 3, {})).rejects.toBeInstanceOf(EffectConflictError);
  });
  it('an existing session identity conflicts without selecting or parsing legacy result bytes', async () => {
    const session = { kind: 'session', sessionId: 's', turn: 1 } as const;
    const f = fixture(session);
    await expect(f.port.inspectReplay(0, 'edit_file', {})).resolves.toEqual({ outcome: 'miss' });
    await f.port.prepare(0, 'edit_file', 3, {});
    await f.port.settle(0, 'edit_file', 'committed');
    client.sqlite.exec("UPDATE run_effects SET result_json = '{broken private legacy bytes'");
    const parse = vi.spyOn(JSON, 'parse');
    try {
      await expect(f.port.inspectReplay(0, 'edit_file', {})).rejects.toBeInstanceOf(
        EffectConflictError,
      );
      await expect(f.port.prepare(0, 'edit_file', 3, {})).rejects.toBeInstanceOf(
        EffectConflictError,
      );
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });
  it('unavailable storage is a rejected read, never proof of absence', async () => {
    const f = fixture();
    client.sqlite.close();
    await expect(f.port.inspectReplay(0, 'edit_file', {})).rejects.toBeInstanceOf(Error);
  });
});
