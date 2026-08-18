/**
 * `RunHandle.terminalError` — the terminal's `ErrorCode`, captured where a caller cannot miss it.
 *
 * **Why this file exists.** The CLI originally read the code from its own `handle.subscribe(...)`. Two
 * independent reviews measured the same defect: `resumeFromCheckpoint` AWAITS `beginResume`, the resume gate
 * settles `run:failed` inside that await, and `subscribe` is a live bus subscription with no replay — so the
 * caller's observer, registered after the await returns, saw `undefined`. `relavium gate` then reported exit
 * 1 (ordinary failure, safe to re-run) for a run stopped by a possibly-landed external effect, which is the
 * one code that must never be retried.
 */

import type { RunEvent } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { parseWorkflow, type WorkflowDefinition } from '../parser.js';
import { WorkflowEngine } from './engine.js';
import {
  createInMemoryEffectJournalStore,
  createInMemoryHost,
  InMemoryRunStore,
} from './execution-host.js';
import type { NodeExecContext, NodeExecutor, NodeOutcome } from './node-executor.js';

const GATED: WorkflowDefinition = parseWorkflow(
  `schema_version: '1.0'
workflow:
  id: terminal-code-fixture
  nodes:
    - { id: a, type: input }
    - { id: g, type: human_gate, gate_type: approval }
    - { id: out, type: output }
  edges:
    - { from: a, to: g }
    - { from: g, to: out }
`,
);

class Stub implements NodeExecutor {
  execute(ctx: NodeExecContext): Promise<NodeOutcome> {
    return Promise.resolve(
      ctx.vertex.id === 'g'
        ? { kind: 'paused', gate: { gateType: 'approval', message: 'approve?' } }
        : { kind: 'completed', output: ctx.vertex.id },
    );
  }
}

describe('RunHandle.terminalError (effect-journal.md §8)', () => {
  it('is readable by a caller that only receives the handle AFTER the terminal settled', async () => {
    // This reproduces the CLI's exact ordering: `await resumeFromCheckpoint(...)` returns a handle for a run
    // that has ALREADY failed. A `subscribe()` registered at this point receives nothing — which is the
    // whole bug — so the code has to live on the handle.
    const store = new InMemoryRunStore();
    const engineA = new WorkflowEngine({ host: createInMemoryHost({ store }), executor: new Stub() });
    const handleA = engineA.start({ workflow: GATED });
    let gateId = '';
    for await (const event of handleA.events) {
      if (event.type === 'run:paused') {
        gateId = event.gateIds[0] ?? '';
        break; // the process dies here
      }
    }

    const journal = createInMemoryEffectJournalStore();
    await journal
      .for({ kind: 'run', runId: handleA.runId, nodeId: 'out', attempt: 1 })
      .prepare(0, 'http_request', 3, { url: 'https://api.example/x' });

    const engineB = new WorkflowEngine({
      host: createInMemoryHost({ store }),
      executor: new Stub(),
      effectJournal: (correlation) => journal.for(correlation),
      effectResume: journal.resume,
    });
    const handleB = await engineB.resumeFromCheckpoint({
      runId: handleA.runId,
      workflow: GATED,
      gateId,
      decision: { decision: 'approved', decidedBy: 'tester' },
    });

    // A LATE subscriber — what the CLI used to do — sees nothing, because the terminal is already past.
    let lateSaw: string | undefined;
    handleB.subscribe((event) => {
      if (event.type === 'run:failed') lateSaw = event.error.code;
    });
    const drained: RunEvent[] = [];
    for await (const event of handleB.events) drained.push(event);

    expect(lateSaw).toBeUndefined(); // …the defect, pinned so it cannot be reintroduced as "safe"
    expect(handleB.terminalError()).toBe('effect_needs_attention'); // …and the fix
    // The buffered stream carried it all along — which is why only the observer was wrong, not the engine.
    expect(
      drained.some((e) => e.type === 'run:failed' && e.error.code === 'effect_needs_attention'),
    ).toBe(true);
  });

  it('is undefined for a run that did not fail — the negative control', async () => {
    const store = new InMemoryRunStore();
    const engine = new WorkflowEngine({ host: createInMemoryHost({ store }), executor: new Stub() });
    const handle = engine.start({
      workflow: parseWorkflow(
        `schema_version: '1.0'
workflow:
  id: terminal-code-ok
  nodes:
    - { id: a, type: input }
    - { id: out, type: output }
  edges:
    - { from: a, to: out }
`,
      ),
    });
    for await (const event of handle.events) void event;

    expect(handle.terminalError()).toBeUndefined();
  });
});
