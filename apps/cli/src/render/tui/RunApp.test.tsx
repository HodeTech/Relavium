import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { waitFor } from './harness-util.js';
import { RunApp } from './RunApp.js';
import type { RunStore, RunStoreSnapshot } from './run-store.js';
import {
  initialRunViewState,
  reduceRunEvent,
  MAX_ACTIVE_TOKEN_LINES,
  type RunViewState,
} from './run-view-model.js';

afterEach(cleanup);

/**
 * A deliberately mixed terminal-control payload: CSI cursor/erase, OSC-52 clipboard, DCS passthrough,
 * C1 CSI, C0 carriage-return/backspace, and a bidi override. Each value below also carries a readable
 * label, so this regression proves the display retains content while removing the control channel.
 */
const ATTACK = '\x1b[2J\x1b]52;c;Zm9v\x07\x1bPtmux;\x1b\\\x9b2J\r\b\u202E';

function staticStore(state: RunViewState): RunStore {
  const snapshot: RunStoreSnapshot = { state, tick: 0, color: false };
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
  };
}

describe('RunApp terminal projection', () => {
  it('renders reduced reasoning with a bounded tail in a real color-disabled Ink frame', async () => {
    const text = Array.from({ length: 12 }, (_, i) => `reasoning row ${i}`).join('\n');
    const state = reduceRunEvent(initialRunViewState(), {
      type: 'agent:reasoning',
      runId: 'run-1',
      nodeId: 'thinker',
      model: 'reasoner',
      timestamp: '2026-10-16T00:00:00.000Z',
      sequenceNumber: 1,
      text,
    });
    const { lastFrame } = render(<RunApp store={staticStore(state)} />);
    await waitFor(() => (lastFrame() ?? '').includes('reasoning row 11'));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('thinking · thinker');
    expect(frame).not.toContain('reasoning row 0');
    expect(frame.match(/reasoning row/g)).toHaveLength(MAX_ACTIVE_TOKEN_LINES);
    expect(frame).not.toContain('\x1b');
  });

  it('spreads a model line’s tabs to the terminal’s stops and blanks the host’s marker glyphs in it', async () => {
    const state = reduceRunEvent(initialRunViewState(), {
      type: 'agent:reasoning',
      runId: 'run-1',
      nodeId: 'thinker',
      model: 'reasoner',
      timestamp: '2026-10-16T00:00:00.000Z',
      sequenceNumber: 1,
      text: 'col\tstop › marked ▸ again ⇄ swap',
    });
    const { lastFrame } = render(<RunApp store={staticStore(state)} />);
    await waitFor(() => (lastFrame() ?? '').includes('stop'));
    const frame = lastFrame() ?? '';
    // `col` is three columns, so its tab runs to column 8: five spaces, never the tab character the terminal would stretch by its own stops.
    expect(frame).toContain('col     stop');
    expect(frame).not.toContain('\t');
    for (const marker of ['›', '▸', '⇄']) expect(frame).not.toContain(marker);
    expect(frame).toContain('marked');
  });

  it('keeps the live footer on one row however long the run id is', async () => {
    const runId = `run-${'x'.repeat(300)}`;
    const state = reduceRunEvent(initialRunViewState(), {
      type: 'run:started',
      runId,
      timestamp: '2026-10-16T00:00:00.000Z',
      sequenceNumber: 1,
      workflowId: '00000000-0000-4000-8000-000000000001',
      inputs: {},
      executionMode: 'local',
    });
    const { lastFrame } = render(<RunApp store={staticStore(state)} />);
    await waitFor(() => (lastFrame() ?? '').includes('run run-xxxx'));
    const rows = (lastFrame() ?? '').split('\n').filter((row) => row.includes('xxxx'));
    expect(rows).toHaveLength(1);
    // ink-testing-library draws at 100 columns: a footer that wrapped would be one row per hundred characters of id.
    expect([...(rows[0] ?? '')].length).toBeLessThanOrEqual(100);
  });

  it('shows the run id in the live footer once the run has started (MVP-A2)', async () => {
    const state = reduceRunEvent(initialRunViewState(), {
      type: 'run:started',
      runId: 'run-visible-1',
      timestamp: '2026-10-16T00:00:00.000Z',
      sequenceNumber: 1,
      workflowId: '00000000-0000-4000-8000-000000000001',
      inputs: {},
      executionMode: 'local',
    });
    const { lastFrame } = render(<RunApp store={staticStore(state)} />);
    await waitFor(() => (lastFrame() ?? '').includes('run run-visible-1'));
    expect(lastFrame() ?? '').toContain('run run-visible-1  ·  cost');
  });

  it('removes terminal and bidi controls from every untrusted display field in a real Ink frame (#56)', async () => {
    const nodeId = `node visible${ATTACK}\nforged row`;
    const state: RunViewState = {
      nodeOrder: [nodeId],
      nodes: {
        [nodeId]: {
          nodeId,
          status: 'failed',
          errorCode: `error visible${ATTACK}\nforged suffix`,
        },
      },
      activeNodeId: nodeId,
      activeModel: `model visible${ATTACK}\nforged model`,
      activeReasoning: `reasoning visible${ATTACK}\nsecond reasoning visible`,
      activeTokens: `token visible${ATTACK}\nsecond token visible`,
      toolLines: [`tool visible${ATTACK}\nforged tool row`],
      cumulativeCostMicrocents: 0,
      gapDetected: false,
      warnings: [`warning visible${ATTACK}\nforged warning row`],
      pendingBudgetNotices: [],
      pendingHumanGates: [],
      producedMedia: [
        {
          nodeId: `media node visible${ATTACK}\nforged media node`,
          mimeType: `image/png visible${ATTACK}\nforged mime`,
          handle: `media://visible${ATTACK}\nforged handle`,
        },
      ],
    };

    const { lastFrame } = render(<RunApp store={staticStore(state)} />);
    await waitFor(() => (lastFrame() ?? '').includes('token visible'));
    const frame = lastFrame() ?? '';

    // Ink is explicitly color-disabled above. Any remaining ESC/C1/C0/bidi byte therefore came from the
    // untrusted payload, rather than the renderer's own control protocol.
    for (const forbidden of ['\x1b', '\x9b', '\r', '\b', '\u202E']) {
      expect(frame).not.toContain(forbidden);
    }
    expect(frame).toContain('node visible');
    expect(frame).toContain('error visible');
    expect(frame).toContain('model visible');
    expect(frame).toContain('token visible');
    expect(frame).toContain('reasoning visible');
    expect(frame).toContain('thinking');
    expect(frame).toContain('tool visible');
    expect(frame).toContain('warning visible');
    expect(frame).toContain('image/png visible');
    expect(frame).toContain('media://visible');
  });
});
