import type { SessionStreamHandleEvent, ToolApprovalRequest } from '@relavium/core';
import { cleanup, render as renderCapture } from 'ink-testing-library';
import { useStdout } from 'ink';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatApp } from './chat-ink.js';
import { createChatStore, type ChatStoreController } from './chat-store.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import { INTERRUPT_ARM_WINDOW_MS } from './interrupt-keymap.js';
import { settleFrames, waitFor } from './harness-util.js';

/**
 * The interrupt keymap on the standalone chat, driven through real stdin bytes (ADR-0115 §1–§2). The table itself is pinned in
 * `interrupt-keymap.test.ts`; what is pinned HERE is that the surface carries it out: which action a `Ctrl+C` takes in each
 * state, that a second one inside the window ends the session, that any other key disarms, and that an approval is rejected
 * BEFORE the abort is signalled.
 */

function WritableCapture(props: { readonly children: ReactElement }): ReactElement {
  const { stdout } = useStdout();
  Object.defineProperty(stdout, 'writable', { value: true });
  return props.children;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const CTRL_C = '\x03';
const LEFT_ARROW = '\x1b[D';
const ESC = '\x1b';
const HINT = 'Press Ctrl+C again to end the session';

const approvalReq: ToolApprovalRequest = {
  toolId: 'write_file',
  action: 'fs_write',
  preview: { path: 'notes.md' },
  unredactedPreview: { path: 'notes.md' },
};

const turnStarted: SessionStreamHandleEvent = {
  type: 'session:turn_started',
  sessionId: 'sess-1',
  sequenceNumber: 1,
  timestamp: '2026-11-19T00:00:00.000Z',
};

function mount(options: { readonly withAbort?: boolean } = {}): {
  readonly h: ReturnType<typeof renderCapture>;
  readonly store: ChatStoreController;
  readonly submitted: string[];
  readonly onAbort: ReturnType<typeof vi.fn>;
  readonly frame: () => string;
} {
  const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
  const submitted: string[] = [];
  const onAbort = vi.fn();
  const h = renderCapture(
    <WritableCapture>
      <ChatApp
        store={store}
        onSubmit={(message) => {
          submitted.push(message);
          return Promise.resolve();
        }}
        shouldStop={() => false}
        onExit={() => {}}
        onError={() => {}}
        onModeChange={() => {}}
        {...(options.withAbort === false ? {} : { onAbort })}
      />
    </WritableCapture>,
  );
  return { h, store, submitted, onAbort, frame: () => h.lastFrame() ?? '' };
}

const press = async (m: ReturnType<typeof mount>, bytes: string): Promise<void> => {
  m.h.stdin.write(bytes);
  await settleFrames();
};

describe('the first Ctrl+C at an idle prompt', () => {
  it('on an empty prompt arms and says so; a second Ctrl+C inside the window ends the session', async () => {
    const m = mount();
    await waitFor(() => m.frame().length > 0);
    await press(m, CTRL_C);
    await waitFor(() => m.frame().includes(HINT));
    expect(m.submitted, 'one press ends nothing').toEqual([]);
    await press(m, CTRL_C);
    await waitFor(() => m.submitted.includes('/cancel'));
    expect(m.submitted).toEqual(['/cancel']);
  });

  it('with a draft clears the draft and arms nothing: a stray press must not also arm an exit', async () => {
    const m = mount();
    await waitFor(() => m.frame().length > 0);
    await press(m, 'half a thought');
    await waitFor(() => m.frame().includes('half a thought'));
    await press(m, CTRL_C);
    await waitFor(() => !m.frame().includes('half a thought'));
    expect(m.frame()).not.toContain(HINT);
    expect(m.submitted).toEqual([]);
    // The next press is a first press again (empty prompt now): it arms; only the one after ends the session.
    await press(m, CTRL_C);
    await waitFor(() => m.frame().includes(HINT));
    expect(m.submitted).toEqual([]);
    await press(m, CTRL_C);
    await waitFor(() => m.submitted.includes('/cancel'));
  });

  it('is disarmed by any other key: Ctrl+C, a key, Ctrl+C are two first presses and end nothing', async () => {
    const m = mount();
    await waitFor(() => m.frame().length > 0);
    await press(m, CTRL_C);
    await waitFor(() => m.frame().includes(HINT));
    await press(m, LEFT_ARROW);
    await waitFor(() => !m.frame().includes(HINT));
    await press(m, CTRL_C);
    await waitFor(() => m.frame().includes(HINT)); // armed again, by a first press
    expect(m.submitted).toEqual([]);
  });

  it('is a first press again once the window has run out (the monotonic clock, not the hint timer, decides)', async () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const m = mount();
    await waitFor(() => m.frame().length > 0);
    await press(m, CTRL_C);
    await waitFor(() => m.frame().includes(HINT));
    now += INTERRUPT_ARM_WINDOW_MS + 1;
    await press(m, CTRL_C);
    expect(m.submitted, 'a Ctrl+C long after the first starts over').toEqual([]);
    now += INTERRUPT_ARM_WINDOW_MS; // exactly the end of the window still counts
    await press(m, CTRL_C);
    await waitFor(() => m.submitted.includes('/cancel'));
  });
});

describe('Ctrl+C while a turn runs', () => {
  it('interrupts the turn the way Esc does and keeps the session; a second press ends it', async () => {
    const m = mount();
    await waitFor(() => m.frame().length > 0);
    m.store.apply(turnStarted);
    await press(m, CTRL_C);
    expect(m.onAbort, 'the first press is the abort Esc performs').toHaveBeenCalledTimes(1);
    expect(m.submitted, 'and it does not end the session').toEqual([]);
    await press(m, CTRL_C);
    await waitFor(() => m.submitted.includes('/cancel'));
  });

  it('Esc is the same abort and never arms: a Ctrl+C right after it is a first press', async () => {
    const m = mount();
    await waitFor(() => m.frame().length > 0);
    m.store.apply(turnStarted);
    m.h.stdin.write(ESC); // a lone ESC is held back a moment while the input layer rules out an escape sequence
    await vi.waitFor(() => expect(m.onAbort).toHaveBeenCalledTimes(1));
    await press(m, CTRL_C);
    expect(m.onAbort).toHaveBeenCalledTimes(2);
    expect(m.submitted, 'Esc armed nothing, so this Ctrl+C ended nothing').toEqual([]);
  });
});

describe('Ctrl+C at an approval card rejects first (ADR-0115 §2)', () => {
  it('settles the call as a user rejection, then aborts, then arms; the second press ends the session', async () => {
    const m = mount();
    await waitFor(() => m.frame().length > 0);
    m.store.apply(turnStarted);
    // The order is the point: when the abort is signalled the call must already be settled. Read the store at that instant.
    let approvalWhenAborted: unknown = 'abort not signalled';
    m.onAbort.mockImplementation(() => {
      approvalWhenAborted = m.store.getSnapshot().approval;
    });
    const pending = m.store.requestApproval(approvalReq, false);
    await waitFor(() => m.store.getSnapshot().approval !== undefined);
    await press(m, CTRL_C);
    await expect(pending).resolves.toEqual({ outcome: 'reject' });
    expect(m.onAbort).toHaveBeenCalledTimes(1);
    expect(
      approvalWhenAborted,
      'the call was already settled (as a rejection) when the abort was signalled',
    ).toBeUndefined();
    expect(m.submitted).toEqual([]);
    await press(m, CTRL_C);
    await waitFor(() => m.submitted.includes('/cancel'));
  });

  it('with no onAbort wired the card is still rejected: the stop key is never dead at a decision', async () => {
    const m = mount({ withAbort: false });
    await waitFor(() => m.frame().length > 0);
    m.store.apply(turnStarted);
    const pending = m.store.requestApproval(approvalReq, false);
    await waitFor(() => m.store.getSnapshot().approval !== undefined);
    await press(m, CTRL_C);
    await expect(pending).resolves.toEqual({ outcome: 'reject' });
  });
});
