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

  it('projects every untrusted terminal value safely while retaining readable final-summary content (#57)', () => {
    const attack = '\x1b[2J\x1b]52;c;Zm9v\x07\x1bPtmux;\x1b\\\x9b2J\r\b\u202E';
    const nodeId = `node visible${attack}\nforged node row`;
    const state: RunViewState = {
      ...initialRunViewState(),
      nodeOrder: [nodeId],
      nodes: {
        [nodeId]: {
          nodeId,
          status: 'failed',
          errorCode: `node error visible${attack}\nforged node suffix`,
        },
      },
      producedMedia: [
        {
          nodeId: `media node visible${attack}\nforged media node`,
          mimeType: `image/png visible${attack}\nforged mime`,
          handle: `media://visible${attack}\nforged handle`,
        },
      ],
      summary: {
        outcome: 'failed',
        errorCode: `run error visible${attack}\nforged run suffix`,
        errorMessage: `failure visible${attack}\nsecond failure line`,
      },
    };
    const paused: RunViewState = {
      ...state,
      summary: {
        outcome: 'paused',
        pausedGateIds: [`gate visible${attack}\nforged gate`],
      },
    };

    const output = `${renderFinalSummary(state)}${renderFinalSummary(paused)}`;
    for (const forbidden of ['\x1b', '\x9b', '\r', '\b', '\u202E']) {
      expect(output).not.toContain(forbidden);
    }
    expect(output).toContain('run error visible');
    expect(output).toContain('failure visible');
    expect(output).toContain('second failure line'); // summary errors stay readable after a newline collapses
    expect(output).toContain('node visible');
    expect(output).toContain('node error visible');
    expect(output).toContain('image/png visible');
    expect(output).toContain('media://visible');
    expect(output).toContain('media node visible');
    expect(output).toContain('gate visible');
  });

  it('keeps an untrusted failure message on its one summary row (it cannot forge a node status)', () => {
    const state: RunViewState = {
      ...initialRunViewState(),
      summary: {
        outcome: 'failed',
        errorMessage: 'provider failed\n  ✓ deploy completed',
      },
    };

    const lines = renderFinalSummary(state).trimEnd().split('\n');
    expect(lines).toHaveLength(2); // headline + one labeled error row; no forged third status row
    expect(lines[1]).toContain('provider failed');
    expect(lines[1]).toContain('✓ deploy completed');
    expect(lines).not.toContain('  ✓ deploy completed');
  });
});
