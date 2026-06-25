import type { RunEvent } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { renderFinalSummary } from './final-summary.js';
import { initialRunViewState, reduceRunEvent, type RunViewState } from './run-view-model.js';

const TS = '2026-06-23T12:00:00.000Z';
const RUN = 'run-1';

function reduceAll(events: readonly RunEvent[]): RunViewState {
  return events.reduce(reduceRunEvent, initialRunViewState());
}

describe('renderFinalSummary', () => {
  it('summarizes a completed run with cost, duration, tokens, and per-node status', () => {
    const state = reduceAll([
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
        tokensUsed: { input: 10, output: 5 },
        durationMs: 420,
      },
      {
        type: 'run:completed',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 3,
        outputs: {},
        totalTokensUsed: { input: 10, output: 5 },
        totalCostMicrocents: 5_000_000,
        durationMs: 1234,
      },
    ]);
    const out = renderFinalSummary(state);
    expect(out).toContain('run completed');
    expect(out).toContain('$0.0500');
    expect(out).toContain('1.2s');
    expect(out).toContain('↑10 ↓5');
    expect(out).toContain('✓ a (420ms)');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('summarizes a failed run with the error code and message', () => {
    const state = reduceAll([
      {
        type: 'node:started',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 1,
        nodeId: 'a',
        nodeType: 'agent',
      },
      {
        type: 'node:failed',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 2,
        nodeId: 'a',
        error: { code: 'provider_unavailable', message: 'boom', retryable: false },
      },
      {
        type: 'run:failed',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 3,
        error: { code: 'provider_unavailable', message: 'upstream down', retryable: false },
        partialOutputs: {},
      },
    ]);
    const out = renderFinalSummary(state);
    expect(out).toContain('run failed (provider_unavailable)');
    expect(out).toContain('upstream down');
    expect(out).toContain('✗ a — provider_unavailable');
  });

  it('summarizes a paused run with the gate ids', () => {
    const state = reduceAll([
      {
        type: 'run:paused',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 1,
        pendingGateCount: 1,
        gateIds: ['approve-1'],
      },
    ]);
    expect(renderFinalSummary(state)).toContain('run paused at gate approve-1');
  });

  it('is plain text — no ANSI escape codes (scrollback-safe / --no-color)', () => {
    const state = reduceAll([
      { type: 'run:cancelled', runId: RUN, timestamp: TS, sequenceNumber: 1 },
    ]);
    expect(renderFinalSummary(state).includes(String.fromCharCode(27))).toBe(false);
  });

  it('produces a meaningful summary when no terminal event was received (SIGINT / early exit)', () => {
    const out = renderFinalSummary(initialRunViewState()); // summary undefined → default headline
    expect(out).toContain('run ended');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('lists produced media deliverables (handle + node attribution) under a section (2.S)', () => {
    const handle = `media://sha256-${'a'.repeat(64)}`;
    const state = reduceAll([
      {
        type: 'node:completed',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 1,
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
        durationMs: 5,
      },
      {
        type: 'run:completed',
        runId: RUN,
        timestamp: TS,
        sequenceNumber: 2,
        outputs: {},
        totalTokensUsed: { input: 0, output: 0 },
        totalCostMicrocents: 0,
        durationMs: 9,
      },
    ]);
    const out = renderFinalSummary(state);
    expect(out).toContain('produced media:');
    expect(out).toContain(`◆ image/png ${handle} (painter)`); // handle + node attribution, never bytes
  });

  it('omits the produced-media section when a run emitted none', () => {
    const state = reduceAll([
      { type: 'run:cancelled', runId: RUN, timestamp: TS, sequenceNumber: 1 },
    ]);
    expect(renderFinalSummary(state)).not.toContain('produced media');
  });
});
