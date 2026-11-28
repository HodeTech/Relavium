// Captures frames of the application's own chat view for the README's hero (assets/readme/README.md says how to run it).
// It is NOT part of the repository's test suite: it lives outside every workspace's `include`. Renders the real chat components
// through the test harness for a scripted sample session (the words are a sample, the view is the application's) and writes
// the frames, with their ANSI colour, to frames/chat-frames.json.
import '../../../apps/cli/src/render/tui/force-color.js';
import type { SessionStreamHandleEvent } from '@relavium/core';
import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { mountStandaloneChat } from '../../../apps/cli/src/render/tui/surface-matrix/chat-host.js';

const OUT = new URL('./frames/chat-frames.json', import.meta.url).pathname;
let seq = 1;
const ev = (body: Record<string, unknown>): SessionStreamHandleEvent =>
  ({
    sessionId: 'sample-session',
    sequenceNumber: seq++,
    timestamp: '2026-11-28T09:00:00.000Z',
    ...body,
  }) as SessionStreamHandleEvent;

const ASK = 'Turn the steps I do every Friday for the release notes into a workflow';
const ANSWER = [
  'I read CHANGELOG.md and the merged pull requests, then drafted the notes.',
  'The steps repeat the same way each time, so this fits a workflow:',
  'gather the merged changes, draft the notes, and wait for your approval.',
  '/export saves it as release-notes.relavium.yaml.',
].join(' ');

const tool = (store: any, toolId: string, resolve: boolean) => {
  store.apply(
    ev({ type: 'agent:tool_call', nodeId: 'relavium-chat', model: 'm', toolId, toolInput: {} }),
  );
  if (resolve)
    store.apply(
      ev({
        type: 'agent:tool_result',
        nodeId: 'relavium-chat',
        toolId,
        success: true,
        outputSummary: 'ok',
      }),
    );
};

const SCENES: Record<string, (store: any) => void> = {
  done: (store) => {
    store.appendUser(ASK);
    store.apply(ev({ type: 'session:turn_started' }));
    for (const id of ['read_file', 'grep', 'glob']) tool(store, id, true);
    store.apply(ev({ type: 'agent:token', nodeId: 'relavium-chat', model: 'm', token: ANSWER }));
    store.apply(
      ev({
        type: 'session:turn_completed',
        stopReason: 'stop',
        tokensUsed: { input: 1800, output: 240 },
      }),
    );
  },
  running: (store) => {
    store.appendUser(ASK);
    store.apply(ev({ type: 'session:turn_started' }));
    tool(store, 'read_file', true);
    tool(store, 'grep', true);
    tool(store, 'glob', false);
    store.apply(
      ev({
        type: 'agent:token',
        nodeId: 'relavium-chat',
        model: 'm',
        token:
          'The steps repeat the same way each time, so this fits a workflow: gather the merged changes, draft the notes',
      }),
    );
    store.tick();
  },
};

it('captures the chat frames', async () => {
  const frames: Record<string, string[]> = {};
  for (const [name, scene] of Object.entries(SCENES)) {
    seq = 1;
    const m = mountStandaloneChat(
      { renderer: 'alt', color: true, size: { cols: 80, rows: 24 } },
      { standalone: { provider: 'anthropic' }, prepare: scene },
    );
    try {
      await m.settle();
      await m.settle();
      frames[name] = m.frame();
    } finally {
      m.unmount();
    }
  }
  writeFileSync(OUT, JSON.stringify(frames, null, 1));
});
