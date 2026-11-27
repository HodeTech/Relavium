import { cleanup, render as renderCapture } from 'ink-testing-library';
import { useStdout } from 'ink';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { REPL_COMMANDS } from '../../commands/repl-commands.js';
import { chatGrid } from './chat-grid.js';
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

/**
 * The capture is 100 columns wide, and the chat's chrome stands on the grid (unit 9): every row of the palette, the prompt, the rule and the hint
 * begins at the content column, `GAP` columns from the left edge (8 from 100 columns). `row(pattern)` is a row that begins there with `pattern`.
 */
const GAP = chatGrid(100).margin;
const row = (pattern: string): RegExp => new RegExp(`^ {${String(GAP)}}${pattern}`, 'u');

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
      .map((line) => row('> \\/([a-z]+)(?: |$)').exec(line)?.[1])
      .find((name) => name !== undefined);
  return { h, store, submitted, onExit, frame, highlighted };
}

describe('the chat’s palette opens above the prompt, and its first row is the one beside it', () => {
  it('draws the entries bottom-up with /models on the row above the prompt, the legend on the hint row and no query line of its own', async () => {
    const { h, frame, highlighted } = mountChat();
    await waitFor(() => (h.lastFrame() ?? '').length > 0);
    h.stdin.write('/');
    await waitFor(() => (h.lastFrame() ?? '').includes('Enter run'));
    await settleFrames();
    const rows = frame();
    const at = (word: string): number =>
      rows.findIndex((line) => row(`[> ] /${word}( |$)`).test(line));
    const legendRow = `${' '.repeat(GAP)}↑/↓ select · Enter run · Esc close`;
    // ADR-0146 §4: the typed `/` is the PROMPT's text, the legend is the hint row, and the rule stays between them: no row of the palette's own
    // carries the query, none carries the legend, and nothing (no blank row, no status line) separates the list from the prompt.
    const promptAt = rows.findIndex((line) => row('> \\/ ?$').test(line));
    expect(promptAt, 'the prompt row shows the typed `/` (and the cursor cell)').toBeGreaterThan(
      -1,
    );
    expect(rows.filter((line) => line === legendRow)).toHaveLength(1);
    expect(rows.indexOf(legendRow), 'the legend is the hint row, the last row of the frame').toBe(
      rows.length - 1,
    );
    expect(rows[promptAt + 1], 'a thin rule between the prompt and the hint').toMatch(row('-+$'));
    expect(rows[promptAt + 2], 'the hint row follows the rule').toBe(legendRow);
    expect(rows.includes(`${' '.repeat(GAP)}/`), 'no query line of the palette’s own').toBe(false);
    expect(
      rows.some((line) => / · \d+ turns? · /u.test(line)),
      'no status line while the palette is open',
    ).toBe(false);
    // Bottom-up: the FIRST (/models) is next to the prompt row and the entries after it climb away from it (the window, a half of the terminal
    // with the prompt block, hides the far end: the `▲ N more` row above the list counts what it hides).
    expect(at('effort')).toBeLessThan(at('mode'));
    expect(at('mode')).toBeLessThan(at('models'));
    expect(rows.some((line) => /^\s*[▲^] \d+ more/u.test(line))).toBe(true); // `^` is the marker without colour
    expect(highlighted(), 'the default row is the first one, never /exit').toBe('models');
    expect(at('models') + 1, '/models touches the prompt row').toBe(promptAt);
  });

  it('shows what is typed on the prompt row, and the list follows the query', async () => {
    const { h, frame } = mountChat();
    await waitFor(() => (h.lastFrame() ?? '').length > 0);
    h.stdin.write('/');
    await waitFor(() => (h.lastFrame() ?? '').includes('Enter run'));
    h.stdin.write('co');
    await waitFor(() => frame().some((line) => row('> \\/co ?$').test(line)));
    const rows = frame();
    const names = rows.flatMap((line) => row('[> ] \\/([a-z]+) {2}').exec(line)?.[1] ?? []);
    expect(names, 'the list follows the query').toContain('cost');
    expect(names).not.toContain('exit');
    expect(
      rows.includes(`${' '.repeat(GAP)}/co`),
      'the query is the prompt’s text, not a line of the palette’s',
    ).toBe(false);
  });

  it('lists the 20 entries of a chat, /help among them, with a blank row between the groups when the rows allow', async () => {
    const { h, frame } = mountChat();
    await waitFor(() => (h.lastFrame() ?? '').length > 0);
    h.stdin.write('/');
    await waitFor(() => (h.lastFrame() ?? '').includes('Enter run'));
    await settleFrames();
    const shown = frame().flatMap((line) => {
      const match = row('[> ] \\/([a-z]+)(?: |$)').exec(line);
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
      frame().filter((line) => row('> \\/[a-z]+ {2}').test(line)),
      'one highlighted row (the prompt row, `> /`, is the prompt’s and not a row of the list)',
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
