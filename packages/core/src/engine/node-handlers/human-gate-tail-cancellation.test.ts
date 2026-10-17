import type { AbortSignalLike } from '@relavium/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createWorkflowContextProjection,
  ownSecretInputNames,
} from '../../interpolation/provenance.js';
import * as resolver from '../../interpolation/resolve.js';
import type { HumanGatePlanConfig, PlanVertex } from '../../run-plan.js';
import type { NodeExecContext, NodeOutcome } from '../node-executor.js';
import { createHumanGateNodeExecutor } from './human-gate.js';

const originalResolve = resolver.resolvePublicTemplate;
afterEach(() => vi.restoreAllMocks());

function gateVertex(node: Partial<HumanGatePlanConfig['node']> = {}): PlanVertex {
  return {
    id: 'gate',
    type: 'human_in_the_loop',
    dependencies: [],
    dependents: [],
    ancestors: [],
    inputSites: [],
    config: {
      kind: 'human_in_the_loop',
      node: { id: 'gate', type: 'human_gate', gate_type: 'approval', ...node },
    },
  };
}
function contextFor(vertex: PlanVertex, signal: AbortSignalLike): NodeExecContext {
  return {
    vertex,
    signal,
    runOutputs: new Map(),
    inputs: { path: 'review.txt', secret: 'trusted-input-canary' },
    ctx: createWorkflowContextProjection({
      values: { public: 'clean' },
      deniedKeys: ['private'],
      orderedKeys: ['private', 'public'],
    }),
    secretInputNames: ownSecretInputNames(['secret']).secretInputNames,
    toolPolicy: {},
    emit: () => undefined,
    attemptNumber: 1,
  };
}
function assertCancelled(outcome: NodeOutcome): void {
  expect(outcome.kind, 'final gate resolver cancellation owns the handler outcome').toBe('failed');
  if (outcome.kind !== 'failed') throw new Error('expected failed gate outcome');
  expect(outcome.error).toMatchObject({ code: 'cancelled', retryable: false });
}

const messages: readonly Partial<HumanGatePlanConfig['node']>[] = [
  { message_template: '{{inputs.path | read_file}}' },
  { message_template: 'literal message' },
  { message_template: '' },
  {},
];

describe('human gate final resolver cancellation (G9)', () => {
  it.each(messages)(
    'cancel after final message resolution returns failed cancelled rather than paused: %j',
    async (node) => {
      const controller = new AbortController();
      const trace: string[] = [];
      const readFile = vi.fn(() => Promise.resolve('read message'));
      vi.spyOn(resolver, 'resolvePublicTemplate').mockImplementation(async (...args) => {
        const text = await originalResolve(...args);
        expect(args[3]).toBe(controller.signal);
        trace.push('resolver-settled');
        controller.abort();
        trace.push('abort-requested');
        return text;
      });
      const outcome = await createHumanGateNodeExecutor({
        resolverCapabilities: { readFile },
      }).execute(contextFor(gateVertex(node), controller.signal));
      trace.push('handler-outcome');
      expect(trace).toEqual(['resolver-settled', 'abort-requested', 'handler-outcome']);
      expect(readFile).toHaveBeenCalledTimes(node.message_template?.includes('read_file') ? 1 : 0);
      assertCancelled(outcome);
    },
  );

  it.each(['literal reviewer', '{{inputs.path | read_file}}'])(
    'cancel after final assignee resolution never returns a gate: %s',
    async (assignee) => {
      const controller = new AbortController();
      const trace: string[] = [];
      const readFile = vi.fn(() => Promise.resolve('read reviewer'));
      vi.spyOn(resolver, 'resolvePublicTemplate').mockImplementation(async (...args) => {
        const text = await originalResolve(...args);
        trace.push(args[0] === assignee ? 'assignee-settled' : 'message-settled');
        if (args[0] === assignee) {
          controller.abort();
          trace.push('abort-requested');
        }
        return text;
      });
      const outcome = await createHumanGateNodeExecutor({
        resolverCapabilities: { readFile },
      }).execute(
        contextFor(gateVertex({ message_template: 'message first', assignee }), controller.signal),
      );
      trace.push('handler-outcome');
      expect(trace).toEqual([
        'message-settled',
        'assignee-settled',
        'abort-requested',
        'handler-outcome',
      ]);
      assertCancelled(outcome);
    },
  );

  it('live final resolution still returns exact message, assignee and deadline request', async () => {
    const controller = new AbortController();
    const readFile = vi.fn((_path: string, signal?: AbortSignalLike) => {
      expect(signal).toBe(controller.signal);
      expect(_path).toBe('review.txt');
      return Promise.resolve('review text');
    });
    const result = await createHumanGateNodeExecutor({
      resolverCapabilities: { readFile },
    }).execute(
      contextFor(
        gateVertex({
          message_template: '{{inputs.path | read_file}}',
          assignee: 'reviewer',
          timeout_ms: 60000,
        }),
        controller.signal,
      ),
    );
    expect(result).toEqual({
      kind: 'paused',
      gate: {
        gateType: 'approval',
        message: 'review text',
        assignee: 'reviewer',
        timeoutMs: 60000,
        timeoutAction: 'reject',
      },
    });
    expect(readFile).toHaveBeenCalledOnce();
  });

  it.each([
    '{{inputs.secret | default("fallback") | read_file}}',
    '{{ctx.private | default("fallback") | read_file}}',
  ])(
    'live denied reference remains fatal validation before capabilities: %s',
    async (message_template) => {
      const readFile = vi.fn(() => Promise.resolve('unreachable'));
      const outcome = await createHumanGateNodeExecutor({
        resolverCapabilities: { readFile },
      }).execute(contextFor(gateVertex({ message_template }), new AbortController().signal));
      expect(outcome).toMatchObject({
        kind: 'failed',
        error: { code: 'validation', retryable: false },
      });
      expect(readFile).not.toHaveBeenCalled();
    },
  );
});
