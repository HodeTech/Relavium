/**
 * The docked `ask_user` card, mounted for real in both hosts that draw it — the standalone chat (`ChatApp`) and the Home
 * (`RootApp`) — over the same fake terminal the approval card's host tests use (ADR-0132). It proves what the pure tests cannot:
 * the card is drawn where the approval card is with the conversation above it, a key chooses only once the frame has been
 * flushed to the terminal, a paste reaches the own-answer field and not the composer, and a too-small terminal draws the
 * refusal instead of a card nobody can read.
 */
import { render } from 'ink';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AskUserRequest } from '@relavium/core';
import { OwnedTtyInput, OwnedTtyOutput } from '../../test-support.js';
import type { ClipboardWriter } from '../clipboard.js';
import { createSuspendPort, type SuspendPort } from '../suspend.js';
import { createChatStore } from './chat-store.js';
import { ChatApp } from './chat-ink.js';
import { RootApp } from './home-app.js';
import { createHomeController } from './home-controller.js';
import { FULLSCREEN_TRANSCRIPT_BOUND, INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import { bracketed } from './harness-util.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

const QUESTION: AskUserRequest = {
  questions: [
    {
      header: 'Pick',
      question: 'Which file should I change?',
      multiSelect: false,
      options: [
        { label: 'alpha.ts', description: 'The first file' },
        { label: 'beta.ts', description: 'The second file' },
      ],
    },
  ],
};

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
  const session = {
    store,
    sessionId: 's',
    processLine: async () => {},
    shouldStop: () => false,
    stopReason: () => 'exit' as const,
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
          onSubmit: async () => {},
          shouldStop: () => false,
          onExit: () => {},
          onError: (error) => errors.push(error),
          onModeChange: () => {},
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
  };
  return {
    input,
    output,
    store,
    errors,
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

describe.each(['chat', 'home'] as const)('the docked question card %s (ADR-0132)', (host) => {
  const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 60));

  it('is drawn where the approval card is, with the conversation still on screen above it, and says it is not an approval', async () => {
    const f = fixture(host, true, false);
    await f.ready();
    f.store.appendUser('EARLIER-CONVERSATION-LINE');
    const answer = f.store.requestQuestion(QUESTION);
    await vi.waitFor(() => expect(f.text()).toContain('Question from the agent'));
    await settle();
    const frame = f.lastFrameWith('Question from the agent') ?? '';
    expect(frame).toContain('EARLIER-CONVERSATION-LINE');
    expect(frame).toContain('not an approval');
    expect(frame).toContain('Which file should I change?');
    expect(frame).toContain('\u203a 1 ( ) alpha.ts');
    expect(frame).toContain('2 ( ) beta.ts');
    expect(frame).toContain('\u270e Type your own answer');
    expect(frame).toContain('The first file'); // the highlighted option's description
    expect(frame).toContain('Esc or Ctrl-C stops the turn');
    expect(frame).not.toMatch(/Approval needed|\[y\]|\[a\]|\[n\]/u);
    f.input.push('2');
    expect(await answer).toEqual({ kind: 'answered', answers: [{ selected: ['beta.ts'] }] });
    expect(f.store.getSnapshot().question).toBeUndefined();
    expect(f.errors).toEqual([]);
  });

  it('records the answer in the transcript and removes the card', async () => {
    const f = fixture(host, true, false);
    await f.ready();
    const answer = f.store.requestQuestion(QUESTION);
    await vi.waitFor(() => expect(f.text()).toContain('Question from the agent'));
    await settle();
    f.input.push('1');
    await answer;
    await vi.waitFor(() => expect(f.text()).toContain('Asked: Pick'));
    expect(f.lastFrameWith('Asked: Pick') ?? '').toContain('alpha.ts');
  });

  it('sends a bracketed paste to the own-answer field — never to the composer — once the card is open on it', async () => {
    const f = fixture(host, true, false);
    await f.ready();
    const answer = f.store.requestQuestion(QUESTION);
    await vi.waitFor(() => expect(f.text()).toContain('Question from the agent'));
    await settle();
    f.input.push('\u001b[B'); // down
    f.input.push('\u001b[B'); // down: the own-answer row
    await settle();
    f.input.push('\r'); // open the field
    await vi.waitFor(() => expect(f.store.getSnapshot().question?.field).toBeDefined());
    f.input.push(bracketed('my own words'));
    await vi.waitFor(() =>
      expect(f.store.getSnapshot().question?.field?.text).toBe('my own words'),
    );
    f.input.push('\r');
    expect(await answer).toEqual({
      kind: 'answered',
      answers: [{ selected: [], other: 'my own words' }],
    });
    expect(f.errors).toEqual([]);
  });

  it('draws the refusal on a terminal below 80×24, and no key chooses there', async () => {
    const f = fixture(host, true, false);
    f.resize(60, 20);
    await f.ready();
    const answer = f.store.requestQuestion(QUESTION);
    await vi.waitFor(() => expect(f.text()).toContain('Terminal too small'));
    expect(f.lastFrameWith('Terminal too small') ?? '').toMatch(/Esc or Ctrl-C/u);
    f.input.push('1');
    f.input.push('s');
    await settle();
    expect(f.store.getSnapshot().question).toBeDefined(); // the card was never acknowledged, so nothing chose
    f.store.sealToolPreviews();
    await expect(answer).rejects.toMatchObject({ name: 'AbortError' });
  });
});
