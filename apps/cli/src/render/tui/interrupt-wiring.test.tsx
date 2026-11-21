import type { SessionStreamHandleEvent, ToolApprovalRequest } from '@relavium/core';
import { cleanup, render as renderCapture } from 'ink-testing-library';
import { useStdout } from 'ink';
import type { ComponentProps, ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatApp } from './chat-ink.js';
import { createChatStore, type ChatStoreController } from './chat-store.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import { INTERRUPT_ARM_WINDOW_MS } from './interrupt-keymap.js';
import { bracketed, settleFrames } from './harness-util.js';

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

/**
 * Poll until `predicate` holds and FAIL if it never does. (`harness-util`'s `waitFor` returns silently on a timeout, so a bare `await
 * waitFor(...)` asserts nothing: every positive wait in this file goes through this instead.) The default budget covers the 2 s
 * arming window of the real hint timer.
 */
const until = (predicate: () => boolean, timeout = 3000): Promise<void> =>
  vi.waitFor(
    () => {
      if (!predicate()) throw new Error('the condition did not become true');
    },
    { timeout, interval: 15 },
  );

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

function mount(
  options: {
    readonly withAbort?: boolean;
    readonly runShellCommand?: ComponentProps<typeof ChatApp>['runShellCommand'];
    readonly mentionReader?: ComponentProps<typeof ChatApp>['mentionReader'];
    readonly onActivated?: ComponentProps<typeof ChatApp>['onActivated'];
  } = {},
): {
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
        {...(options.runShellCommand === undefined
          ? {}
          : { runShellCommand: options.runShellCommand })}
        {...(options.mentionReader === undefined ? {} : { mentionReader: options.mentionReader })}
        {...(options.onActivated === undefined ? {} : { onActivated: options.onActivated })}
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
    await until(() => m.frame().length > 0);
    await press(m, CTRL_C);
    await until(() => m.frame().includes(HINT));
    expect(m.submitted, 'one press ends nothing').toEqual([]);
    await press(m, CTRL_C);
    await until(() => m.submitted.includes('/cancel'));
    expect(m.submitted).toEqual(['/cancel']);
  });

  it('with a draft clears the draft and arms nothing: a stray press must not also arm an exit', async () => {
    const m = mount();
    await until(() => m.frame().length > 0);
    await press(m, 'half a thought');
    await until(() => m.frame().includes('half a thought'));
    await press(m, CTRL_C);
    await until(() => !m.frame().includes('half a thought'));
    expect(m.frame()).not.toContain(HINT);
    expect(m.submitted).toEqual([]);
    // The next press is a first press again (empty prompt now): it arms; only the one after ends the session.
    await press(m, CTRL_C);
    await until(() => m.frame().includes(HINT));
    expect(m.submitted).toEqual([]);
    await press(m, CTRL_C);
    await until(() => m.submitted.includes('/cancel'));
  });

  it('is disarmed by any other key: Ctrl+C, a key, Ctrl+C are two first presses and end nothing', async () => {
    const m = mount();
    await until(() => m.frame().length > 0);
    await press(m, CTRL_C);
    await until(() => m.frame().includes(HINT));
    await press(m, LEFT_ARROW);
    await until(() => !m.frame().includes(HINT));
    await press(m, CTRL_C);
    await until(() => m.frame().includes(HINT)); // armed again, by a first press
    expect(m.submitted).toEqual([]);
  });

  it('is a first press again once the window has run out (the monotonic clock, not the hint timer, decides)', async () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const m = mount();
    await until(() => m.frame().length > 0);
    await press(m, CTRL_C);
    await until(() => m.frame().includes(HINT));
    now += INTERRUPT_ARM_WINDOW_MS + 1;
    await press(m, CTRL_C);
    expect(m.submitted, 'a Ctrl+C long after the first starts over').toEqual([]);
    now += INTERRUPT_ARM_WINDOW_MS; // exactly the end of the window still counts
    await press(m, CTRL_C);
    await until(() => m.submitted.includes('/cancel'));
  });
});

describe('Ctrl+C while a turn runs', () => {
  it('interrupts the turn the way Esc does and keeps the session; a second press ends it', async () => {
    const m = mount();
    await until(() => m.frame().length > 0);
    m.store.apply(turnStarted);
    await press(m, CTRL_C);
    expect(m.onAbort, 'the first press is the abort Esc performs').toHaveBeenCalledTimes(1);
    expect(m.submitted, 'and it does not end the session').toEqual([]);
    await press(m, CTRL_C);
    await until(() => m.submitted.includes('/cancel'));
  });

  it('a running turn acknowledges the first Ctrl+C on screen, so a turn that is slow to stop is not silent; Esc says nothing of the kind', async () => {
    const m = mount();
    await until(() => m.frame().length > 0);
    m.store.apply(turnStarted);
    await press(m, CTRL_C);
    await until(() => m.frame().includes('Interrupting · press Ctrl+C again to end the session'));
    expect(m.onAbort).toHaveBeenCalledTimes(1);
    const calm = mount();
    await until(() => calm.frame().length > 0);
    calm.store.apply(turnStarted);
    calm.h.stdin.write(ESC);
    await vi.waitFor(() => expect(calm.onAbort).toHaveBeenCalledTimes(1));
    expect(calm.frame()).not.toContain('Interrupting');
  });

  it('Esc is the same abort and never arms: a Ctrl+C right after it is a first press', async () => {
    const m = mount();
    await until(() => m.frame().length > 0);
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
    await until(() => m.frame().length > 0);
    m.store.apply(turnStarted);
    // The order is the point: when the abort is signalled the call must already be settled. Read the store at that instant.
    let approvalWhenAborted: unknown = 'abort not signalled';
    m.onAbort.mockImplementation(() => {
      approvalWhenAborted = m.store.getSnapshot().approval;
    });
    const pending = m.store.requestApproval(approvalReq, false);
    await until(() => m.store.getSnapshot().approval !== undefined);
    await press(m, CTRL_C);
    await expect(pending).resolves.toEqual({ outcome: 'reject' });
    expect(m.onAbort).toHaveBeenCalledTimes(1);
    expect(
      approvalWhenAborted,
      'the call was already settled (as a rejection) when the abort was signalled',
    ).toBeUndefined();
    expect(m.submitted).toEqual([]);
    await press(m, CTRL_C);
    await until(() => m.submitted.includes('/cancel'));
  });

  it('with no onAbort wired the card is still rejected: the stop key is never dead at a decision', async () => {
    const m = mount({ withAbort: false });
    await until(() => m.frame().length > 0);
    m.store.apply(turnStarted);
    const pending = m.store.requestApproval(approvalReq, false);
    await until(() => m.store.getSnapshot().approval !== undefined);
    await press(m, CTRL_C);
    await expect(pending).resolves.toEqual({ outcome: 'reject' });
  });
});

describe('the rows of the keymap the table drives through the standalone chat (ADR-0115 §1)', () => {
  it('a `!` command running is interrupted by the first Ctrl+C, the way Esc does; the second ends the session', async () => {
    const m = mount({
      runShellCommand: () => new Promise(() => undefined) as never, // a command that never finishes
    });
    await until(() => m.frame().length > 0);
    await press(m, '!sleep 1000');
    await press(m, '\r');
    await settleFrames();
    await press(m, CTRL_C);
    expect(m.onAbort, 'interrupts the command instead of clearing or arming').toHaveBeenCalledTimes(
      1,
    );
    expect(m.submitted).toEqual([]);
    await press(m, CTRL_C);
    await until(() => m.submitted.includes('/cancel'));
  });

  it('every overlay closes on Ctrl+C and arms nothing: the palette, the reverse search and the `@` mention', async () => {
    const m = mount({
      mentionReader: {
        list: () => Promise.resolve([{ name: 'app.ts', type: 'file' as const, path: 'app.ts' }]),
        read: () => Promise.resolve({ content: 'x', sizeBytes: 1 }),
      },
    });
    await until(() => m.frame().length > 0);
    await press(m, '/'); // the palette opens on a literal `/` at an empty prompt
    await until(() => m.frame().includes('/export')); // the palette lists the commands
    await press(m, CTRL_C);
    await until(() => !m.frame().includes('/export'));
    expect(m.frame()).not.toContain(HINT);
    await press(m, '\x12'); // Ctrl+R: the reverse search
    await press(m, CTRL_C);
    expect(m.frame()).not.toContain(HINT);
    await press(m, '@');
    await press(m, CTRL_C);
    expect(m.frame()).not.toContain(HINT);
    expect(m.submitted).toEqual([]);
    // Nothing was armed by any of those. Closing the mention gave back the `@` it had held, so the next press clears that draft
    // (and arms nothing), and only the one after it, at an empty prompt, arms.
    await press(m, CTRL_C);
    expect(m.frame()).not.toContain(HINT);
    await press(m, CTRL_C);
    await until(() => m.frame().includes(HINT));
    expect(m.submitted).toEqual([]);
  });

  it('before the chat has activated, Ctrl+C ends the session at once, and a held key sends /cancel only once', async () => {
    const m = mount({ onActivated: () => new Promise<void>(() => undefined) }); // never activates
    await until(() => m.frame().length > 0);
    await press(m, CTRL_C);
    await until(() => m.submitted.includes('/cancel'));
    await press(m, CTRL_C);
    await press(m, CTRL_C);
    expect(m.submitted, 'the latch: one /cancel however many presses').toEqual(['/cancel']);
  });

  it('a second pair of Ctrl+C after the session has been ended sends no second /cancel', async () => {
    const m = mount();
    await until(() => m.frame().length > 0);
    await press(m, CTRL_C);
    await press(m, CTRL_C);
    await until(() => m.submitted.includes('/cancel'));
    await press(m, CTRL_C);
    await press(m, CTRL_C);
    expect(m.submitted).toEqual(['/cancel']);
  });

  it('a paste is a key too: it ends the armed state, and the next Ctrl+C clears the pasted draft instead of ending the session', async () => {
    const m = mount();
    await until(() => m.frame().length > 0);
    await press(m, CTRL_C);
    await until(() => m.frame().includes(HINT));
    m.h.stdin.write(bracketed('a pasted block'));
    await until(() => m.frame().includes('a pasted block'));
    expect(m.frame()).not.toContain(HINT);
    await press(m, CTRL_C);
    await until(() => !m.frame().includes('a pasted block'));
    expect(m.submitted).toEqual([]);
  });

  it('a key a card swallows ends the armed state: Ctrl+C, a key at a card, Ctrl+C are not a double press', async () => {
    const m = mount();
    await until(() => m.frame().length > 0);
    await press(m, CTRL_C);
    await until(() => m.frame().includes(HINT));
    m.store.apply(turnStarted);
    void m.store.requestApproval(approvalReq, false).catch(() => undefined);
    await until(() => m.store.getSnapshot().approval !== undefined);
    await press(m, 'x'); // the card takes it: typing at a card
    m.store.sealToolPreviews();
    expect(m.submitted).toEqual([]);
    // The window is gone: the next Ctrl+C is a first press and must not end the session.
    m.store.apply({
      ...turnStarted,
      type: 'session:turn_completed',
      sequenceNumber: 2,
      stopReason: 'stop',
      tokensUsed: { input: 0, output: 0 },
    } as never);
    await press(m, CTRL_C);
    expect(m.submitted).toEqual([]);
  });

  it('the hint comes down by itself when the window runs out', async () => {
    const m = mount();
    await until(() => m.frame().length > 0);
    await press(m, CTRL_C);
    await until(() => m.frame().includes(HINT));
    await until(() => !m.frame().includes(HINT), INTERRUPT_ARM_WINDOW_MS + 1500); // the real hint timer takes it down
    expect(m.frame()).not.toContain(HINT);
  }, 15_000); // a real two-second timer: the default 5 s budget would turn a loaded machine into a failure
});
