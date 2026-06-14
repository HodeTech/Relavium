import type { AbortSignalLike } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import type { NodeExecContext, NodeOutcome } from '../node-executor.js';
import type { HumanGatePlanConfig, PlanVertex } from '../../run-plan.js';
import { createHumanGateNodeExecutor } from './human-gate.js';

const LIVE: AbortSignalLike = {
  aborted: false,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};
const ABORTED: AbortSignalLike = { ...LIVE, aborted: true };

/** Reads NOT-aborted once (passing the handler's entry guard), then aborted — so the abort surfaces from
 *  inside resolveTemplate and is caught, pinning the cancel-during-resolution window. */
function abortAfterFirstRead(): AbortSignalLike {
  let reads = 0;
  return {
    get aborted() {
      return reads++ > 0;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
}

type GateNode = HumanGatePlanConfig['node'];

function gateVertex(node: Partial<GateNode> & Pick<GateNode, 'gate_type'>): PlanVertex {
  const full: GateNode = { id: 'g', type: 'human_gate', ...node };
  return {
    id: 'g',
    type: 'human_in_the_loop',
    dependencies: [],
    dependents: [],
    inputSites: [],
    config: { kind: 'human_in_the_loop', node: full },
  };
}

function ctxFor(
  vertex: PlanVertex,
  opts: {
    inputs?: Record<string, unknown>;
    runOutputs?: ReadonlyMap<string, unknown>;
    signal?: AbortSignalLike;
  } = {},
): NodeExecContext {
  return {
    vertex,
    runOutputs: opts.runOutputs ?? new Map(),
    inputs: opts.inputs ?? {},
    secretInputNames: new Set(),
    toolPolicy: {},
    emit: () => undefined,
    signal: opts.signal ?? LIVE,
    attemptNumber: 1,
  };
}

/** Narrow a NodeOutcome to its `paused` arm (no `as`), surfacing the gate request. */
function gateOf(out: NodeOutcome): Extract<NodeOutcome, { kind: 'paused' }>['gate'] {
  if (out.kind !== 'paused') {
    throw new Error(`expected a paused outcome, got '${out.kind}'`);
  }
  return out.gate;
}

const handler = createHumanGateNodeExecutor();

describe('createHumanGateNodeExecutor', () => {
  it('resolves message_template + assignee against inputs / run.outputs', async () => {
    const vertex = gateVertex({
      gate_type: 'approval',
      assignee: '{{inputs.reviewer}}',
      message_template: 'Approve {{inputs.file}} (score {{run.outputs["scan"].score}})?',
    });
    const out = await handler.execute(
      ctxFor(vertex, {
        inputs: { reviewer: 'cem@example.com', file: 'auth.ts' },
        runOutputs: new Map([['scan', { score: 4 }]]),
      }),
    );
    const gate = gateOf(out);
    expect(gate.gateType).toBe('approval');
    expect(gate.message).toBe('Approve auth.ts (score 4)?');
    expect(gate.assignee).toBe('cem@example.com');
    expect(gate.timeoutMs).toBeUndefined();
    expect(gate.timeoutAction).toBeUndefined();
  });

  it('defaults timeout_action to the safe reject when timeout_ms is set without an action', async () => {
    const gate = gateOf(
      await handler.execute(ctxFor(gateVertex({ gate_type: 'review', timeout_ms: 60000 }))),
    );
    expect(gate.timeoutMs).toBe(60000);
    expect(gate.timeoutAction).toBe('reject');
  });

  it('passes through an explicit timeout_action: approve', async () => {
    const gate = gateOf(
      await handler.execute(
        ctxFor(gateVertex({ gate_type: 'approval', timeout_ms: 1000, timeout_action: 'approve' })),
      ),
    );
    expect(gate.timeoutAction).toBe('approve');
  });

  it('omits the message when no template is authored (an empty, schema-valid string)', async () => {
    const gate = gateOf(await handler.execute(ctxFor(gateVertex({ gate_type: 'input' }))));
    expect(gate.message).toBe('');
    expect(gate.assignee).toBeUndefined();
  });

  it('returns cancelled when the signal is already aborted', async () => {
    const out = await handler.execute(ctxFor(gateVertex({ gate_type: 'approval' }), { signal: ABORTED }));
    expect(out.kind).toBe('failed');
    if (out.kind === 'failed') {
      expect(out.error.code).toBe('cancelled');
      expect(out.error.retryable).toBe(false);
    }
  });

  it('returns cancelled (not validation) when the signal aborts DURING template resolution', async () => {
    const out = await handler.execute(
      ctxFor(gateVertex({ gate_type: 'approval', message_template: '{{inputs.x}}' }), {
        inputs: { x: 'v' },
        signal: abortAfterFirstRead(), // passes the entry guard, then aborts inside resolveTemplate
      }),
    );
    expect(out.kind).toBe('failed');
    if (out.kind === 'failed') {
      expect(out.error.code).toBe('cancelled'); // an abort is a deliberate cancel, not a data fault
    }
  });

  it('maps a template interpolation failure to a fatal validation outcome', async () => {
    // read_file with no injected capability throws InterpolationError → the handler returns `validation`.
    const out = await handler.execute(
      ctxFor(gateVertex({ gate_type: 'approval', message_template: '{{inputs.p | read_file}}' }), {
        inputs: { p: 'secret.txt' },
      }),
    );
    expect(out.kind).toBe('failed');
    if (out.kind === 'failed') {
      expect(out.error.code).toBe('validation');
      expect(out.error.retryable).toBe(false);
    }
  });

  it('fails loud (internal) if handed a non-gate node', async () => {
    const wrong: PlanVertex = {
      id: 'x',
      type: 'output',
      dependencies: [],
      dependents: [],
      inputSites: [],
      config: { kind: 'output', node: { id: 'x', type: 'output' } },
    };
    const out = await handler.execute(ctxFor(wrong));
    expect(out.kind).toBe('failed');
    if (out.kind === 'failed') {
      expect(out.error.code).toBe('internal');
    }
  });
});
