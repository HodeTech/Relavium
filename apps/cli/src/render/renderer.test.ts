import { RunEventSchema, type RunEvent } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { captureIo } from '../test-support.js';
import { createJsonRenderer, createPlainRenderer } from './renderer.js';

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

  it('surfaces a produced media handle (handle-only, never bytes) under the node:completed line (2.S)', () => {
    const { io, out } = captureIo();
    const handle = `media://sha256-${'a'.repeat(64)}`;
    createPlainRenderer(io).onEvent(
      ev({
        type: 'node:completed',
        nodeId: 'painter',
        output: {
          content: [
            {
              type: 'media',
              mimeType: 'image/png',
              source: { kind: 'handle', ref: handle },
              byteLength: 9,
            },
          ],
        },
        tokensUsed: { input: 0, output: 0 },
        durationMs: 0,
      }),
    );
    const text = out();
    expect(text).toContain('ok painter');
    expect(text).toContain(`📎 image/png ${handle}`); // the durable handle, indented under the node line
  });
});

describe('createJsonRenderer', () => {
  /** A representative ordered run: lifecycle + a streamed cost event + the run:completed result line. */
  function sequentialRun(): RunEvent[] {
    return [
      ev({
        type: 'run:started',
        sequenceNumber: 0,
        workflowId: '11111111-1111-4111-8111-111111111111',
        inputs: {},
        executionMode: 'local',
      }),
      ev({ type: 'node:started', sequenceNumber: 1, nodeId: 'a', nodeType: 'transform' }),
      ev({
        type: 'cost:updated',
        sequenceNumber: 2,
        nodeId: 'a',
        model: 'm',
        inputTokens: 1,
        outputTokens: 1,
        costMicrocents: 1,
        cumulativeCostMicrocents: 1,
      }),
      ev({
        type: 'node:completed',
        sequenceNumber: 3,
        nodeId: 'a',
        output: 1,
        tokensUsed: { input: 1, output: 1 },
        durationMs: 0,
      }),
      ev({
        type: 'run:completed',
        sequenceNumber: 4,
        outputs: { a: 1 },
        totalTokensUsed: { input: 1, output: 1 },
        totalCostMicrocents: 1,
        durationMs: 0,
      }),
    ];
  }

  it('emits every event as one schema-valid RunEvent per line, in sequenceNumber order, ending in run:completed', () => {
    const { io, out, err } = captureIo();
    const r = createJsonRenderer(io);
    const events = sequentialRun();
    for (const event of events) r.onEvent(event);

    const lines = out().trimEnd().split('\n');
    expect(lines).toHaveLength(events.length); // one line per event, no filtering
    const parsed = lines.map((line, i) => {
      const raw: unknown = JSON.parse(line);
      // Each line is EXACTLY a RunEvent: round-trip equality (not just parse-success) catches a stray
      // field, since RunEventSchema is non-strict and would otherwise silently strip it.
      const event = RunEventSchema.parse(raw);
      expect(event).toEqual(raw);
      expect(raw).toEqual(events[i]); // ...and is verbatim the event it was handed (no reorder/mutation)
      return event;
    });
    expect(parsed.map((e) => e.sequenceNumber)).toEqual([0, 1, 2, 3, 4]); // in monotonic order
    expect(parsed.at(-1)?.type).toBe('run:completed'); // the terminal event IS the result line
    expect(err()).toBe(''); // stdout-only: the JSON renderer never writes to stderr
  });

  it('emits the run:completed result line carrying outputs + totals (no separate summary line)', () => {
    const { io, out } = captureIo();
    createJsonRenderer(io).onEvent(
      ev({
        type: 'run:completed',
        outputs: { report: 'ok' },
        totalTokensUsed: { input: 10, output: 5 },
        totalCostMicrocents: 42,
        durationMs: 7,
      }),
    );
    const lines = out().trimEnd().split('\n');
    expect(lines).toHaveLength(1); // the terminal event is the result line — no extra summary
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      type: 'run:completed',
      outputs: { report: 'ok' },
      totalTokensUsed: { input: 10, output: 5 },
      totalCostMicrocents: 42,
    });
  });

  it('serializes an event verbatim, so an engine-masked secret survives unchanged and is never unwrapped', () => {
    const { io, out } = captureIo();
    // A secret-typed input is masked by the engine as { secret: true, ref } before it reaches a renderer.
    const event = ev({
      type: 'run:started',
      workflowId: '11111111-1111-4111-8111-111111111111',
      inputs: { token: { secret: true, ref: 'keychain://x' } },
      executionMode: 'local',
    });
    createJsonRenderer(io).onEvent(event);
    // The emitted line round-trips to EXACTLY the event it was handed — the renderer adds nothing, drops
    // nothing, and has no path to unwrap the { secret: true, ref } masked shape into a raw value.
    expect(JSON.parse(out().trim())).toEqual(event);
  });

  it('carries a produced media handle verbatim in node:completed.output (the --json leaf of the acceptance)', () => {
    const { io, out } = captureIo();
    const handle = `media://sha256-${'a'.repeat(64)}`;
    // The engine de-inlines bytes to a handle BEFORE the event, so node:completed.output is already handle-only;
    // the NDJSON renderer emits it verbatim, so a machine consumer reads the produced handle off the stream.
    const event = ev({
      type: 'node:completed',
      nodeId: 'painter',
      output: {
        content: [
          {
            type: 'media',
            mimeType: 'image/png',
            source: { kind: 'handle', ref: handle },
            byteLength: 9,
          },
        ],
      },
      tokensUsed: { input: 0, output: 0 },
      durationMs: 0,
    });
    createJsonRenderer(io).onEvent(event);
    const line = out().trim();
    expect(line).toContain(handle); // the handle is on the machine stream...
    expect(JSON.parse(line)).toEqual(event); // ...verbatim (the renderer neither inlines bytes nor drops it)
  });
});
