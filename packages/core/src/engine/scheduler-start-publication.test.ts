import { expect, it } from 'vitest';
import type { RunEvent } from '@relavium/shared';
import { parseWorkflow } from '../parser.js';
import { WorkflowEngine } from './engine.js';
import { createInMemoryHost } from './execution-host.js';

for (const width of [1, 3])
  for (const fault of [false, true])
    it(`owns first-start publication failure without entering work (width=${width}, fault=${fault})`, async () => {
      const base = createInMemoryHost();
      let armed = false;
      let faults = 0;
      const host: typeof base = {
        ...base,
        clock: {
          now: () => {
            if (armed && fault && faults === 0) {
              faults += 1;
              throw new Error('PRIVATE-FIRST-START-CLOCK');
            }
            return base.clock.now();
          },
        },
      };
      let executions = 0;
      const handle = new WorkflowEngine({
        host,
        executor: {
          execute: () => {
            executions += 1;
            return Promise.resolve({ kind: 'completed', output: 'answer' });
          },
        },
      }).start({
        workflow: parseWorkflow(
          JSON.stringify({
            schema_version: '1.0',
            workflow: {
              id: 'scheduler-start-publication',
              nodes: Array.from({ length: width }, (_, index) => ({
                id: `work-${index}`,
                type: 'input',
              })),
              edges: [],
            },
          }),
        ),
      });
      const readiness = handle.whenConsumersReady.bind(handle);
      handle.whenConsumersReady = async () => {
        await readiness();
        armed = true;
      };
      const events: RunEvent[] = [];
      const drained = (async () => {
        for await (const event of handle.events) events.push(event);
      })();
      try {
        for (
          let turn = 0;
          turn < 1000 && !events.some((e) => e.type === 'run:failed' || e.type === 'run:completed');
          turn += 1
        )
          await Promise.resolve();
        // No deadline or grace is fired to manufacture the terminal under test.
        expect(faults).toBe(fault ? 1 : 0);
        expect(events.at(-1)?.type).toBe(fault ? 'run:failed' : 'run:completed');
        await drained;
        expect(executions).toBe(fault ? 0 : width);
        expect(events.filter((e) => e.type === 'node:started')).toHaveLength(fault ? 0 : width);
        const failures = events.filter((e) => e.type === 'node:failed');
        expect(failures).toHaveLength(fault ? 1 : 0);
        if (fault)
          expect(failures[0]).toMatchObject({
            nodeId: 'work-0',
            error: { code: 'internal', message: 'the node start could not be published' },
          });
        expect(
          events.filter((e) => e.type === 'run:failed' || e.type === 'run:completed'),
        ).toHaveLength(1);
        expect(JSON.stringify(events)).not.toContain('PRIVATE');
        await expect.poll(() => host.runLeases.read(handle.runId)).toBeUndefined();
        expect(host.armedCount() + host.deadlineCount() + host.livenessCount()).toBe(0);
      } finally {
        handle.cancel();
        host.fireDeadlines();
        await drained;
      }
    });

for (const inject of [false, true])
  it(`settles a skip-publication fault without external cancellation (${inject})`, async () => {
    const base = createInMemoryHost();
    let armed = false,
      faults = 0;
    const host: typeof base = {
      ...base,
      clock: {
        now: () => {
          if (armed) {
            armed = false;
            faults++;
            throw new Error('PRIVATE-SKIP-CLOCK');
          }
          return base.clock.now();
        },
      },
    };
    const handle = new WorkflowEngine({
      host,
      executor: {
        execute: () =>
          Promise.resolve({
            kind: 'failed',
            error: { code: 'validation', message: 'original node failure', retryable: false },
          }),
      },
    }).start({
      workflow: parseWorkflow(
        JSON.stringify({
          schema_version: '1.0',
          workflow: {
            id: 'skip-publication-failure',
            nodes: [
              { id: 'a', type: 'input' },
              { id: 'b', type: 'output' },
            ],
            edges: [{ from: 'a', to: 'b' }],
          },
        }),
      ),
    });
    const unsubscribe = handle.subscribe((event) => {
      if (inject && event.type === 'node:failed') armed = true;
    });
    const events: RunEvent[] = [];
    const drained = (async () => {
      for await (const event of handle.events) events.push(event);
    })();
    try {
      for (let turn = 0; turn < 1000 && !events.some((e) => e.type === 'run:failed'); turn++)
        await Promise.resolve();
      expect(faults).toBe(inject ? 1 : 0);
      expect(events.at(-1)).toMatchObject({
        type: 'run:failed',
        error: { code: 'validation', message: 'original node failure' },
      });
      expect(events.filter((e) => e.type === 'run:failed')).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain('PRIVATE-SKIP-CLOCK');
    } finally {
      handle.cancel();
      await drained;
      await handle.depart();
      unsubscribe();
    }
  });

for (const outcome of ['completed', 'failed', 'cancelled'] as const)
  for (const site of ['none', 'elapsed', 'stamp', 'id'] as const) {
    if (site === 'id' && outcome !== 'failed') continue;
    it(`settles one unstamped terminal host fault (${outcome}, ${site})`, async () => {
      const base = createInMemoryHost();
      let clockCalls = 0,
        armed = false,
        faults = 0,
        executions = 0;
      const host: typeof base = {
        ...base,
        clock: {
          now: () => {
            if (
              armed &&
              site !== 'none' &&
              site !== 'id' &&
              ++clockCalls === (site === 'elapsed' ? 1 : 2)
            ) {
              faults++;
              throw new Error('PRIVATE-TERMINAL-CLOCK');
            }
            return base.clock.now();
          },
        },
        ids: {
          newId: () => {
            if (armed && site === 'id' && faults === 0) {
              faults++;
              throw new Error('PRIVATE-TERMINAL-ID');
            }
            return base.ids.newId();
          },
        },
      };
      const handle = new WorkflowEngine({
        host,
        executor: {
          execute: () => {
            executions++;
            return Promise.resolve(
              outcome === 'failed'
                ? {
                    kind: 'failed',
                    error: {
                      code: 'validation',
                      message: 'original node failure',
                      retryable: false,
                    },
                  }
                : { kind: 'completed', output: 'answer' },
            );
          },
        },
      }).start({
        workflow: parseWorkflow(
          JSON.stringify({
            schema_version: '1.0',
            workflow: {
              id: 'terminal-preparation-fault',
              nodes: [{ id: 'a', type: 'input' }],
              edges: [],
            },
          }),
        ),
      });
      const unsubscribe = handle.subscribe((event) => {
        if (event.type !== 'node:completed' && event.type !== 'node:failed') return;
        armed = true;
        if (outcome === 'cancelled') handle.cancel();
      });
      const events: RunEvent[] = [];
      let closed = false;
      const drained = (async () => {
        for await (const event of handle.events) events.push(event);
        closed = true;
      })();
      try {
        for (
          let tick = 0;
          tick < 1000 &&
          !events.some(
            (e) =>
              e.type === 'run:completed' || e.type === 'run:failed' || e.type === 'run:cancelled',
          );
          tick++
        )
          await Promise.resolve();
        const expected =
          outcome === 'cancelled'
            ? 'run:cancelled'
            : outcome === 'failed' || site !== 'none'
              ? 'run:failed'
              : 'run:completed';
        expect(events.at(-1)?.type).toBe(expected);
        await drained;
        expect(closed).toBe(true);
        expect(faults).toBe(site === 'none' ? 0 : 1);
        expect(executions).toBe(1);
        const terminal = events.filter(
          (e) =>
            e.type === 'run:completed' || e.type === 'run:failed' || e.type === 'run:cancelled',
        );
        expect(terminal).toHaveLength(1);
        if (expected === 'run:failed')
          expect(terminal[0]).toMatchObject({
            error: {
              code: outcome === 'failed' ? 'validation' : 'internal',
              retryable: false,
            },
          });
        expect(events.map((e) => e.sequenceNumber)).toEqual(
          Array.from({ length: events.length }, (_, i) => i),
        );
        expect(JSON.stringify(events)).not.toContain('PRIVATE-TERMINAL');
        expect(handle.durability()).toBe('durable');
        await expect(handle.depart()).resolves.toMatchObject({ kind: 'closed' });
        expect(await host.runLeases.read(handle.runId)).toBeUndefined();
        expect(base.armedCount() + base.deadlineCount() + base.livenessCount()).toBe(0);
      } finally {
        // A failed assertion must stay an assertion rather than await a stranded primary forever.
        handle.cancel();
        await handle.depart();
        unsubscribe();
      }
    });
  }
