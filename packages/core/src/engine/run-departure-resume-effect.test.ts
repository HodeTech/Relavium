import { expect, it } from 'vitest';
import type { RunEvent } from '@relavium/shared';
import { parseWorkflow } from '../parser.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryEffectJournalStore, createInMemoryHost } from './execution-host.js';

for (const effect of ['unresolved', 'unreadable', 'committed'] as const) {
  it(`final departure retains resume effect disposition: ${effect}`, async () => {
    const workflow = parseWorkflow(
      JSON.stringify({
        schema_version: '1.0',
        workflow: {
          id: 'resume-effect-health',
          nodes: [
            { id: 'g', type: 'human_gate', gate_type: 'approval' },
            { id: 'out', type: 'output' },
          ],
          edges: [{ from: 'g', to: 'out' }],
        },
      }),
    );
    const host = createInMemoryHost();
    const first = new WorkflowEngine({
      host,
      executor: {
        execute: () =>
          Promise.resolve({
            kind: 'paused',
            gate: { gateType: 'approval', message: 'approve?' },
          }),
      },
    }).start({ workflow });
    const reader = first.events[Symbol.asyncIterator]();
    let gateId = '';
    for (;;) {
      const next = await reader.next();
      if (next.done) throw new Error('pause required');
      if (next.value.type === 'run:paused') {
        gateId = next.value.gateIds[0] ?? '';
        break;
      }
    }
    expect((await first.depart()).kind).toBe('detached');
    expect((await reader.next()).done).toBe(true);
    const journal = createInMemoryEffectJournalStore();
    if (effect !== 'unreadable') {
      const port = journal.for({ kind: 'run', runId: first.runId, nodeId: 'out', attempt: 1 });
      await port.prepare(0, 'http_request', 3, {});
      if (effect === 'committed') await port.settle(0, 'http_request', 'committed', { ok: true });
    }
    let calls = 0;
    const engine = new WorkflowEngine({
      host,
      effectResume:
        effect === 'unreadable'
          ? { unresolvedForRun: () => Promise.reject(new Error('PRIVATE-JOURNAL-CAUSE')) }
          : journal.resume,
      executor: {
        execute: () => {
          calls++;
          return Promise.resolve({ kind: 'completed', output: 'answer' });
        },
      },
    });
    const handle = await engine.resumeFromCheckpoint({
      runId: first.runId,
      workflow,
      gateId,
      decision: { decision: 'approved', decidedBy: 'tester' },
    });
    const events: RunEvent[] = [];
    for await (const event of handle.events) events.push(event);
    const result = await handle.depart();
    expect(result).toEqual({
      kind: 'closed',
      moneyDurability: 'durable',
      effectNeedsAttention: effect !== 'committed',
    });
    expect(handle.depart()).toBe(handle.depart());
    expect(handle.durability()).toBe('durable');
    expect(handle.terminalError()).toBe(
      effect === 'committed' ? undefined : 'effect_needs_attention',
    );
    expect(events.at(-1)?.type).toBe(effect === 'committed' ? 'run:completed' : 'run:failed');
    expect(calls).toBe(effect === 'committed' ? 1 : 0);
    expect(JSON.stringify({ events, result })).not.toContain('PRIVATE');
    expect(await host.runLeases.read(first.runId)).toBeUndefined();
    expect(host.armedCount() + host.deadlineCount() + host.livenessCount()).toBe(0);
  });
}
