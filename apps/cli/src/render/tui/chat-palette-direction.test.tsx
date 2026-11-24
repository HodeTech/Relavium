import { cleanup, render as renderCapture } from 'ink-testing-library';
import { useStdout } from 'ink';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { REPL_COMMANDS } from '../../commands/repl-commands.js';
import { ChatApp } from './chat-ink.js';
import { createChatStore } from './chat-store.js';
import { bracketed, settleFrames, waitFor } from './harness-util.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

/**
 * The `/` palette of a stand-alone chat as the person uses it ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md)
 * §7, MVP-11 Step 2.2): the list opens ABOVE the prompt and its first row is the one beside it, so it is drawn bottom-up and the arrow keys
 * follow the screen (↑ is the next entry); `/` then `Enter` runs the first row (`/models`, which changes nothing), never `/exit`; and `/exit`,
 * the last row, runs only on an explicit selection. Through the mounted `ChatApp`, so the keys are real bytes and the lines are the frame.
 */
afterEach(cleanup);

function WritableCapture(props: { readonly children: ReactElement }): ReactElement {
  const { stdout } = useStdout();
  Object.defineProperty(stdout, 'writable', { value: true });
  return props.children;
}

const UP = '\x1b[A';
const DOWN = '\x1b[B';
const ESC = String.fromCharCode(0x1b);
const plain = (text: string): string => text.replace(new RegExp(`${ESC}\\[\\d+m`, 'gu'), '');

function mountChat() {
  const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
  const submitted: string[] = [];
  const onExit = vi.fn();
  const h = renderCapture(
    <WritableCapture>
      <ChatApp
        store={store}
        onSubmit={(message) => {
          submitted.push(message);
          return Promise.resolve();
        }}
        shouldStop={() => false}
        onExit={onExit}
        onError={() => {}}
        onModeChange={() => {}}
      />
    </WritableCapture>,
  );
  const frame = (): string[] => plain(h.lastFrame() ?? '').split('\n');
  /** The highlighted entry's slash word, or `undefined`. */
  const highlighted = (): string | undefined =>
    frame()
      .map((line) => /^› \/([a-z]+)(?: |$)/u.exec(line)?.[1])
      .find((name) => name !== undefined);
  return { h, store, submitted, onExit, frame, highlighted };
}

describe('the chat’s palette opens above the prompt, and its first row is the one beside it', () => {
  it('draws the legend at the top and the entries bottom-up: /models beside the query line, /exit at the top', async () => {
    const { h, frame, highlighted } = mountChat();
    await waitFor(() => (h.lastFrame() ?? '').length > 0);
    h.stdin.write('/');
    await waitFor(() => (h.lastFrame() ?? '').includes('Enter run'));
    await settleFrames();
    const rows = frame();
    const at = (word: string): number =>
      rows.findIndex((line) => new RegExp(`^[› ] /${word}( |$)`, 'u').test(line));
    expect(rows.some((line) => line === '↑/↓ select · Enter run · Esc cancel')).toBe(true);
    expect(
      rows.indexOf('↑/↓ select · Enter run · Esc cancel'),
      'the legend is above the list',
    ).toBeLessThan(at('exit'));
    // Bottom-up: the LAST entry is at the top, the FIRST (/models) is next to the query line, and the query echo is the bottom row.
    expect(at('exit')).toBeLessThan(at('cancel'));
    expect(at('cancel')).toBeLessThan(at('clear'));
    expect(at('help')).toBeLessThan(at('doctor'));
    expect(at('mode')).toBeLessThan(at('models'));
    expect(rows.indexOf('/'), 'the query echo is under the whole list').toBeGreaterThan(
      at('models'),
    );
    expect(highlighted(), 'the default row is the first one, never /exit').toBe('models');
    expect(at('models') + 1, '/models touches the query line').toBe(rows.indexOf('/'));
  });

  it('lists the 20 entries of a chat, /help among them, with a blank row between the groups when the rows allow', async () => {
    const { h, frame } = mountChat();
    await waitFor(() => (h.lastFrame() ?? '').length > 0);
    h.stdin.write('/');
    await waitFor(() => (h.lastFrame() ?? '').includes('Enter run'));
    await settleFrames();
    const shown = frame().flatMap((line) => {
      const match = /^[› ] \/([a-z]+)(?: |$)/u.exec(line);
      return match?.[1] === undefined ? [] : [match[1]];
    });
    // The window may hide the far end of a 24-row terminal's list; what is drawn is the declared order, reversed, and it starts at /models.
    const declared = REPL_COMMANDS.map((command) => command.name);
    expect(shown.at(-1)).toBe('models');
    expect([...shown].reverse()).toEqual(declared.slice(0, shown.length));
  });
});

describe('`/` then `Enter` in a chat', () => {
  it('runs /models, the first row: it never sends /exit and never ends the chat', async () => {
    const { h, submitted, onExit } = mountChat();
    await waitFor(() => (h.lastFrame() ?? '').length > 0);
    h.stdin.write('/');
    await waitFor(() => (h.lastFrame() ?? '').includes('Enter run'));
    h.stdin.write('\r');
    await waitFor(() => submitted.length > 0);
    expect(submitted).toEqual(['/models']);
    expect(onExit).not.toHaveBeenCalled();
  });

  it('walks ↑ to the end of the list, one entry at a time, and ↓ back; /exit is sent only by Enter on it', async () => {
    const { h, submitted, frame, highlighted } = mountChat();
    await waitFor(() => (h.lastFrame() ?? '').length > 0);
    h.stdin.write('/');
    await waitFor(() => (h.lastFrame() ?? '').includes('Enter run'));
    await settleFrames();
    expect(highlighted()).toBe('models');
    h.stdin.write(DOWN); // before the first entry: nothing happens, and it does not wrap to /exit
    await settleFrames();
    expect(highlighted()).toBe('models');
    h.stdin.write(UP);
    await waitFor(() => highlighted() === 'mode');
    h.stdin.write(UP);
    await waitFor(() => highlighted() === 'effort');
    h.stdin.write(DOWN);
    await waitFor(() => highlighted() === 'mode');
    for (let step = 0; step < 40; step += 1) h.stdin.write(UP); // far past the end: it stops on the last entry
    await waitFor(() => highlighted() === 'exit');
    await settleFrames();
    expect(
      frame().filter((line) => line.startsWith('› ')),
      'one highlighted row',
    ).toHaveLength(1);
    expect(submitted, 'the highlight alone sends nothing').toEqual([]);
    h.stdin.write('\r');
    await waitFor(() => submitted.length > 0);
    expect(submitted).toEqual(['/exit']);
  });

  it('runs the best match of a typed query, not an earlier row: `c` is /cost, and never /clear, /cancel or /compact', async () => {
    const { h, submitted } = mountChat();
    await waitFor(() => (h.lastFrame() ?? '').length > 0);
    h.stdin.write('/');
    await waitFor(() => (h.lastFrame() ?? '').includes('Enter run'));
    h.stdin.write('c');
    await waitFor(() => (h.lastFrame() ?? '').includes('/c'));
    await settleFrames();
    h.stdin.write('\r');
    await waitFor(() => submitted.length > 0);
    // `c` starts cost, copy, compact, clear and cancel: the commands that end a session or spend tokens come after the others.
    expect(submitted).toEqual(['/cost']);
  });

  it('keeps a bracketed paste out of the palette filter (the palette owns the keyboard)', async () => {
    const { h, submitted } = mountChat();
    await waitFor(() => (h.lastFrame() ?? '').length > 0);
    h.stdin.write('/');
    await waitFor(() => (h.lastFrame() ?? '').includes('Enter run'));
    h.stdin.write(bracketed('exit'));
    await settleFrames();
    h.stdin.write('\r');
    await waitFor(() => submitted.length > 0);
    expect(submitted, 'the paste did not type "exit" into the filter: /models ran').toEqual([
      '/models',
    ]);
  });
});
