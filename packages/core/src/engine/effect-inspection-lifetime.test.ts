import { expect, it } from 'vitest';
import type { EffectInspectReplayVerdict, RunEvent } from '@relavium/shared';
import { parseWorkflow } from '../parser.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost } from './execution-host.js';
import type { NodeExecContext } from './node-executor.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function until(check: () => boolean | Promise<boolean>) {
  for (let count = 0; count < 1000; count++) {
    if (await check()) return;
    await Promise.resolve();
  }
  expect.fail('host lifetime did not settle');
}
it('inspection retains its actual producer beyond the executor, refuses late lookup, and creates no pending effect claim', async () => {
  const raw = deferred<EffectInspectReplayVerdict>();
  let thenReads = 0,
    calls = 0;
  void Object.defineProperty(raw.promise, 'then', {
    get: () => {
      thenReads++;
      throw new Error('do not inspect producer then');
    },
  });
  const host = createInMemoryHost();
  let captured: NodeExecContext | undefined;
  let inspection: Promise<EffectInspectReplayVerdict> | undefined;
  const workflow = parseWorkflow(
    "schema_version: '1.0'\nworkflow:\n  id: inspection-lifetime\n  nodes: [{id: n, type: input}]\n  edges: []\n",
  );
  const engine = new WorkflowEngine({
    host,
    effectJournal: () => ({
      inspectReplay: () => {
        calls++;
        return raw.promise;
      },
      prepare: () => Promise.resolve({ outcome: 'proceed' }),
      settle: () => Promise.resolve(),
      discard: () => Promise.resolve(),
    }),
    executor: {
      execute: (ctx) => {
        captured = ctx;
        inspection = ctx.effects?.inspectReplay(0, 'edit_file', {});
        void inspection?.catch(() => undefined);
        return Promise.resolve({ kind: 'completed', output: 'executor returned' });
      },
    },
  });
  const handle = engine.start({ workflow });
  const events: RunEvent[] = [];
  for await (const event of handle.events) events.push(event);
  expect(events.at(-1)?.type).toBe('run:completed');
  let departed = false;
  const departure = handle.depart().then((result) => {
    departed = true;
    return result;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(departed).toBe(false);
  expect(await host.runLeases.read(handle.runId)).toBeDefined();
  expect(thenReads).toBe(0);
  await expect(captured?.effects?.inspectReplay(1, 'edit_file', {})).rejects.toThrow();
  expect(calls).toBe(1);
  raw.resolve({ outcome: 'miss' });
  await expect(inspection).rejects.toMatchObject({ code: 'receipt_scope_ended' });
  await until(() => departed);
  expect(await departure).toEqual({
    kind: 'closed',
    moneyDurability: 'durable',
    effectNeedsAttention: false,
  });
  expect(await host.runLeases.read(handle.runId)).toBeUndefined();
  expect(thenReads).toBe(0);
});
