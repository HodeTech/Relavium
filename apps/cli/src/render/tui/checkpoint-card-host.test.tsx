/**
 * The docked continue-checkpoint card, mounted for real in both hosts that draw it: the standalone chat (`ChatApp`) and the Home
 * (`RootApp`), over the same fake terminal the other cards' host tests use (ADR-0136 §4). It proves what the pure and store tests
 * cannot: the card is drawn where the approval card is with the conversation above it, `Ctrl+Y` counts only once the exact
 * frame has been flushed and has been on screen for the dwell, a typed letter answers nothing, the stop keys are answers and
 * never delayed, `Ctrl+C` also starts the interrupt window, and a terminal too small for the card draws the refusal instead.
 */
import { render } from 'ink';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OwnedTtyInput, OwnedTtyOutput } from '../../test-support.js';
import type { ClipboardWriter } from '../clipboard.js';
import type { SuspendPort } from '../suspend.js';
import { createChatStore } from './chat-store.js';
import { ChatApp } from './chat-ink.js';
import { RootApp } from './home-app.js';
import { createHomeController } from './home-controller.js';
import { FULLSCREEN_TRANSCRIPT_BOUND, INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import { APPROVAL_SETTLE_MS } from './tool-review-model.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

const CTRL_Y = '\x19';
const CTRL_N = '\x0e';
const CTRL_C = '\x03';
const INFO = { rounds: 32, interval: 32 };
/** A checkpoint is only ever asked inside a running turn, so these tests start one: that is what makes a stray abort visible. */
const TURN_ENDED = {
  type: 'session:turn_completed',
  sessionId: 's',
  sequenceNumber: 2,
  timestamp: '2026-11-19T00:00:01.000Z',
  stopReason: 'error',
  tokensUsed: { input: 0, output: 0 },
  error: { code: 'turn_limit', message: 'The turn stopped at a checkpoint.', retryable: false },
} as const;
const TURN_STARTED = {
  type: 'session:turn_started',
  sessionId: 's',
  sequenceNumber: 1,
  timestamp: '2026-11-19T00:00:00.000Z',
} as const;

function fixture(
  host: 'chat' | 'home',
  alternate: boolean,
  color: boolean,
  output = new OwnedTtyOutput(),
  ports: { suspendPort?: SuspendPort; reviewClipboard?: ClipboardWriter } = {},
) {
  const input = new OwnedTtyInput(),
    stderr = new OwnedTtyOutput();
  output.columns = 80;
  output.rows = 24;
  const store = createChatStore(
    color,
    undefined,
    alternate ? FULLSCREEN_TRANSCRIPT_BOUND : INLINE_TRANSCRIPT_BOUND,
  );
  const errors: unknown[] = [];
  const submitted: string[] = [];
  const aborts = { count: 0 };
  const session = {
    store,
    sessionId: 's',
    processLine: (line: string) => {
      submitted.push(line);
      return Promise.resolve();
    },
    shouldStop: () => false,
    stopReason: () => 'exit' as const,
    onAbort: () => {
      aborts.count += 1;
    },
    teardown: async () => {},
  };
  const controller = createHomeController({
    doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
    startChat: () => Promise.resolve(session),
    homeStore: {
      read: () => ({
        attention: { gates: [], failedRuns: [] },
        recentSessions: [],
        recentRuns: [],
        recentAgents: [],
        unreadableRunIds: [],
        isEmpty: true,
      }),
    },
    onExit: () => {},
    onError: (error) => errors.push(error),
  });
  const tree =
    host === 'chat'
      ? createElement(ChatApp, {
          store,
          onSubmit: (message: string) => {
            submitted.push(message);
            return Promise.resolve();
          },
          shouldStop: () => false,
          onExit: () => {},
          onError: (error) => errors.push(error),
          onModeChange: () => {},
          onAbort: () => {
            aborts.count += 1;
          },
          alternateScreen: alternate,
          ...ports,
        })
      : createElement(RootApp, {
          controller,
          nowMs: () => 0,
          color,
          getSize: () => ({ cols: output.columns, rows: output.rows }),
          subscribeResize: (callback) => {
            output.on('resize', callback);
            return () => {
              output.off('resize', callback);
            };
          },
          alternateScreen: alternate,
          ...ports,
        });
  const instance = render(tree, {
    stdin: input,
    stdout: output,
    stderr,
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
    alternateScreen: alternate,
  });
  cleanups.push(() => {
    store.sealToolPreviews();
    instance.unmount();
    input.destroy();
    output.destroy();
    stderr.destroy();
  });
  const ready = async () => {
    if (host === 'home') {
      controller.handleKey('h', {});
      controller.handleKey('', { return: true });
      await vi.waitFor(() => expect(controller.getSnapshot().mode).toBe('chat'));
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    submitted.length = 0; // the Home's first message (`h`) started the chat; only what comes after is under test
  };
  return {
    input,
    output,
    store,
    errors,
    submitted,
    aborts,
    ready,
    text: () => output.frames.join(''),
    /** The most recent complete frame (control sequences stripped) that contains `needle`. */
    lastFrameWith: (needle: string): string | undefined =>
      output.frames
        // eslint-disable-next-line no-control-regex -- stripping terminal control sequences from a captured frame
        .map((frame) => frame.replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, ''))
        .filter((frame) => frame.includes(needle))
        .at(-1),
    resize: (cols: number, rows: number) => {
      output.columns = cols;
      output.rows = rows;
      output.emit('resize');
    },
  };
}

describe.each(['chat', 'home'] as const)('the docked checkpoint card %s (ADR-0136 §4)', (host) => {
  // `Ctrl+Y` counts only after the exact frame was flushed AND stayed on screen for the dwell: wait just past it.
  const settle = (): Promise<void> =>
    new Promise<void>((resolve) => setTimeout(resolve, APPROVAL_SETTLE_MS + 120));
  const pause = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 40));

  it('is drawn where the approval card is, with the conversation above it, and says what it asks', async () => {
    const f = fixture(host, true, false);
    await f.ready();
    f.store.appendUser('EARLIER-CONVERSATION-LINE');
    const answer = f.store.requestCheckpoint(INFO);
    void answer.catch(() => undefined);
    await vi.waitFor(() => expect(f.text()).toContain('Checkpoint'));
    const frame = f.lastFrameWith('Continue for 32 more?') ?? '';
    expect(frame).toContain('EARLIER-CONVERSATION-LINE');
    expect(frame).toContain('This turn has used 32 tool rounds in');
    expect(frame).toContain('[Ctrl+Y] Continue   [Ctrl+N] Stop here');
    expect(frame).toContain('Esc or Ctrl+C stops the turn');
    expect(frame).not.toMatch(/Approval needed|Question from the agent/u);
    f.store.sealToolPreviews();
  });

  it('Ctrl+Y continues once the frame has settled, and answers the engine’s hook with "continue"', async () => {
    const f = fixture(host, true, false);
    await f.ready();
    const answer = f.store.requestCheckpoint(INFO);
    await vi.waitFor(() => expect(f.text()).toContain('Continue for 32 more?'));
    await settle();
    f.input.push(CTRL_Y);
    expect(await answer).toBe('continue');
    expect(f.store.getSnapshot().checkpoint).toBeUndefined();
    expect(f.errors).toEqual([]);
  });

  it('a Ctrl+Y typed ahead of the card, before its frame settled, spends nothing', async () => {
    const f = fixture(host, true, false);
    await f.ready();
    const answer = f.store.requestCheckpoint(INFO);
    let settled: unknown;
    void answer.then((value) => {
      settled = value;
    });
    await vi.waitFor(() => expect(f.text()).toContain('Continue for 32 more?'));
    f.input.push(CTRL_Y); // right away: inside the dwell
    await pause();
    expect(
      settled,
      'the key arrived before the card had been on screen long enough',
    ).toBeUndefined();
    expect(f.store.getSnapshot().checkpoint).toBeDefined();
    await settle();
    f.input.push(CTRL_Y);
    expect(await answer).toBe('continue');
  });

  it('typing a line answers nothing: letters, digits and Enter are consumed and the card stays', async () => {
    const f = fixture(host, true, false);
    await f.ready();
    const answer = f.store.requestCheckpoint(INFO);
    let settled: unknown;
    void answer.then((value) => {
      settled = value;
    });
    await vi.waitFor(() => expect(f.text()).toContain('Continue for 32 more?'));
    await settle();
    for (const key of ['y', 'n', 'c', 'a', '1', '2', 'continue please', '\r']) {
      f.input.push(key);
      await pause();
    }
    expect(settled).toBeUndefined();
    expect(f.store.getSnapshot().checkpoint).toBeDefined();
    expect(f.submitted, 'nothing typed at the card reaches the composer').toEqual([]);
    f.input.push(CTRL_N);
    expect(await answer).toBe('stop');
  });

  it('Ctrl+N stops at once, before the card could be acknowledged', async () => {
    const f = fixture(host, true, false);
    await f.ready();
    const answer = f.store.requestCheckpoint(INFO);
    await vi.waitFor(() => expect(f.text()).toContain('Checkpoint'));
    f.input.push(CTRL_N);
    expect(await answer).toBe('stop');
    expect(f.errors).toEqual([]);
  });

  it('Esc stops the turn as an answer, and arms nothing', async () => {
    const f = fixture(host, true, false);
    await f.ready();
    f.store.apply(TURN_STARTED);
    const answer = f.store.requestCheckpoint(INFO);
    await vi.waitFor(() => expect(f.text()).toContain('Checkpoint'));
    f.input.push('\u001b');
    expect(await answer).toBe('stop');
    expect(f.aborts.count, 'Esc answers; it does not abort').toBe(0);
    await pause();
    expect(f.text()).not.toContain('Press Ctrl+C again');
    f.input.push(CTRL_C); // a first press again
    await pause();
    expect(f.submitted, 'Esc armed nothing, so this Ctrl+C ended nothing').toEqual([]);
  });

  it('Ctrl+C stops the turn as an answer and starts the interrupt window; a second one inside it ends the session', async () => {
    const f = fixture(host, true, false);
    await f.ready();
    f.store.apply(TURN_STARTED);
    const answer = f.store.requestCheckpoint(INFO);
    await vi.waitFor(() => expect(f.text()).toContain('Checkpoint'));
    f.input.push(CTRL_C);
    expect(await answer, 'an answer, not an abort: the engine ends the turn itself').toBe('stop');
    expect(f.aborts.count, 'nothing was aborted: the answer is what ends the turn').toBe(0);
    // The engine ends the turn itself on a "stop" (turn_limit); the idle prompt then shows the armed hint.
    f.store.apply(TURN_ENDED);
    await vi.waitFor(() => expect(f.text()).toContain('Press Ctrl+C again'));
    expect(f.submitted).toEqual([]);
    f.input.push(CTRL_C);
    await vi.waitFor(() => expect(f.submitted).toContain('/cancel'));
  });

  it('draws the refusal on a terminal below 80×24, and Ctrl+Y does not continue there; Ctrl+N still stops', async () => {
    const f = fixture(host, true, false);
    await f.ready();
    f.resize(70, 20);
    const answer = f.store.requestCheckpoint(INFO);
    let settled: unknown;
    void answer.then((value) => {
      settled = value;
    });
    await vi.waitFor(() => expect(f.text()).toContain('terminal too small'));
    await settle();
    f.input.push(CTRL_Y);
    await pause();
    expect(settled).toBeUndefined();
    f.input.push(CTRL_N);
    expect(await answer).toBe('stop');
  });
});
