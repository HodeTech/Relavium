import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { waitFor } from './harness-util.js';
import { RunApp } from './RunApp.js';
import type { RunStore, RunStoreSnapshot } from './run-store.js';
import type { RunViewState } from './run-view-model.js';

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
      activeTokens: `token visible${ATTACK}\nsecond token visible`,
      toolLines: [`tool visible${ATTACK}\nforged tool row`],
      cumulativeCostMicrocents: 0,
      gapDetected: false,
      warnings: [`warning visible${ATTACK}\nforged warning row`],
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
    expect(frame).toContain('tool visible');
    expect(frame).toContain('warning visible');
    expect(frame).toContain('image/png visible');
    expect(frame).toContain('media://visible');
  });
});
