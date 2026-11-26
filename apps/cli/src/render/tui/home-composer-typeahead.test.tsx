/**
 * Keys typed in the Home's composer while a card is open count as typing for the card's guard
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §4).
 *
 * A chord card answers `Ctrl+Y` only after the typeahead window has passed since the last foreign key, and only after the quiet gap
 * since ANY key. A key the person types while a card is open reaches the channel through the Home's one input owner, whether or not the
 * card has been painted yet: if it were dropped on the way, a person typing as a card appeared would be invisible to the guard that
 * exists for exactly that. The channel's clock is injected; the card's frame is acknowledged at a time the test chooses (a terminal too
 * small to hold it is a card that has not been painted).
 */
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HomeSnapshot } from '../../home/home-store.js';
import { RootApp } from './home-app.js';
import { createHomeController } from './home-controller.js';
import { bracketed, settleFrames, waitFor } from './harness-util.js';
import { createNativePromptChannel } from './native-prompt-channel.js';
import type { Key } from 'ink';

afterEach(cleanup);

const EMPTY: HomeSnapshot = {
  attention: { failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: true,
};

const none: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};

/** The numbers: a 1.5 s typeahead window and nothing else, so the typeahead layer is the only one that can refuse. */
const GUARD = { settleMs: 0, quietMs: 0, typeaheadMs: 1500, lockoutMs: 0 };
const CARD = {
  message: "Allow MCP server 'files' on this machine?",
  allow: 'Allow, and remember it on this machine',
  deny: 'Refuse, and start nothing',
};

function chordChannel() {
  let now = 0;
  const channel = createNativePromptChannel({ now: () => now, guard: GUARD });
  channel.ui.bindVisibility((snapshot) => snapshot === channel.ui.getSnapshot());
  return { ...channel, at: (ms: number): void => void (now = ms) };
}

describe('the channel counts what is typed around a card', () => {
  it('a key typed while the flow is open and no card is, is typeahead for the card that follows', async () => {
    const c = chordChannel();
    c.flow.begin();
    c.at(100);
    c.ui.input('x', none); // typing, with no prompt open yet
    const answer = c.flow.chord(CARD);
    let settled: unknown;
    void answer.then((value) => (settled = value));
    c.at(700); // 600 ms after the typing: inside the window
    c.ui.input('y', { ...none, ctrl: true });
    await settleFrames();
    expect(settled, 'refused: the person was typing a moment ago').toBeUndefined();
    c.at(1700); // 1600 ms after it: past the window
    c.ui.input('y', { ...none, ctrl: true });
    expect(await answer).toBe('allow');
    c.ui.dispose();
  });

  it('a key the host could not deliver (the card is not painted) still counts, and delivers nothing', async () => {
    const c = chordChannel();
    c.flow.begin();
    const answer = c.flow.chord(CARD);
    let settled: unknown;
    void answer.then((value) => (settled = value));
    c.at(100);
    c.ui.unseenInput();
    c.at(700);
    c.ui.input('y', { ...none, ctrl: true });
    await settleFrames();
    expect(settled).toBeUndefined();
    c.at(2000);
    c.ui.input('y', { ...none, ctrl: true });
    expect(await answer).toBe('allow');
    c.ui.dispose();
  });

  it('with no flow open it is a no-op: a key typed before any card is a composer edit, not typeahead', async () => {
    const c = chordChannel();
    c.at(100);
    c.ui.unseenInput(); // no flow: nothing happens, and nothing throws
    c.flow.begin();
    const answer = c.flow.chord(CARD);
    c.at(200); // 100 ms after that key: it must not have been counted
    c.ui.input('y', { ...none, ctrl: true });
    expect(await answer).toBe('allow');
    c.ui.dispose();
  });
});

describe('keys typed in the Home composer with a card open reach that counter', () => {
  function mount() {
    const c = chordChannel();
    let size = { cols: 60, rows: 24 }; // too small to hold a card: it is not painted
    let resize = (): void => undefined;
    const controller = createHomeController({
      startChat: () => Promise.reject(new Error('unexpected chat')),
      homeStore: { read: () => EMPTY },
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    const shown = vi.spyOn(c.ui, 'shown');
    const h = render(
      <RootApp
        controller={controller}
        nativePrompt={c.ui}
        nowMs={() => 0}
        color={false}
        getSize={() => size}
        subscribeResize={(callback) => {
          resize = callback;
          return () => {};
        }}
      />,
    );
    c.flow.begin();
    const answer = c.flow.chord(CARD);
    const result = { settled: undefined as unknown };
    void answer.then((value) => (result.settled = value));
    return {
      ...c,
      h,
      answer,
      result,
      controller,
      shown,
      /** The terminal grows to a size that holds the card; the card is painted and acknowledged. */
      grow: async (): Promise<void> => {
        size = { cols: 80, rows: 24 };
        resize();
        await waitFor(() => shown.mock.calls.length > 0);
        expect(shown).toHaveBeenCalled();
      },
    };
  }

  it('a key typed before the card is painted is counted: a Ctrl+Y soon after is refused, a later one answers', async () => {
    const f = mount();
    await waitFor(() => (f.h.lastFrame() ?? '').includes('Terminal too small'));
    expect(f.h.lastFrame()).toContain('Terminal too small');
    f.at(100);
    f.h.stdin.write('x'); // typed into the composer while the card is open but not on screen
    await settleFrames();
    f.at(200);
    await f.grow(); // the card is painted at 200 ms
    f.at(700); // 600 ms after the typing, 500 ms after the card was painted
    f.h.stdin.write('\x19'); // Ctrl+Y
    await settleFrames();
    expect(f.result.settled, 'refused: typeahead').toBeUndefined();
    f.at(2000);
    f.h.stdin.write('\x19');
    expect(await f.answer).toBe('allow');
    // The key went nowhere else: the composer behind the card is untouched.
    expect(f.controller.getSnapshot().input.text).toBe('');
    f.ui.dispose();
  });

  it('a paste before the card is painted counts too', async () => {
    const f = mount();
    await waitFor(() => (f.h.lastFrame() ?? '').includes('Terminal too small'));
    f.at(100);
    f.h.stdin.write(bracketed('some pasted words'));
    await settleFrames();
    f.at(200);
    await f.grow();
    f.at(700);
    f.h.stdin.write('\x19');
    await settleFrames();
    expect(f.result.settled).toBeUndefined();
    expect(f.controller.getSnapshot().input.text, 'nothing reached the composer').toBe('');
    f.at(2000);
    f.h.stdin.write('\x19');
    expect(await f.answer).toBe('allow');
    f.ui.dispose();
  });

  it('control: with nothing typed, the same Ctrl+Y at the same time answers', async () => {
    const f = mount();
    await waitFor(() => (f.h.lastFrame() ?? '').includes('Terminal too small'));
    f.at(200);
    await f.grow();
    f.at(700);
    f.h.stdin.write('\x19');
    expect(await f.answer).toBe('allow');
    f.ui.dispose();
  });
});
