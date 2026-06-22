import { RunEventSchema, type RunEvent } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import type { CliIo } from '../process/io.js';
import { createJsonRenderer, createPlainRenderer } from './renderer.js';

function captureIo(): { io: CliIo; out: () => string } {
  const chunks: string[] = [];
  const io: CliIo = {
    writeOut: (text) => {
      chunks.push(text);
    },
    writeErr: () => {
      /* unused */
    },
    env: {},
    stdoutIsTty: false,
  };
  return { io, out: () => chunks.join('') };
}

const ENVELOPE = { runId: 'id-1', sequenceNumber: 0, timestamp: '2026-01-01T00:00:00.000Z' };

/** Build a schema-validated `RunEvent` (no unsafe cast — `.parse()` proves the fixture is real). */
function ev(partial: Record<string, unknown>): RunEvent {
  return RunEventSchema.parse({ ...ENVELOPE, ...partial });
}

describe('createPlainRenderer', () => {
  it('writes a terse line per lifecycle event', () => {
    const { io, out } = captureIo();
    const r = createPlainRenderer(io);
    r.onEvent(
      ev({
        type: 'run:started',
        workflowId: '11111111-1111-4111-8111-111111111111',
        inputs: {},
        executionMode: 'local',
      }),
    );
    r.onEvent(ev({ type: 'node:started', nodeId: 'a', nodeType: 'transform' }));
    r.onEvent(
      ev({
        type: 'node:completed',
        nodeId: 'a',
        output: 1,
        tokensUsed: { input: 0, output: 0 },
        durationMs: 0,
      }),
    );
    r.onEvent(
      ev({
        type: 'run:completed',
        outputs: {},
        totalTokensUsed: { input: 0, output: 0 },
        totalCostMicrocents: 0,
        durationMs: 0,
      }),
    );
    const text = out();
    expect(text).toContain('run id-1 started');
    expect(text).toContain('- a ...');
    expect(text).toContain('ok a');
    expect(text).toContain('run completed');
  });

  it('surfaces a node failure with its error code', () => {
    const { io, out } = captureIo();
    createPlainRenderer(io).onEvent(
      ev({
        type: 'node:failed',
        nodeId: 'x',
        error: { code: 'sandbox_error', message: 'boom', retryable: false },
      }),
    );
    expect(out()).toContain('FAIL x: sandbox_error');
  });

  it('renders a human-gate pause with its gate id and type', () => {
    const { io, out } = captureIo();
    createPlainRenderer(io).onEvent(
      ev({
        type: 'human_gate:paused',
        nodeId: 'g',
        gateId: 'gate-1',
        gateType: 'approval',
        message: 'ok?',
      }),
    );
    expect(out()).toContain('paused at gate gate-1 (approval)');
  });

  it('renders a run failure and a cancellation', () => {
    const { io, out } = captureIo();
    const r = createPlainRenderer(io);
    r.onEvent(
      ev({
        type: 'run:failed',
        error: { code: 'sandbox_error', message: 'b', retryable: false },
        partialOutputs: {},
      }),
    );
    r.onEvent(ev({ type: 'run:cancelled' }));
    expect(out()).toContain('run failed (sandbox_error)');
    expect(out()).toContain('run cancelled');
  });

  it('stays quiet for non-lifecycle detail events (tokens/cost)', () => {
    const { io, out } = captureIo();
    const r = createPlainRenderer(io);
    r.onEvent(ev({ type: 'agent:token', nodeId: 'a', token: 'hi', model: 'm' }));
    r.onEvent(
      ev({
        type: 'cost:updated',
        nodeId: 'a',
        model: 'm',
        inputTokens: 0,
        outputTokens: 0,
        costMicrocents: 0,
        cumulativeCostMicrocents: 0,
      }),
    );
    expect(out()).toBe('');
  });
});

describe('createJsonRenderer', () => {
  it('emits exactly one JSON object per line, round-trippable', () => {
    const { io, out } = captureIo();
    const r = createJsonRenderer(io);
    r.onEvent(
      ev({
        type: 'run:started',
        workflowId: '11111111-1111-4111-8111-111111111111',
        inputs: {},
        executionMode: 'local',
      }),
    );
    r.onEvent(ev({ type: 'run:cancelled' }));
    const lines = out().trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    const first: unknown = JSON.parse(lines[0] ?? '');
    expect(first).toMatchObject({ type: 'run:started', runId: 'id-1', sequenceNumber: 0 });
  });
});
