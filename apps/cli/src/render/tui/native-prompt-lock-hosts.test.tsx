import './force-color.js';

/**
 * The guarded wait drawn by the real views (the maintainer's ruling of 2026-11-26 on ADR-0145 §3, MVP-11 step 6 round 1, O4): a chord CARD's
 * `[Ctrl+Y]` row and a chord step framed as a POPUP in the Home's slot both say `(wait)` while the lockout holds and lose it with one repaint at
 * the unlock instant; the part is dim with colour and the word stays without it (`NO_COLOR`: dim is dropped, `(wait)` is not); and a `Ctrl+Y`
 * pressed right after that repaint is answered, so the repaint restarted no dwell, no opening settle and no acknowledgement. The card runs on a
 * manual clock through the real measured-frame acknowledgement; the popup runs in the Home's real hosts on the real clock (named waits).
 */
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { settleFrames, waitFor } from './harness-util.js';
import { createNativePromptChannel, type NativePopupDescriptor } from './native-prompt-channel.js';
import { NativePromptHost } from './native-prompt-host.js';
import { KEYS, mountHome } from './surface-matrix/home-host.js';
import { APPROVAL_LOCKOUT_MS } from './tool-review-model.js';

afterEach(cleanup);

const DIM = '\u001b[2m';
/** Every SGR sequence, so a row reads as its text. */
// eslint-disable-next-line no-control-regex -- the escape byte is what is stripped.
const SGR = /\u001b\[[0-9;]*m/gu;
const plain = (text: string): string => text.replace(SGR, '');

/** How long the Home's real clock is watched for the lock to open: past the lockout, with room for a loaded machine. */
const UNLOCK_WATCH_MS = APPROVAL_LOCKOUT_MS + 1500;
/** How often the frame is looked at while it is watched. */
const POLL_MS = 10;
/** How long a pending answer is watched before the test says it did not come. */
const WATCH_MS = 150;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** Look at `predicate` every {@link POLL_MS} on the real clock until it holds or `ms` pass; `true` when it held. */
async function watchFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (predicate()) return true;
    await pause(POLL_MS);
  }
  return predicate();
}
const PENDING: unique symbol = Symbol('pending');
const within = <T,>(promise: Promise<T>, ms = WATCH_MS): Promise<T | typeof PENDING> =>
  Promise.race([promise, pause(ms).then((): typeof PENDING => PENDING)]);

/** A manual clock whose one-shot timers run when time moves. */
function manualTimers() {
  const pending: { at: number; run: () => void; cancelled: boolean }[] = [];
  let now = 0;
  return {
    now: (): number => now,
    schedule: (run: () => void, ms: number): (() => void) => {
      const timer = { at: now + ms, run, cancelled: false };
      pending.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    advance: (ms: number): void => {
      const end = now + ms;
      for (;;) {
        const next = pending
          .filter((timer) => !timer.cancelled && timer.at <= end)
          .sort((a, b) => a.at - b.at)[0];
        if (next === undefined) break;
        next.cancelled = true;
        now = next.at;
        next.run();
      }
      now = end;
    },
  };
}

/** The frame's row that holds `needle`, with its escape sequences. */
function rowWith(frame: string, needle: string): string {
  const row = frame.split('\n').find((line) => plain(line).includes(needle));
  if (row === undefined) throw new Error(`no row with "${needle}" in:\n${plain(frame)}`);
  return row;
}

describe('a chord card (the card form): its `[Ctrl+Y]` row waits, then acts', () => {
  it.each([true, false])(
    'colour %s: `[Ctrl+Y] Create them (wait)` (dim only with colour) until the lockout ends, one repaint without it, and Ctrl+Y then answers',
    async (color) => {
      const time = manualTimers();
      const { ui, flow } = createNativePromptChannel({ now: time.now, schedule: time.schedule });
      flow.begin();
      const answer = flow.chord({
        message: 'Create these project directories?',
        allow: 'Create them',
        deny: 'Create nothing',
      });
      const h = render(<NativePromptHost ui={ui} color={color} />);
      Object.defineProperty(h.stdout, 'rows', { value: 24 });
      h.stdout.emit('resize');
      await waitFor(() => plain(h.lastFrame() ?? '').includes('Create them'));
      await settleFrames();
      const locked = rowWith(h.lastFrame() ?? '', '[Ctrl+Y]');
      expect(plain(locked).trim()).toBe('[Ctrl+Y] Create them (wait)');
      expect(locked.includes(DIM)).toBe(color);
      // The refusal row acts now and is never drawn as waiting.
      expect(plain(rowWith(h.lastFrame() ?? '', '[Ctrl+N]')).trim()).toBe(
        '[Ctrl+N] Create nothing',
      );
      // The card's frame was acknowledged at 0; the lock opens at the lockout's end, by its one timer.
      time.advance(APPROVAL_LOCKOUT_MS);
      await waitFor(() => !plain(h.lastFrame() ?? '').includes('(wait)'));
      const open = rowWith(h.lastFrame() ?? '', '[Ctrl+Y]');
      expect(plain(open).trim()).toBe('[Ctrl+Y] Create them');
      expect(open.includes(DIM)).toBe(false);
      // At that same instant a Ctrl+Y answers: the repaint was no new frame (the dwell still counts from 0).
      h.stdin.write(KEYS.ctrlY);
      expect(await answer).toBe('allow');
      await flow.end();
      ui.dispose();
    },
  );
});

describe('a guarded select (the card form of the first run’s environment-key consent)', () => {
  it('its legend says `Enter choose (wait)` while the guarded option is held, then `Enter choose` with one repaint; Enter then answers', async () => {
    const time = manualTimers();
    const { ui, flow } = createNativePromptChannel({ now: time.now, schedule: time.schedule });
    flow.begin();
    const answer = flow.select({
      message: 'Use ANTHROPIC_API_KEY from this environment?',
      options: [
        { value: 'use', label: 'Use it', guarded: true },
        { value: 'not-now', label: 'Not now' },
      ],
    });
    const h = render(<NativePromptHost ui={ui} color={false} />);
    Object.defineProperty(h.stdout, 'rows', { value: 24 });
    h.stdout.emit('resize');
    await waitFor(() => plain(h.lastFrame() ?? '').includes('Use it'));
    await settleFrames();
    expect(plain(rowWith(h.lastFrame() ?? '', 'Enter choose')).trim()).toBe(
      '↑/↓ select · Enter choose (wait) · Esc close',
    );
    time.advance(APPROVAL_LOCKOUT_MS);
    await waitFor(() => !plain(h.lastFrame() ?? '').includes('(wait)'));
    expect(plain(rowWith(h.lastFrame() ?? '', 'Enter choose')).trim()).toBe(
      '↑/↓ select · Enter choose · Esc close',
    );
    h.stdin.write('\r');
    expect(await answer).toBe('use');
    await flow.end();
    ui.dispose();
  });
});

describe('a chord step framed as a popup in the Home', () => {
  const descriptor: NativePopupDescriptor = {
    title: '/init',
    origin: 'home',
    stepIndex: 1,
    stepCount: 3,
    stepNames: ['Check', 'Confirm', 'Done'],
    exitLabel: 'close',
    depth: 1,
  };

  it.each(['alt', 'inline'] as const)(
    '%s, no colour: its legend row says `(wait)` from the moment it appears, then loses it once; a Ctrl+Y right after that repaint answers',
    async (renderer) => {
      const m = mountHome(
        { renderer, color: false, size: { cols: 80, rows: 24 } },
        { nativePrompt: true },
      );
      try {
        await m.settle();
        const channel = m.channel;
        if (channel === undefined) throw new Error('no channel');
        channel.flow.begin();
        channel.flow.popup?.(descriptor);
        const answer = channel.flow.chord({
          message: 'Create these project directories?',
          details: ['.relavium/', '.relavium/workflows/'],
          allow: 'Create them',
          deny: 'Create nothing',
        });
        await m.until(() => m.frame().join('\n').includes('/init'));
        await m.settle();
        expect(m.frame().join('\n')).toContain(
          '[Ctrl+Y] Create them (wait) · [Ctrl+N] Create nothing · Esc denies',
        );
        expect(
          await watchFor(() => !m.frame().join('\n').includes('(wait)'), UNLOCK_WATCH_MS),
        ).toBe(true);
        expect(m.frame().join('\n')).toContain(
          '[Ctrl+Y] Create them · [Ctrl+N] Create nothing · Esc denies',
        );
        // Pressed at once: had the repaint been taken for a new frame (a dwell from it, or the popup's opening settle again), this is refused.
        m.key(KEYS.ctrlY);
        expect(await within(answer)).toBe('allow');
        await channel.flow.end();
      } finally {
        m.unmount();
      }
    },
  );
});
