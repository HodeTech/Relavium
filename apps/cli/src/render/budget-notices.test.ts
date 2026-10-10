import { RunEventSchema, type RunEvent } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { captureIo } from '../test-support.js';
import { createPlainRenderer } from './renderer.js';
import { initialRunViewState, MAX_WARNINGS, reduceRunEvent } from './tui/run-view-model.js';

interface View {
  push(event: RunEvent): void;
  lines(): readonly string[];
}

describe('TUI budget notice lifecycle', () => {
  it('retains one active identity per run/node when a later gate replaces it', () => {
    let state = initialRunViewState();
    for (let i = 0; i < 30; i++) {
      state = reduceRunEvent(state, pause(i + 1, { gateId: `gate-${i}` }));
      expect(state.pendingBudgetNotices).toHaveLength(1);
    }
    expect(state.pendingBudgetNotices[0]?.gateId).toBe('gate-29');
    expect(state.warnings).toHaveLength(MAX_WARNINGS);
  });

  for (const body of [
    {
      type: 'budget:authorization',
      authorization: {
        state: 'decided',
        allowance: { kind: 'legacy_no_allowance' },
        decision: 'approved',
        decidedBy: 'cli',
      },
    },
    { type: 'human_gate:resumed', decision: 'approved', decidedBy: 'cli' },
    { type: 'run:cancelled' },
  ]) {
    it(`releases active identity on ${body.type}`, () => {
      const state = reduceRunEvent(reduceRunEvent(initialRunViewState(), pause(1)), event(2, body));
      expect(state.pendingBudgetNotices).toEqual([]);
    });
  }
});

const views: readonly { name: string; readonly create: () => View }[] = [
  {
    name: 'plain',
    create: () => {
      const { io, out } = captureIo();
      const renderer = createPlainRenderer(io);
      return {
        push: (event) => renderer.onEvent(event),
        lines: () => out().split('\n'),
      };
    },
  },
  {
    name: 'TUI',
    create: () => {
      let state = initialRunViewState();
      return {
        push: (event) => {
          state = reduceRunEvent(state, event);
        },
        lines: () => state.warnings,
      };
    },
  },
];

function event(sequenceNumber: number, body: Record<string, unknown>): RunEvent {
  return RunEventSchema.parse({
    runId: 'run',
    nodeId: 'node',
    gateId: 'gate',
    timestamp: '2026-10-03T00:00:00.000Z',
    sequenceNumber,
    ...body,
  });
}

function pause(sequenceNumber: number, identity: Record<string, string> = {}): RunEvent {
  return event(sequenceNumber, {
    type: 'budget:authorization',
    authorization: {
      state: 'paused',
      allowance: { kind: 'legacy_no_allowance' },
      spentMicrocents: 11,
      limitMicrocents: 10,
    },
    ...identity,
  });
}

function human(sequenceNumber: number, identity: Record<string, string> = {}): RunEvent {
  return event(sequenceNumber, {
    type: 'human_gate:paused',
    gateType: 'approval',
    message: 'Ordinary approval',
    ...identity,
  });
}

function humanLines(view: View): readonly string[] {
  return view
    .lines()
    .filter((line) => line.includes('paused at gate') || line.includes('awaiting decision'));
}

for (const { name, create } of views) {
  describe(`${name} budget notice identity`, () => {
    it('joins authority and both matching companions exactly once', () => {
      const view = create();
      view.push(pause(1));
      view.push(event(2, { type: 'budget:paused', spentMicrocents: 11, limitMicrocents: 10 }));
      view.push(human(3));
      expect(view.lines().filter((line) => line.includes('budget gate'))).toHaveLength(1);
      expect(humanLines(view)).toEqual([]);
    });

    for (const identity of [{ nodeId: 'another-node' }, { runId: 'another-run' }]) {
      it(`does not hide an unrelated human gate sharing gateId: ${JSON.stringify(identity)}`, () => {
        const view = create();
        view.push(pause(1));
        view.push(human(2, identity));
        expect(humanLines(view)).toHaveLength(1);
      });
    }

    it('keeps distinct budget identities even when sanitized labels coincide', () => {
      const view = create();
      view.push(pause(1, { gateId: 'gate\u202e' }));
      view.push(pause(2));
      expect(view.lines().filter((line) => line.includes('budget gate'))).toHaveLength(2);
    });

    it('does not turn a matching companion into a human gate after warnings scroll away', () => {
      const view = create();
      view.push(pause(1));
      for (let i = 0; i < MAX_WARNINGS + 1; i++) {
        view.push(
          event(i + 2, {
            type: 'budget:warning',
            spentMicrocents: 9,
            limitMicrocents: 10,
            thresholdPct: 90,
          }),
        );
      }
      view.push(human(MAX_WARNINGS + 3));
      expect(humanLines(view)).toEqual([]);
    });
  });
}
