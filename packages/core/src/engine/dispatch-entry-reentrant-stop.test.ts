import { expect, it } from 'vitest';
import { unwiredEffectJournal } from '@relavium/shared';
import type { RunEvent } from '@relavium/shared';
import { parseWorkflow } from '../parser.js';
import { WorkflowEngine } from './engine.js';
import type { NodeExecutor, NodeOutcome } from './node-executor.js';
import { createInMemoryHost } from './execution-host.js';

for (const seam of ['deadline', 'execute-getter', 'effect-factory'] as const)
  for (const cancelled of [false, true])
    it(`rechecks actual attempt entry after synchronous ${seam} (cancel=${cancelled})`, async () => {
      const base = createInMemoryHost();
      let cancel: () => void = () => undefined;
      let seamEntered = false;
      const enterSeam = () => {
        seamEntered = true;
        if (cancelled) cancel();
      };
      let getterEntries = 0;
      let factoryEntries = 0;
      let executeEntries = 0;
      const receiverMatches: boolean[] = [];
      const host: typeof base = {
        ...base,
        setTimer: (ms, fire, kind) => {
          if (!seamEntered && seam === 'deadline' && ms === 5000 && kind === 'deadline')
            enterSeam();
          return base.setTimer(ms, fire, kind);
        },
      };
      const executor: NodeExecutor = {
        get execute() {
          getterEntries += 1;
          if (seam === 'execute-getter') enterSeam();
          return function (this: NodeExecutor): Promise<NodeOutcome> {
            receiverMatches.push(this === executor);
            executeEntries += 1;
            return Promise.resolve({ kind: 'completed', output: 'answer' });
          };
        },
      };
      const handle = new WorkflowEngine({
        host,
        executor,
        effectJournal: () => {
          factoryEntries += 1;
          if (seam === 'effect-factory') enterSeam();
          return unwiredEffectJournal();
        },
      }).start({
        workflow: parseWorkflow(`schema_version: '1.0'
workflow:
  id: reentrant-stop
  agents:
    - { id: worker, model: offline-model, provider: openai, system_prompt: go }
  nodes:
    - { id: work, type: agent, agent_ref: worker, prompt_template: go, timeout_ms: 5000 }
  edges: []
`),
      });
      cancel = handle.cancel;
      const events: RunEvent[] = [];
      for await (const event of handle.events) events.push(event);
      expect(seamEntered).toBe(true);
      expect(getterEntries).toBe(cancelled && seam === 'deadline' ? 0 : 1);
      expect(factoryEntries).toBe(cancelled && seam !== 'effect-factory' ? 0 : 1);
      expect(executeEntries).toBe(cancelled ? 0 : 1);
      expect(receiverMatches).toEqual(cancelled ? [] : [true]);
      expect(events.at(-1)?.type).toBe(cancelled ? 'run:cancelled' : 'run:completed');
      expect(
        events.filter((event) => event.type === 'node:failed' || event.type === 'node:completed'),
      ).toMatchObject([
        cancelled
          ? { type: 'node:failed', nodeId: 'work', error: { code: 'cancelled' } }
          : { type: 'node:completed', nodeId: 'work', output: 'answer' },
      ]);
      await expect.poll(() => host.runLeases.read(handle.runId)).toBeUndefined();
      expect(host.armedCount()).toBe(0);
      expect(host.livenessCount()).toBe(0);
    });
