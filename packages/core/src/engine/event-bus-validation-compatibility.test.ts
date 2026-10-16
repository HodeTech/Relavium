import type { RunOrSessionEvent } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  RunEventBus,
  RunLoopInvariantError,
  type RunEventDraft,
  type RunEventBusOptions,
} from '../index.js';

const timestamp = '2026-10-16T00:00:00.000Z';
const badCost: RunEventDraft = {
  type: 'cost:updated',
  runId: 'run-cost',
  nodeId: 'node',
  model: 'model',
  inputTokens: 0,
  outputTokens: 0,
  costMicrocents: -1,
  cumulativeCostMicrocents: 0,
};
function token(key: { runId: string } | { sessionId: string }): RunEventDraft {
  return { type: 'agent:token', ...key, nodeId: 'node', token: 'unchanged token', model: 'model' };
}

describe('exported event bus validation compatibility (#274)', () => {
  it.each([undefined, true])(
    'default/true validation rejects actual invalid payload without consuming sequence: %s',
    (validate) => {
      const options: RunEventBusOptions = {
        now: () => timestamp,
        ...(validate === undefined ? {} : { validate }),
      };
      const bus = new RunEventBus(options);
      const listener = vi.fn();
      bus.subscribe(listener);
      expect(() => bus.emit(badCost)).toThrow();
      expect(listener).not.toHaveBeenCalled();
      expect(bus.emit(token({ runId: 'run-cost' })).sequenceNumber).toBe(0);
    },
  );

  it('validate false accepts actual invalid payload while retaining exact stamping and delivery', () => {
    const bus = new RunEventBus({ now: () => timestamp, validate: false });
    const delivered: RunOrSessionEvent[] = [];
    bus.subscribe((event) => delivered.push(event));
    const event = bus.emit(badCost);
    expect(event, 'validation opt-out accepts a negative runtime-invalid cost').toEqual({
      ...badCost,
      timestamp,
      sequenceNumber: 0,
    });
    expect(delivered).toEqual([event]);
    expect(bus.emit(token({ runId: 'run-cost' })).sequenceNumber).toBe(1);
    expect(delivered).toHaveLength(2);
  });

  it.each([
    {
      code: 'both_correlation_keys',
      draft: {
        type: 'agent:token',
        runId: 'same-key',
        sessionId: 'session-key',
        nodeId: 'node',
        token: 'x',
        model: 'm',
      },
    },
    {
      code: 'no_correlation_key',
      draft: { type: 'agent:token', nodeId: 'node', token: 'x', model: 'm' },
    },
  ] satisfies readonly { code: string; draft: RunEventDraft }[])(
    'validate false retains mandatory $code without clock, listener or counter effects',
    ({ code, draft }) => {
      const now = vi.fn(() => timestamp);
      const listener = vi.fn();
      const bus = new RunEventBus({ now, validate: false });
      bus.subscribe(listener);
      let caught: unknown;
      try {
        bus.emit(draft);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RunLoopInvariantError);
      if (!(caught instanceof RunLoopInvariantError))
        throw new Error('missing typed invariant failure');
      expect(caught.code, 'correlation ownership cannot be bypassed by validate false').toBe(code);
      expect(now).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
      expect(bus.emit(token({ runId: 'same-key' })).sequenceNumber).toBe(0);
      expect(bus.emit(token({ sessionId: 'session-key' })).sequenceNumber).toBe(0);
    },
  );

  it('preserves exact dual-arm fields and independent run/session gap-free sequences', () => {
    const bus = new RunEventBus({ now: () => timestamp, validate: false });
    const drafts = [
      token({ runId: 'r' }),
      token({ sessionId: 's' }),
      token({ runId: 'r' }),
      token({ sessionId: 's' }),
    ];
    expect(drafts.map((draft) => bus.emit(draft))).toEqual(
      drafts.map((draft, index) => ({
        ...draft,
        timestamp,
        sequenceNumber: Math.floor(index / 2),
      })),
    );
  });
});
