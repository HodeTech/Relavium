import { expect, it } from 'vitest';
import type { DurableWriteContext, RunEvent } from '@relavium/shared';
import { parseWorkflow } from '../parser.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost, InMemoryRunStore } from './execution-host.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('does not duplicate the node deadline terminal behind a held retry start and timeout write', async () => {
  const retryEntered = deferred();
  const releaseRetry = deferred();
  const failureEntered = deferred();
  const releaseFailure = deferred();
  class Store extends InMemoryRunStore {
    override async persistEvent(event: RunEvent, context?: DurableWriteContext): Promise<void> {
      if (event.type === 'node:started' && event.attemptNumber === 2) {
        retryEntered.resolve();
        await releaseRetry.promise;
      }
      if (event.type === 'node:failed' && event.error.code === 'run_timeout') {
        failureEntered.resolve();
        await releaseFailure.promise;
      }
      await super.persistEvent(event, context);
    }
  }
  const base = createInMemoryHost({ store: new Store() });
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  let deadlineAt = 0;
  let deadlineEntries = 0;
  const host: typeof base = {
    ...base,
    clock: { now: () => new Date(now).toISOString() },
    setTimer: (ms, fire, kind) => {
      if (kind === 'deadline' && ms === 5000) {
        deadlineAt = now + ms;
        return base.setTimer(
          ms,
          () => {
            expect(now).toBeGreaterThanOrEqual(deadlineAt);
            deadlineEntries += 1;
            fire();
          },
          kind,
        );
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
        return Promise.resolve({
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
    workflow: parseWorkflow(`schema_version: '1.0'
workflow:
  id: retry-deadline
  agents:
    - { id: worker, model: offline-model, provider: openai, system_prompt: go }
  nodes:
    - id: work
      type: agent
      agent_ref: worker
      prompt_template: go
      timeout_ms: 5000
      retry: { max: 2, backoff: linear, backoff_ms: 1 }
  edges: []
`),
  });
  const events: RunEvent[] = [];
  const drained = (async () => {
    for await (const event of handle.events) {
      events.push(event);
      if (event.type === 'node:retrying') {
        for (let turn = 0; turn < 1000 && host.armedCount() === 0; turn += 1)
          await Promise.resolve();
        expect(host.armedCount()).toBeGreaterThan(0);
        host.fireTimers();
      }
    }
  })();
  try {
    await retryEntered.promise;
    expect(attempts).toEqual([1]);
    expect(deadlineAt).toBe(now + 5000);
    now = deadlineAt;
    host.fireDeadlines();
    expect(deadlineEntries).toBe(1);
    releaseRetry.resolve();
    await failureEntered.promise;
    for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();
    releaseFailure.resolve();
    await drained;
    expect(attempts).toEqual([1]);
    expect(events.filter((event) => event.type === 'node:failed')).toMatchObject([
      { nodeId: 'work', attemptNumber: 2, error: { code: 'run_timeout' } },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'run:failed', error: { code: 'run_timeout' } });
    await expect.poll(() => host.runLeases.read(handle.runId)).toBeUndefined();
    expect(host.deadlineCount()).toBe(0);
    expect(host.armedCount()).toBe(0);
    expect(host.livenessCount()).toBe(0);
  } finally {
    releaseRetry.resolve();
    releaseFailure.resolve();
    handle.cancel();
    host.fireDeadlines();
    await drained;
  }
});
