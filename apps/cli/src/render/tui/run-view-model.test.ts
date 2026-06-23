import type { RunEvent } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import {
  initialRunViewState,
  MAX_TOKEN_CHARS,
  MAX_TOOL_LINES,
  reduceRunEvent,
  type RunViewState,
} from './run-view-model.js';

const TS = '2026-06-23T12:00:00.000Z';
const RUN = 'run-1';

/** Fold a list of events through the reducer from the initial state. */
function reduceAll(events: readonly RunEvent[]): RunViewState {
  return events.reduce(reduceRunEvent, initialRunViewState());
}

describe('reduceRunEvent', () => {
  it('starts empty', () => {
    const s = initialRunViewState();
    expect(s.nodeOrder).toEqual([]);
    expect(s.cumulativeCostMicrocents).toBe(0);
    expect(s.gapDetected).toBe(false);
    expect(s.summary).toBeUndefined();
  });

  it('records the runId from run:started', () => {
    const s = reduceAll([
      {
        type: 'run:started',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 1,
        workflowId: '00000000-0000-4000-8000-000000000001',
        inputs: {},
        executionMode: 'local',
      },
    ]);
    expect(s.runId).toBe(RUN);
  });

  it('tracks per-node status transitions in first-seen order', () => {
    const s = reduceAll([
      {
        type: 'node:started',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 1,
        nodeId: 'a',
        nodeType: 'agent',
      },
      {
        type: 'node:started',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 2,
        nodeId: 'b',
        nodeType: 'transform',
      },
      {
        type: 'node:completed',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 3,
        nodeId: 'a',
        output: null,
        tokensUsed: { input: 1, output: 2 },
        durationMs: 420,
      },
      {
        type: 'node:failed',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 4,
        nodeId: 'b',
        error: { code: 'provider_unavailable', message: 'boom', retryable: false },
      },
    ]);
    expect(s.nodeOrder).toEqual(['a', 'b']);
    expect(s.nodes['a']?.status).toBe('completed');
    expect(s.nodes['a']?.durationMs).toBe(420);
    expect(s.nodes['a']?.nodeType).toBe('agent');
    expect(s.nodes['b']?.status).toBe('failed');
    expect(s.nodes['b']?.errorCode).toBe('provider_unavailable');
  });

  it('streams tokens into the active node and resets the buffer when the active node changes', () => {
    const s = reduceAll([
      {
        type: 'node:started',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 1,
        nodeId: 'a',
        nodeType: 'agent',
      },
      {
        type: 'agent:token',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 2,
        nodeId: 'a',
        token: 'Hel',
        model: 'claude',
      },
      {
        type: 'agent:token',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 3,
        nodeId: 'a',
        token: 'lo',
        model: 'claude',
      },
    ]);
    expect(s.activeNodeId).toBe('a');
    expect(s.activeModel).toBe('claude');
    expect(s.activeTokens).toBe('Hello');

    const s2 = reduceRunEvent(s, {
      type: 'node:started',
      runId: RUN,
      timestamp: TS,
      sequenceNumber: 4,
      nodeId: 'b',
      nodeType: 'agent',
    });
    expect(s2.activeNodeId).toBe('b');
    expect(s2.activeTokens).toBe(''); // a fresh node's output region starts clean
  });

  it('bounds the active token buffer to the trailing MAX_TOKEN_CHARS (never drops events, only the displayed tail)', () => {
    const big = 'x'.repeat(MAX_TOKEN_CHARS + 500);
    const s = reduceAll([
      {
        type: 'node:started',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 1,
        nodeId: 'a',
        nodeType: 'agent',
      },
      {
        type: 'agent:token',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 2,
        nodeId: 'a',
        token: big,
        model: 'm',
      },
    ]);
    expect(s.activeTokens.length).toBe(MAX_TOKEN_CHARS);
  });

  it('accumulates cost from cost:updated and snapshots the run total at completion', () => {
    const s = reduceAll([
      {
        type: 'cost:updated',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 1,
        nodeId: 'a',
        model: 'm',
        inputTokens: 10,
        outputTokens: 5,
        costMicrocents: 1_000_000,
        cumulativeCostMicrocents: 1_000_000,
      },
      {
        type: 'cost:updated',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 2,
        nodeId: 'b',
        model: 'm',
        inputTokens: 10,
        outputTokens: 5,
        costMicrocents: 2_000_000,
        cumulativeCostMicrocents: 3_000_000,
      },
    ]);
    expect(s.cumulativeCostMicrocents).toBe(3_000_000);

    const done = reduceRunEvent(s, {
      type: 'run:completed',
      runId: RUN,
      timestamp: TS,
      sequenceNumber: 3,
      outputs: {},
      totalTokensUsed: { input: 20, output: 10 },
      totalCostMicrocents: 3_000_000,
      durationMs: 1234,
    });
    expect(done.summary).toEqual({
      outcome: 'completed',
      totalCostMicrocents: 3_000_000,
      totalTokens: { input: 20, output: 10 },
      durationMs: 1234,
    });
  });

  it('captures compact, bounded tool lines', () => {
    const events: RunEvent[] = [
      {
        type: 'node:started',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 1,
        nodeId: 'a',
        nodeType: 'agent',
      },
    ];
    for (let i = 0; i < MAX_TOOL_LINES + 3; i += 1) {
      events.push({
        type: 'agent:tool_call',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: i + 2,
        nodeId: 'a',
        model: 'm',
        toolId: `tool-${i}`,
      });
    }
    const s = reduceAll(events);
    expect(s.toolLines.length).toBe(MAX_TOOL_LINES); // bounded to the trailing window
    expect(s.toolLines.at(-1)).toBe(`→ tool-${MAX_TOOL_LINES + 2}`);
  });

  it('renders a tool_result line with a success marker and a clipped summary', () => {
    const s = reduceAll([
      {
        type: 'agent:tool_result',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 1,
        nodeId: 'a',
        toolId: 'read_file',
        success: true,
        outputSummary: 'ok',
      },
    ]);
    expect(s.toolLines).toEqual(['✓ read_file: ok']);
  });

  it('detects a sequenceNumber gap and warns (no drop in-process, so a gap signals a defect)', () => {
    const s = reduceAll([
      {
        type: 'node:started',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 1,
        nodeId: 'a',
        nodeType: 'agent',
      },
      // jump 2 -> 5: a gap of 3 missing events
      {
        type: 'node:completed',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 5,
        nodeId: 'a',
        output: null,
        tokensUsed: { input: 0, output: 0 },
        durationMs: 1,
      },
    ]);
    expect(s.gapDetected).toBe(true);
    expect(s.warnings.some((w) => w.includes('#1 → #5'))).toBe(true);
  });

  it('does not flag a gap for contiguous sequence numbers', () => {
    const s = reduceAll([
      {
        type: 'node:started',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 1,
        nodeId: 'a',
        nodeType: 'agent',
      },
      {
        type: 'node:completed',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 2,
        nodeId: 'a',
        output: null,
        tokensUsed: { input: 0, output: 0 },
        durationMs: 1,
      },
    ]);
    expect(s.gapDetected).toBe(false);
    expect(s.warnings).toEqual([]);
  });

  it('records a node:retrying transition with the attempt and a warning', () => {
    const s = reduceAll([
      {
        type: 'node:started',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 1,
        nodeId: 'a',
        nodeType: 'agent',
      },
      {
        type: 'node:retrying',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 2,
        nodeId: 'a',
        attemptNumber: 1,
        error: { code: 'provider_rate_limit', message: 'slow down', retryable: true },
        delayMs: 500,
      },
    ]);
    expect(s.nodes['a']?.status).toBe('retrying');
    expect(s.nodes['a']?.attempt).toBe(1);
    expect(s.warnings.some((w) => w.includes('retrying'))).toBe(true);
  });

  it('maps each terminal/parked event to a summary outcome', () => {
    const failed = reduceRunEvent(initialRunViewState(), {
      type: 'run:failed',
      runId: RUN,
      timestamp: TS,
      sequenceNumber: 1,
      error: { code: 'provider_unavailable', message: 'down', retryable: false },
      partialOutputs: {},
    });
    expect(failed.summary).toMatchObject({
      outcome: 'failed',
      errorCode: 'provider_unavailable',
      errorMessage: 'down',
    });

    const cancelled = reduceRunEvent(initialRunViewState(), {
      type: 'run:cancelled',
      runId: RUN,
      timestamp: TS,
      sequenceNumber: 1,
    });
    expect(cancelled.summary).toEqual({ outcome: 'cancelled' });

    const paused = reduceRunEvent(initialRunViewState(), {
      type: 'run:paused',
      runId: RUN,
      timestamp: TS,
      sequenceNumber: 1,
      pendingGateCount: 1,
      gateIds: ['g1'],
    });
    expect(paused.summary).toEqual({ outcome: 'paused', pausedGateIds: ['g1'] });
  });

  it('does not mutate the input state (pure reducer)', () => {
    const s0 = initialRunViewState();
    const s1 = reduceRunEvent(s0, {
      type: 'node:started',
      runId: RUN,
      timestamp: TS,
      sequenceNumber: 1,
      nodeId: 'a',
      nodeType: 'agent',
    });
    expect(s0.nodeOrder).toEqual([]); // original untouched
    expect(s1.nodeOrder).toEqual(['a']);
    expect(s1).not.toBe(s0);
  });
});
