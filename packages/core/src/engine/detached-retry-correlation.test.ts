import { expect, it } from 'vitest';
import type { RunEvent } from '@relavium/shared';
import { parseWorkflow } from '../parser.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost } from './execution-host.js';

for (const failingAttempt of [1, 2, 3, undefined]) {
  it(`keeps the entered attempt when retry scheduling fails (${String(failingAttempt ?? 'live')})`, async () => {
    const base = createInMemoryHost();
    let faults = 0;
    let conversions = 0;
    const privateCause = {
      get toString(): () => string {
        conversions += 1;
        throw new Error('PRIVATE-RETRY-CONVERSION');
      },
    };
    const host: typeof base = {
      ...base,
      setTimer: (ms, fire, kind) => {
        if (kind === undefined && ms === failingAttempt) {
          faults += 1;
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- hostile host cause must remain opaque
          throw privateCause;
        }
        return base.setTimer(ms, fire, kind);
      },
    };
    const attempts: number[] = [];
    const handle = new WorkflowEngine({
      host,
      executor: {
        execute: (ctx) => {
          attempts.push(ctx.attemptNumber);
          return ctx.attemptNumber === 4
            ? Promise.resolve({ kind: 'completed', output: 'answer' })
            : Promise.resolve({
                kind: 'failed',
                error: {
                  code: 'provider_unavailable',
                  message: 'temporary outage',
                  retryable: true,
                },
              });
        },
      },
    }).start({
      workflow: parseWorkflow(
        JSON.stringify({
          schema_version: '1.0',
          workflow: {
            id: 'detached-retry-correlation',
            agents: [
              { id: 'worker', model: 'offline-model', provider: 'openai', system_prompt: 'go' },
            ],
            nodes: [
              {
                id: 'work',
                type: 'agent',
                agent_ref: 'worker',
                prompt_template: 'go',
                retry: { max: 4, backoff: 'linear', backoff_ms: 1 },
              },
            ],
            edges: [],
          },
        }),
      ),
    });
    const events: RunEvent[] = [];
    const drained = (async () => {
      for await (const event of handle.events) {
        events.push(event);
        if (event.type === 'node:retrying' && event.attemptNumber !== failingAttempt) {
          for (let turn = 0; turn < 1000 && host.armedCount() === 0; turn += 1)
            await Promise.resolve();
          expect(host.armedCount()).toBe(1);
          host.fireTimers();
        }
      }
    })();
    try {
      await drained;
      expect(attempts).toEqual(Array.from({ length: failingAttempt ?? 4 }, (_, i) => i + 1));
      const starts = events.filter((event) => event.type === 'node:started');
      expect(starts.map((event) => event.attemptNumber ?? 1)).toEqual(attempts);
      const failures = events.filter((event) => event.type === 'node:failed');
      if (failingAttempt === undefined) {
        expect(failures).toEqual([]);
        expect(events.at(-1)?.type).toBe('run:completed');
        expect(faults).toBe(0);
      } else {
        expect(faults).toBe(1);
        expect(failures).toHaveLength(1);
        expect(failures[0]?.attemptNumber ?? 1).toBe(failingAttempt);
        expect(failures[0]?.error).toMatchObject({
          code: 'internal',
          message: 'node dispatch failed unexpectedly',
          retryable: false,
        });
        expect(events.at(-1)).toMatchObject({ type: 'run:failed', error: { code: 'internal' } });
      }
      expect(conversions).toBe(0);
      expect(JSON.stringify(events)).not.toContain('PRIVATE');
      await expect.poll(() => host.runLeases.read(handle.runId)).toBeUndefined();
      expect(host.armedCount() + host.deadlineCount() + host.livenessCount()).toBe(0);
    } finally {
      handle.cancel();
      host.fireDeadlines();
      await drained;
    }
  });
}
