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
import type { SuspendPort } from '../suspend.js';
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
  // A choosing key counts only after the question has been on screen QUESTION_SETTLE_MS (250 ms); settle just past it.
  const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 320));

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
    expect(frame).toContain('> 1 ( ) alpha.ts');
    expect(frame).toContain('2 ( ) beta.ts');
    expect(frame).toContain('\u270e Type your own answer');
    expect(frame).toContain('The first file'); // the highlighted option's description
    expect(frame).toContain('Esc / [Ctrl+C] stops the turn');
    expect(frame).not.toMatch(/Approval needed|\[y\]|\[a\]|\[n\]/u);
    f.input.push('2');
    expect(await answer).toEqual({ kind: 'answered', answers: [{ selected: ['beta.ts'] }] });
    expect(f.store.getSnapshot().question).toBeUndefined();
    expect(f.errors).toEqual([]);
  });

  // ADR-0132 §6: in a mode where the agent may act on the next call without asking, an answer is guidance, not a veto, and the
  // card says so. The wording is wired from the live mode in the view, so only a mounted host can see it go missing.
  it.each([
    ['ask', false],
    ['plan', false],
    ['accept-edits', true],
    ['auto', true],
  ] as const)('shows the "guidance, not a veto" note in %s mode: %s', async (mode, shown) => {
    const f = fixture(host, true, false);
    await f.ready();
    f.store.setMode(mode);
    const answer = f.store.requestQuestion(QUESTION);
    await vi.waitFor(() => expect(f.text()).toContain('Question from the agent'));
    await settle();
    const frame = f.lastFrameWith('Question from the agent') ?? '';
    if (shown) expect(frame).toContain('an answer is guidance, not a veto');
    else expect(frame).not.toContain('guidance, not a veto');
    f.input.push('1');
    await answer;
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
    await settle();
    // Drawn once — in the card's field. Had the paste ALSO reached the composer (this fixture's store is idle, so the composer
    // is open), the words would appear a second time on the prompt line.
    const withPaste = f.lastFrameWith('my own words') ?? '';
    expect(withPaste.match(/my own words/gu)).toHaveLength(1);
    f.input.push('\r');
    expect(await answer).toEqual({
      kind: 'answered',
      answers: [{ selected: [], other: 'my own words' }],
    });
    expect(f.errors).toEqual([]);
  });

  it('Esc in the own-answer field closes the field and leaves the question open; the typed text is not kept (ADR-0115 §3)', async () => {
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
    f.input.push('half a thought');
    await vi.waitFor(() =>
      expect(f.store.getSnapshot().question?.field?.text).toBe('half a thought'),
    );
    await vi.waitFor(() => expect(f.text()).toContain('[Ctrl+C] stops the turn · Esc close'));
    const mark = f.output.frames.length; // only frames drawn AFTER the Esc count for the legend that follows
    f.input.push('\u001b'); // Esc: one level back, not out
    await vi.waitFor(() => expect(f.store.getSnapshot().question?.field).toBeUndefined());
    expect(f.store.getSnapshot().question, 'the call is still pending').toBeDefined();
    expect(f.store.getSnapshot().question?.entries[0]?.draft).toBeUndefined();
    await vi.waitFor(() =>
      expect(
        f.output.frames
          .slice(mark)
          // eslint-disable-next-line no-control-regex -- stripping terminal control sequences from a captured frame
          .map((frame) => frame.replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, ''))
          .join(''),
      ).toContain('Esc / [Ctrl+C] stops the turn'),
    );
    f.input.push('1'); // and the card still answers
    expect(await answer).toEqual({ kind: 'answered', answers: [{ selected: ['alpha.ts'] }] });
    expect(f.errors).toEqual([]);
  });

  it('draws the refusal on a terminal below 80×24, and no key chooses there', async () => {
    const f = fixture(host, true, false);
    f.resize(60, 20);
    await f.ready();
    const answer = f.store.requestQuestion(QUESTION);
    await vi.waitFor(() => expect(f.text()).toContain('Terminal too small'));
    expect(f.lastFrameWith('Terminal too small') ?? '').toMatch(/Esc \/\s+\[Ctrl\+C\]/u);
    f.input.push('1');
    f.input.push('s');
    await settle();
    expect(f.store.getSnapshot().question).toBeDefined(); // the card was never acknowledged, so nothing chose
    f.store.sealToolPreviews();
    await expect(answer).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe.each(['chat', 'home'] as const)(
  'the question card in the INLINE renderer, %s (ADR-0132)',
  (host) => {
    const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 320));

    it('is drawn and answers without the alternate screen', async () => {
      const f = fixture(host, false, false);
      await f.ready();
      const answer = f.store.requestQuestion(QUESTION);
      await vi.waitFor(() => expect(f.text()).toContain('Question from the agent'));
      await settle();
      f.input.push('1');
      expect(await answer).toEqual({ kind: 'answered', answers: [{ selected: ['alpha.ts'] }] });
      expect(f.errors).toEqual([]);
    });

    it('a card too tall for the terminal recovers when the terminal is enlarged — it is not a dead end', async () => {
      const f = fixture(host, false, false);
      await f.ready();
      // A long agentic turn: many live tool rows push the docked card below the bottom edge of an 80×24 inline frame.
      for (let n = 0; n < 16; n += 1)
        f.store.applyToolLiveEvent({
          phase: 'started',
          callId: `c${String(n)}`,
          toolId: 'read_file',
        });
      const answer = f.store.requestQuestion(QUESTION);
      await vi.waitFor(() =>
        expect(
          f.text().includes('Question unavailable') || f.text().includes('Question from the agent'),
        ).toBe(true),
      );
      await settle();
      f.resize(100, 70); // enlarge
      await settle();
      await vi.waitFor(() => expect(f.text()).toContain('Question from the agent'));
      await settle();
      f.input.push('2');
      expect(await answer).toEqual({ kind: 'answered', answers: [{ selected: ['beta.ts'] }] });
    });
  },
);

describe.each(['chat', 'home'] as const)(
  'several questions in one call, %s (ADR-0132 §3)',
  (host) => {
    const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 320));
    const THREE: AskUserRequest = {
      questions: ['One', 'Two', 'Three'].map((header) => ({
        header,
        question: `${header}?`,
        multiSelect: false,
        options: [
          { label: `${header}-a`, description: 'first' },
          { label: `${header}-b`, description: 'second' },
        ],
      })),
    };

    it('a burst of Enter keys answers only the question the person has had time to see', async () => {
      const f = fixture(host, true, false);
      await f.ready();
      const answer = f.store.requestQuestion(THREE);
      await vi.waitFor(() => expect(f.text()).toContain('One  [o] o o · Review'));
      await settle();
      // A held Enter repeats every few tens of milliseconds: only the first lands on a settled frame. (Keys pushed in the SAME
      // tick reach the card as one chunk, which it ignores whole, so they are spaced the way key repeat spaces them.)
      for (let n = 0; n < 3; n += 1) {
        f.input.push('\r');
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
      }
      await vi.waitFor(() => expect(f.store.getSnapshot().question?.index).toBe(1));
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(f.store.getSnapshot().question?.index).toBe(1); // not 2, and not submitted
      f.store.sealToolPreviews();
      await expect(answer).rejects.toMatchObject({ name: 'AbortError' });
    });
  },
);

describe.each(['chat', 'home'] as const)(
  'the question card, driven the way a person drives it, %s (ADR-0132 §3)',
  (host) => {
    const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 320));
    const THREE: AskUserRequest = {
      questions: [
        {
          header: 'Pick',
          question: 'Which file?',
          multiSelect: false,
          options: [
            { label: 'alpha.ts', description: 'The first file' },
            { label: 'beta.ts', description: 'The second file' },
          ],
        },
        {
          header: 'Also',
          question: 'Which more?',
          multiSelect: true,
          options: [
            { label: 'one', description: 'Number one' },
            { label: 'two', description: 'Number two' },
          ],
        },
        {
          header: 'Last',
          question: 'And finally?',
          multiSelect: false,
          options: [
            { label: 'yes', description: 'Yes' },
            { label: 'no', description: 'No' },
          ],
        },
      ],
    };
    const CTRL_S = String.fromCharCode(19);
    const RIGHT = String.fromCharCode(27) + '[C';
    const LEFT = String.fromCharCode(27) + '[D';
    const DOWN = String.fromCharCode(27) + '[B';

    /** Type one key and let the frame and the settle window pass, as a person pausing between keys does. */
    const tap = async (
      f: { input: { push: (text: string) => void } },
      key: string,
    ): Promise<void> => {
      f.input.push(key);
      await settle();
    };

    it('Ctrl+S skips the whole call — and a typed `s` is just a letter', async () => {
      const f = fixture(host, true, false);
      await f.ready();
      const answer = f.store.requestQuestion(QUESTION);
      await vi.waitFor(() => expect(f.text()).toContain('Question from the agent'));
      await settle();
      f.input.push('s'); // starts the own-answer field; it must NOT skip
      await vi.waitFor(() => expect(f.store.getSnapshot().question?.field?.text).toBe('s'));
      expect(f.store.getSnapshot().question).toBeDefined();
      f.input.push(CTRL_S);
      expect(await answer).toEqual({ kind: 'skipped' });
      expect(f.errors).toEqual([]);
    });

    it('browses the questions with the arrow keys, shows the Review tab, and sends only from it', async () => {
      const f = fixture(host, true, false);
      await f.ready();
      const answer = f.store.requestQuestion(THREE);
      await vi.waitFor(() => expect(f.text()).toContain('Pick  [o] o o · Review'));
      await settle();
      await tap(f, RIGHT); // look at question 2 without answering question 1
      await vi.waitFor(() =>
        expect(f.lastFrameWith('Which more?') ?? '').toContain('Also  o [o] o · Review'),
      );
      await tap(f, RIGHT);
      await tap(f, RIGHT); // the Review tab
      await vi.waitFor(() =>
        expect(f.lastFrameWith('Review your answers') ?? '').toContain(
          'o 1 Pick → not answered yet',
        ),
      );
      await tap(f, '\r'); // Enter with holes: goes to the first unanswered question, with a note
      await vi.waitFor(() =>
        expect(f.lastFrameWith('Question 1 is not answered yet.') ?? '').toContain('Pick  [o]'),
      );
      await tap(f, '2'); // beta.ts → question 2
      await tap(f, '1'); // multi-select: tick "one" …
      await tap(f, '\r'); // … and confirm → question 3
      await tap(f, '1'); // yes → the Review tab, which does NOT send
      expect(f.store.getSnapshot().question?.index).toBe(3);
      await vi.waitFor(() =>
        expect(f.lastFrameWith('Review your answers') ?? '').toContain('+ 2 Also → one'),
      );
      f.input.push('\r');
      expect(await answer).toEqual({
        kind: 'answered',
        answers: [{ selected: ['beta.ts'] }, { selected: ['one'] }, { selected: ['yes'] }],
      });
      expect(f.errors).toEqual([]);
    });

    it('multi-select with options AND own text: Enter saves the text and stays, the next Enter confirms', async () => {
      const f = fixture(host, true, false);
      await f.ready();
      const answer = f.store.requestQuestion({ questions: [THREE.questions[1]!] });
      await vi.waitFor(() => expect(f.text()).toContain('Which more?'));
      await settle();
      await tap(f, '2'); // tick "two"
      await tap(f, DOWN);
      await tap(f, DOWN);
      f.input.push('n'); // just start typing on the own-answer row
      await vi.waitFor(() => expect(f.store.getSnapshot().question?.field?.text).toBe('n'));
      f.input.push('ote');
      await vi.waitFor(() => expect(f.store.getSnapshot().question?.field?.text).toBe('note'));
      await settle();
      f.input.push('\r'); // SAVES the text — the question is still open
      await vi.waitFor(() => expect(f.store.getSnapshot().question?.field).toBeUndefined());
      expect(f.store.getSnapshot().question).toBeDefined();
      await vi.waitFor(() => expect(f.lastFrameWith('Saved.') ?? '').toContain('[x] ✎ note'));
      await settle();
      f.input.push('\r'); // the second Enter confirms the question
      expect(await answer).toEqual({
        kind: 'answered',
        answers: [{ selected: ['two'], other: 'note' }],
      });
    });

    it('← goes back to a question and the answer given there is still shown', async () => {
      const f = fixture(host, true, false);
      await f.ready();
      const answer = f.store.requestQuestion(THREE);
      await vi.waitFor(() => expect(f.text()).toContain('Pick  [o]'));
      await settle();
      await tap(f, '1'); // alpha.ts → question 2
      await tap(f, LEFT);
      await vi.waitFor(() =>
        expect(f.lastFrameWith('Which file?') ?? '').toContain('(*) alpha.ts'),
      );
      f.store.sealToolPreviews();
      await expect(answer).rejects.toMatchObject({ name: 'AbortError' });
    });
  },
);
