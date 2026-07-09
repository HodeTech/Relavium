import type { ToolApprovalRequest } from '@relavium/core';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import type { ApprovalAnswer } from '../../chat/chat-mode.js';
import type { DoctorProbes } from '../../chat/doctor.js';
import type { HomeSnapshot, HomeStore } from '../../home/home-store.js';
import { createChatStore, type ChatStoreController } from './chat-store.js';
import { RootApp } from './home-app.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeController,
} from './home-controller.js';

/**
 * Mounted-Home component tests (2.6.F Step 3, ADR-0068 part f) — the second surface (after `chat-app.test.tsx`)
 * with an ink-7 `usePaste` channel. The Step-2 migration wired `RootApp`'s native paste to
 * `controller.handlePaste`; this pins that wiring END-TO-END through a mounted `RootApp` + a real stdin write,
 * complementing `home-controller.test.ts` (which drives `handlePaste` directly) and `chat-input.test.ts` (the pure
 * `pasteIsEditable` predicate). The security pin is the same fail-closed property as the standalone chat surface: a
 * bracketed paste can never answer the per-tool approval floor (ADR-0057), because ink routes the whole DECSET-2004
 * block to `usePaste`, which drops it behind the approval gate — it never reaches the `useInput` approval reducer.
 */

/** Yield until ink's React-19 reconciler has committed the frame scheduled by the preceding stdin/controller change. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Wrap a payload in the DECSET-2004 markers ink 7's input parser recognizes → a single `usePaste` event. */
const bracketed = (body: string): string => `\x1b[200~${body}\x1b[201~`;

const STUB_DOCTOR_PROBES: DoctorProbes = { keychain: () => {}, config: () => {}, toolHost: {} };

const EMPTY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  isEmpty: true,
};
const homeStore: HomeStore = { read: () => EMPTY };

const approvalReq: ToolApprovalRequest = {
  toolId: 'write_file',
  action: 'fs_write',
  preview: { path: 'notes.md' },
};

/** A minimal in-Home chat session fake — only the fields `driveHome`/the controller read on the paste path. */
function makeSession(store: ChatStoreController): HomeChatSession {
  return {
    store,
    sessionId: 'sess-fake',
    processLine: async () => {},
    shouldStop: () => false,
    stopReason: () => 'exit',
    teardown: () => Promise.resolve(),
  };
}

/** Build a controller whose `startChat` yields the given session, then mount `RootApp` on the harness. */
function mountHome(store: ChatStoreController): {
  c: HomeController;
  harness: ReturnType<typeof render>;
} {
  const c = createHomeController({
    doctorProbes: STUB_DOCTOR_PROBES,
    startChat: () => Promise.resolve(makeSession(store)),
    homeStore,
    onExit: vi.fn(),
    onError: vi.fn(),
  });
  const harness = render(
    <RootApp
      controller={c}
      nowMs={() => Date.now()}
      color={false}
      getSize={() => ({ cols: 100, rows: 30 })}
      subscribeResize={() => () => {}}
    />,
  );
  return { c, harness };
}

/** Drive the mounted controller from the bare Home into an in-Home chat (type a first message + Enter). The chat is
 *  entered via the controller directly (deterministic) — the STDIN path is reserved for the paste under test. */
async function enterChat(c: HomeController): Promise<void> {
  c.handleKey('h', {});
  c.handleKey('i', {});
  c.handleKey('', { return: true });
  await flush();
}

describe('RootApp (Home) bracketed paste — usePaste → controller.handlePaste wiring (ADR-0068)', () => {
  it('inserts an idle paste into the in-Home chat buffer', async () => {
    const store = createChatStore(false);
    const { c, harness } = mountHome(store);
    await enterChat(c);
    expect(c.getSnapshot().mode).toBe('chat');

    harness.stdin.write(bracketed('hello world'));
    await flush();
    expect(c.getSnapshot().input.text).toContain('hello world');
    harness.unmount();
  });

  it('SECURITY: a paste during a pending approval neither answers the floor nor leaks into the buffer (ADR-0057)', async () => {
    const store = createChatStore(false);
    const { c, harness } = mountHome(store);
    await enterChat(c);
    let answered: ApprovalAnswer | undefined;
    void store.requestApproval(approvalReq, true).then((a) => {
      answered = a;
    });
    await flush();
    expect(store.getSnapshot().approval).toBeDefined(); // the prompt owns the keyboard

    // Paste characters that AS KEYSTROKES would answer the fail-closed floor ('y'/'a'). The whole block goes to
    // `usePaste` → `handlePaste`, which drops it behind the approval gate (`pasteEditable` refuses it).
    harness.stdin.write(bracketed('yaya'));
    await flush();
    await flush();

    expect(store.getSnapshot().approval).toBeDefined(); // still pending — the floor was untouched
    expect(answered).toBeUndefined(); // the awaiting dispatch never resolved
    expect(c.getSnapshot().input.text).not.toContain('yaya'); // and nothing leaked into the compose buffer
    harness.unmount();
  });
});
