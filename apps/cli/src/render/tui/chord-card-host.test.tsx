/**
 * The chord card in a mounted terminal: what is drawn, what a real key stream answers, and what a card that was never drawn cannot be
 * answered by ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §4).
 *
 * The terminal is owned (`OwnedTtyInput` / `OwnedTtyOutput`), so a key is written as the bytes a terminal sends and ink parses it. The
 * channel's clock is injected: the frame is acknowledged at time 0 and every key is stamped at a time the test chooses.
 */

import { render } from 'ink';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwnedTtyInput, OwnedTtyOutput } from '../../test-support.js';
import { bracketed, flush, settleFrames } from './harness-util.js';
import {
  createNativePromptChannel,
  NATIVE_PROMPT_BACK,
  NATIVE_PROMPT_CANCEL,
  type NativePromptEscape,
} from './native-prompt-channel.js';
import { NativePromptHost } from './native-prompt-host.js';

/** The one named bound of every `vi.waitFor` in this file: a wait that needs it is a defect, not a slow machine. */
const WAIT_MS = 5000;

const mounts: Array<() => void> = [];
afterEach(() => {
  for (const close of mounts.splice(0)) close();
});

function mount(cols: number, rows: number, escape?: NativePromptEscape, withCard = true) {
  const input = new OwnedTtyInput();
  const output = new OwnedTtyOutput();
  const stderr = new OwnedTtyOutput();
  output.columns = cols;
  output.rows = rows;
  let now = 0;
  const channel = createNativePromptChannel({ now: () => now });
  channel.flow.begin();
  const shown = vi.spyOn(channel.ui, 'shown');
  const instance = render(createElement(NativePromptHost, { ui: channel.ui, color: false }), {
    stdin: input,
    stdout: output,
    stderr,
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
    alternateScreen: false,
  });
  mounts.push(() => {
    channel.ui.dispose();
    instance.unmount();
    input.destroy();
    output.destroy();
    stderr.destroy();
  });
  const result = { done: false, value: undefined as unknown };
  if (withCard)
    void channel.flow
      .chord({
        message: 'Allow MCP server on this machine?',
        details: ['server     files (inline)', 'argument   [Ctrl+Y] Allow'],
        allow: 'Allow, and remember it on this machine',
        deny: 'Refuse, and start nothing',
        ...(escape === undefined ? {} : { escape }),
      })
      .then((value) => {
        result.done = true;
        result.value = value;
      });
  return {
    ...channel,
    input,
    output,
    result,
    shown,
    at: (ms: number): void => {
      now = ms;
    },
    text: (): string => output.frames.join(''),
    /** The card is drawn, measured and acknowledged. */
    painted: () =>
      vi.waitFor(
        () => {
          expect(shown).toHaveBeenCalled();
          expect(() => channel.ui.assertVisible(channel.ui.getSnapshot())).not.toThrow();
        },
        { timeout: WAIT_MS },
      ),
    resize: (columns: number, height: number): void => {
      output.columns = columns;
      output.rows = height;
      output.emit('resize');
    },
  };
}

describe('the chord card in a terminal', () => {
  it('draws the question, the body behind the host gutter, both key rows and the Esc line', async () => {
    const f = mount(80, 24);
    await f.painted();
    const text = f.text();
    expect(text).toContain('Allow MCP server on this machine?');
    expect(text).toContain('│ server     files (inline)');
    // A body row that spells a key row stays behind the gutter: column 0 is the host's.
    expect(text).toContain('│ argument   [Ctrl+Y] Allow');
    expect(text).toContain('[Ctrl+Y] Allow, and remember it on this machine');
    expect(text).toContain('[Ctrl+N] Refuse, and start nothing');
    expect(text).toContain('Esc cancel');
    expect(text).not.toContain('for this run');
  });

  it('answers a Ctrl+Y that arrives after the dwell, and a bare letter or a paste before it answers nothing', async () => {
    const f = mount(80, 24);
    await f.painted(); // acknowledged at clock time 0
    f.at(5000);
    // One key per read: bytes written together reach ink as one run of text, which is not a key at all.
    for (const bytes of ['y', 'Y', 'n', bracketed('y'), bracketed('\x19'), '\r']) {
      f.input.push(bytes);
      await flush();
      await flush();
    }
    expect(f.result.done).toBe(false);
    f.at(60_000); // long after the typing and the dwell
    f.input.push('\x19'); // Ctrl+Y
    await vi.waitFor(() => expect(f.result.done).toBe(true), { timeout: WAIT_MS });
    expect(f.result.value).toBe('allow');
  });

  it('a Ctrl+Y inside the dwell, typed into a card that has just appeared, answers nothing', async () => {
    const f = mount(80, 24);
    await f.painted();
    f.at(50); // 50 ms after the frame was acknowledged
    f.input.push('\x19');
    await flush();
    await flush();
    expect(f.result.done).toBe(false);
    f.at(5000);
    f.input.push('\x0e'); // Ctrl+N refuses at any time
    await vi.waitFor(() => expect(f.result.done).toBe(true), { timeout: WAIT_MS });
    expect(f.result.value).toBe('deny');
  });

  it('a terminal too small to hold the card never answers it, and Esc still leaves', async () => {
    const f = mount(80, 23);
    await flush();
    await flush();
    expect(f.text()).toContain('Terminal too small');
    expect(f.shown).not.toHaveBeenCalled();
    f.at(60_000);
    f.input.push('\x19');
    f.input.push('\x0e');
    await flush();
    await flush();
    expect(f.result.done).toBe(false);
    f.input.push('\x1b');
    await vi.waitFor(() => expect(f.result.done).toBe(true), { timeout: WAIT_MS });
    expect(f.result.value).toBe(NATIVE_PROMPT_CANCEL);
  });

  it('a card that was resized is a new frame: its dwell starts again', async () => {
    const f = mount(80, 24);
    await f.painted();
    expect(f.shown).toHaveBeenCalledTimes(1);
    f.at(10_000);
    f.resize(80, 24);
    await vi.waitFor(() => expect(f.shown).toHaveBeenCalledTimes(2), { timeout: WAIT_MS });
    f.at(10_100); // 100 ms after the redrawn frame
    f.input.push('\x19');
    await flush();
    await flush();
    expect(f.result.done).toBe(false);
    f.at(20_000);
    f.input.push('\x19');
    await vi.waitFor(() => expect(f.result.done).toBe(true), { timeout: WAIT_MS });
    expect(f.result.value).toBe('allow');
  });

  it('Esc and Ctrl+C decide nothing: the card settles as cancelled', async () => {
    for (const bytes of ['\x1b', '\x03']) {
      const f = mount(80, 24);
      await f.painted();
      f.at(60_000);
      f.input.push(bytes);
      await vi.waitFor(() => expect(f.result.done).toBe(true), { timeout: WAIT_MS });
      expect(f.result.value).toBe(NATIVE_PROMPT_CANCEL);
    }
  });

  it.each([
    ['note', (f: ReturnType<typeof mount>, text: string) => f.flow.note(text)],
    ['committedNote', (f: ReturnType<typeof mount>, text: string) => f.flow.committedNote?.(text)],
  ] as const)(
    'a %s published while the card is open is not drawn on it, and shows once the card has settled',
    async (_name, publishNote) => {
      const f = mount(80, 24);
      await f.painted();
      publishNote(f, 'LATE NOTE from a flow');
      await settleFrames();
      expect(f.ui.getSnapshot().note, 'the card carries no note').toBe('');
      expect(f.text(), 'column 0 is the host`s: no note is drawn above the card').not.toContain(
        'LATE NOTE',
      );
      // The card settles, and what a flow said meanwhile is not lost: it is on the frame that follows.
      f.at(60_000);
      f.input.push('\x1b');
      await vi.waitFor(() => expect(f.result.done).toBe(true), { timeout: WAIT_MS });
      expect(f.ui.getSnapshot().note).toBe('LATE NOTE from a flow');
    },
  );

  it('the same note published before a card opens is drawn', async () => {
    const f = mount(80, 24, undefined, false);
    f.flow.busy('Saving');
    f.flow.note('EARLY NOTE from a flow');
    await vi.waitFor(() => expect(f.text()).toContain('EARLY NOTE from a flow'), {
      timeout: WAIT_MS,
    });
    expect(f.ui.getSnapshot().note).toBe('EARLY NOTE from a flow');
  });

  it('in back mode the line says so, Esc steps back and Ctrl+C leaves', async () => {
    const stepped = mount(80, 24, 'back');
    await stepped.painted();
    expect(stepped.text()).toContain('Esc back · Ctrl+C leave');
    stepped.at(60_000);
    stepped.input.push('\x1b');
    await vi.waitFor(() => expect(stepped.result.done).toBe(true), { timeout: WAIT_MS });
    expect(stepped.result.value).toBe(NATIVE_PROMPT_BACK);
    expect(stepped.ui.signal()?.aborted).toBe(false);

    const left = mount(80, 24, 'back');
    await left.painted();
    left.at(60_000);
    left.input.push('\x03');
    await vi.waitFor(() => expect(left.result.done).toBe(true), { timeout: WAIT_MS });
    expect(left.result.value).toBe(NATIVE_PROMPT_CANCEL);
    expect(left.ui.signal()?.aborted).toBe(true);
  });
});
