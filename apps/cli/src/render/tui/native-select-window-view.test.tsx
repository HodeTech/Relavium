import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatStore } from './chat-store.js';
import { RootApp } from './home-app.js';
import { createHomeController } from './home-controller.js';
import {
  createNativePromptChannel,
  NATIVE_PROMPT_CANCEL,
  type NativePromptOption,
} from './native-prompt-channel.js';
import { NativePromptHost } from './native-prompt-host.js';
import { FULLSCREEN_TRANSCRIPT_BOUND, INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import { stylesOver } from './emphasis-test-kit.js';
import { settleFrames, waitFor, withoutStyles } from './harness-util.js';

afterEach(cleanup);

const DOWN = '\x1b[B';
const UP = '\x1b[A';
const PGDN = '\x1b[6~';
const PGUP = '\x1b[5~';

/** The workflows the run picker lists: a slug as the label and the answer, and its file as the hint (what `run-launch.ts` hands the prompt). */
function workflows(
  count: number,
  hint: (index: number) => string = (index) => `.relavium/workflows/wf-${slug(index)}.yaml`,
): NativePromptOption[] {
  return Array.from({ length: count }, (_, index) => ({
    value: `wf-${slug(index)}`,
    label: `wf-${slug(index)}`,
    hint: hint(index),
  }));
}
const slug = (index: number): string => String(index).padStart(2, '0');

/** A real native prompt host on a terminal of `cols` x `rows`, with the select open; the card is painted and acknowledged before it returns. */
async function open(
  options: readonly NativePromptOption[],
  size: { cols: number; rows: number } = { cols: 80, rows: 24 },
  extra: { message?: string; note?: string; escape?: 'cancel' | 'back' } = {},
) {
  const { ui, flow } = createNativePromptChannel();
  flow.begin();
  if (extra.note !== undefined) flow.note(extra.note);
  const answer = flow.select({
    message: extra.message ?? 'Run which workflow?',
    options,
    escape: extra.escape ?? 'cancel',
  });
  const h = render(<NativePromptHost ui={ui} color={false} />);
  Object.defineProperty(h.stdout, 'columns', { value: size.cols });
  Object.defineProperty(h.stdout, 'rows', { value: size.rows });
  h.stdout.emit('resize');
  const rawFrame = (): string => h.lastFrame() ?? '';
  const frame = (): string => withoutStyles(rawFrame());
  const lines = (): string[] => frame().split('\n');
  const visible = (): boolean => {
    try {
      ui.assertVisible(ui.getSnapshot());
      return true;
    } catch {
      return false;
    }
  };
  await waitFor(
    () => frame().includes(options[0]?.label ?? '') || frame().includes('does not fit'),
  );
  await waitFor(visible, 40);
  /** A key, then wait for the row it must reach and for that frame to be acknowledged, as a person typing at human speed would. */
  const press = async (sequence: string, selected: number): Promise<void> => {
    h.stdin.write(sequence);
    await waitFor(() => ui.getSnapshot().selected === selected);
    await waitFor(visible, 40);
  };
  return { ui, flow, h, answer, frame, rawFrame, lines, visible, press };
}

type Opened = Awaited<ReturnType<typeof open>>;
async function close(o: Opened): Promise<void> {
  o.h.stdin.write('\x1b');
  await o.answer;
  await o.flow.end();
  o.ui.dispose();
}
const cursorRows = (o: Opened): string[] => o.lines().filter((line) => line.startsWith('> '));

describe('the row under the cursor of a select card', () => {
  it('is the selected row, bold and inverse, and the rows around it are neither (colour is off here, and the cursor is `>`)', async () => {
    const o = await open(workflows(5));
    try {
      const raw = o.rawFrame();
      expect(stylesOver(raw, '> wf-00')).toEqual(['bold', 'inverse']);
      expect(stylesOver(raw, 'wf-01') ?? []).toEqual([]);
      expect(stylesOver(raw, 'wf-04') ?? []).toEqual([]);
      await o.press(DOWN, 1);
      expect(stylesOver(o.rawFrame(), '> wf-01')).toEqual(['bold', 'inverse']);
      expect(stylesOver(o.rawFrame(), 'wf-00') ?? []).toEqual([]);
    } finally {
      await close(o);
    }
  });
});

describe('a select card with more options than the terminal holds (LAUNCH-4)', () => {
  it('draws a window of a 60-workflow list at 80x24, with a `v` marker and no refusal, and the keys are delivered', async () => {
    const o = await open(workflows(60));
    try {
      const frame = o.frame();
      expect(frame).not.toContain('does not fit');
      expect(frame).toContain('Run which workflow?');
      expect(frame).toContain('> wf-00');
      expect(frame).toContain('v 40 more');
      expect(frame).not.toContain('^');
      // 20 rows are drawn, the 21st line is the marker, and the rest are hidden.
      expect(frame).toContain('wf-19');
      expect(frame).not.toContain('wf-20');
      expect(frame).not.toContain('wf-59');
      expect(frame).toContain('PgUp/PgDn page');
      // The card is the question, 21 list lines and the legend: it fits the 23 rows a card may use.
      expect(o.lines().length).toBeLessThanOrEqual(23);
      expect(o.visible()).toBe(true);
      // The list has no number shortcuts, so no key selects a row the person cannot see: a digit is typing into nothing.
      o.h.stdin.write('5');
      o.h.stdin.write('9');
      await settleFrames(8);
      expect(o.ui.getSnapshot().selected).toBe(0);
    } finally {
      await close(o);
    }
  });

  it('reaches the last row with the arrow key, shows it under a `^` marker, and Enter answers that workflow', async () => {
    const o = await open(workflows(60));
    try {
      for (let step = 1; step <= 59; step += 1) {
        await o.press(DOWN, step);
        // The cursor is on a drawn row at every step, and there is exactly one.
        expect(cursorRows(o), `after ${String(step)} presses`).toEqual([
          expect.stringContaining(`wf-${slug(step)}`),
        ]);
        expect(o.frame()).not.toContain('does not fit');
      }
      const frame = o.frame();
      expect(cursorRows(o)[0]).toContain('wf-59');
      expect(frame).toContain('^ 40 more');
      expect(frame).not.toMatch(/^\s*v \d+ more$/mu);
      expect(frame).not.toContain('wf-00');
      expect(o.ui.getSnapshot().selected).toBe(59);
      o.h.stdin.write('\r');
      expect(await o.answer).toBe('wf-59');
    } finally {
      await o.flow.end();
      o.ui.dispose();
    }
  });

  it('wraps from the first row to the last with `↑`, as it always did, and still draws the cursor', async () => {
    const o = await open(workflows(60));
    try {
      await o.press(UP, 59);
      expect(cursorRows(o)[0]).toContain('wf-59');
      expect(o.frame()).toContain('^ 40 more');
    } finally {
      await close(o);
    }
  });

  it('pages by a window with `PgDn` and `PgUp`, stops at the ends, and keeps the cursor drawn', async () => {
    const o = await open(workflows(60));
    try {
      // 19 rows: a window that hides both sides draws 19 rows between its markers at 80x24.
      await o.press(PGDN, 19);
      expect(cursorRows(o)[0]).toContain('wf-19');
      expect(o.frame()).toContain('^');
      expect(o.frame()).toMatch(/^\s*v \d+ more$/mu);
      await o.press(PGDN, 38);
      await o.press(PGDN, 57);
      expect(cursorRows(o)[0]).toContain('wf-57');
      await o.press(PGDN, 59);
      expect(cursorRows(o)[0]).toContain('wf-59');
      // Nothing below the last row: a page does not wrap the way an arrow does, and nothing is published.
      o.h.stdin.write(PGDN);
      await settleFrames(8);
      expect(o.ui.getSnapshot().selected).toBe(59);
      await o.press(PGUP, 40);
      await o.press(PGUP, 21);
      await o.press(PGUP, 2);
      await o.press(PGUP, 0);
      expect(cursorRows(o)[0]).toContain('wf-00');
      o.h.stdin.write(PGUP);
      await settleFrames(8);
      expect(o.ui.getSnapshot().selected).toBe(0);
      expect(o.frame()).not.toContain('^');
    } finally {
      await close(o);
    }
  });

  it('answers the row a page left the cursor on, never one the person cannot see', async () => {
    const o = await open(workflows(60));
    try {
      await o.press(PGDN, 19);
      await o.press(DOWN, 20);
      // The answer is the row under the cursor, and that row is the one the card draws with its cursor.
      const drawn = cursorRows(o)[0] ?? '';
      expect(drawn).toContain('wf-20');
      o.h.stdin.write('\r');
      expect(await o.answer).toBe('wf-20');
    } finally {
      await o.flow.end();
      o.ui.dispose();
    }
  });

  it('draws a 3-workflow list exactly as before: every row, no marker, no page key in the legend, and the page keys do nothing', async () => {
    const o = await open(workflows(3));
    try {
      expect(o.lines().map((line) => line.trimEnd())).toEqual([
        'Run which workflow?',
        '> wf-00 — .relavium/workflows/wf-00.yaml',
        '  wf-01 — .relavium/workflows/wf-01.yaml',
        '  wf-02 — .relavium/workflows/wf-02.yaml',
        '↑/↓ select · Enter choose · Esc close',
      ]);
      o.h.stdin.write(PGDN);
      await settleFrames(8);
      expect(o.ui.getSnapshot().selected).toBe(0);
      await o.press(DOWN, 1);
      expect(o.lines().map((line) => line.trimEnd())).toContain(
        '> wf-01 — .relavium/workflows/wf-01.yaml',
      );
    } finally {
      await close(o);
    }
  });

  it('draws the whole list unchanged when it fits a taller terminal, and windows the same 60 there too', async () => {
    const tall = await open(workflows(30), { cols: 100, rows: 40 });
    try {
      expect(tall.frame()).not.toContain('more');
      expect(tall.frame()).toContain('wf-29');
      expect(tall.frame()).toContain('↑/↓ select · Enter choose · Esc close');
    } finally {
      await close(tall);
    }
    const o = await open(workflows(60), { cols: 100, rows: 40 });
    try {
      // 39 rows to use, the question and the legend: 37 list lines, the last a marker.
      expect(o.frame()).toContain('v 24 more');
      expect(o.frame()).toContain('wf-35');
      expect(o.frame()).not.toContain('wf-36');
      expect(o.lines().length).toBeLessThanOrEqual(39);
      expect(o.frame()).not.toContain('does not fit');
    } finally {
      await close(o);
    }
  });

  it('counts a wrapped row as two: 11 two-row workflows are windowed to one row each, and 10 are drawn as they were', async () => {
    const hint = (): string => 'ab '.repeat(35).trimEnd();
    const fits = await open(workflows(10, hint));
    try {
      // Whole, so every option wraps onto a second row, exactly as before.
      expect(fits.lines().filter((line) => line.includes('wf-'))).toHaveLength(10);
      expect(fits.lines()).toHaveLength(22);
      expect(fits.frame()).not.toContain('PgUp/PgDn');
    } finally {
      await close(fits);
    }
    const o = await open(workflows(11, hint));
    try {
      expect(o.frame()).not.toContain('does not fit');
      expect(o.lines().filter((line) => line.includes('wf-'))).toHaveLength(11);
      expect(o.frame()).not.toContain('more');
      expect(o.frame()).toContain('PgUp/PgDn page');
      expect(o.visible()).toBe(true);
    } finally {
      await close(o);
    }
  });

  it('gives a note its rows and still fits, and says what Esc does when it steps back', async () => {
    const o = await open(workflows(60), undefined, {
      note: 'Not offered, the file is not valid: ' + 'broken '.repeat(30),
      escape: 'back',
    });
    try {
      expect(o.frame()).not.toContain('does not fit');
      expect(o.frame()).toContain('Not offered, the file is not valid');
      expect(o.frame()).toMatch(/^\s*v \d+ more$/mu);
      expect(o.frame()).toContain('PgUp/PgDn page · Enter choose · Esc back · [Ctrl+C] close');
      expect(o.visible()).toBe(true);
      await o.press(PGDN, 15);
      expect(cursorRows(o)).toHaveLength(1);
    } finally {
      await close(o);
    }
  });

  it('still refuses a question too long to leave even one row, and says so', async () => {
    const o = await open(workflows(60), undefined, { message: 'Disclosure ' + 's'.repeat(4000) });
    try {
      await waitFor(() => o.frame().includes('does not fit'));
      expect(o.frame()).toContain('Prompt does not fit');
      expect(o.visible()).toBe(false);
      o.h.stdin.write(DOWN);
      await settleFrames(8);
      expect(o.ui.getSnapshot().selected).toBe(0);
      o.h.stdin.write('\x1b');
      expect(await o.answer).toBe(NATIVE_PROMPT_CANCEL);
    } finally {
      await o.flow.end();
      o.ui.dispose();
    }
  });

  it('keeps the minimum terminal: below 80x24 the card is not drawn and no key reaches the list', async () => {
    const o = await open(workflows(60), { cols: 80, rows: 10 });
    try {
      await waitFor(() => o.frame().includes('Terminal too small'));
      expect(o.frame()).toContain('Terminal too small');
      expect(o.frame()).not.toContain('wf-00');
      o.h.stdin.write(DOWN);
      o.h.stdin.write(PGDN);
      await settleFrames(8);
      expect(o.ui.getSnapshot().selected).toBe(0);
    } finally {
      await close(o);
    }
  });
});

/** The Home as `drive-home` mounts it: the card is drawn by the Home's own view, on the landing and over a live chat. */
describe.each([
  { surface: 'the landing', chat: false, alternate: true },
  { surface: 'a chat on the alternate screen', chat: true, alternate: true },
  { surface: 'an inline chat', chat: true, alternate: false },
])('the run picker of 60 workflows in the Home, over $surface', ({ chat, alternate }) => {
  async function mount() {
    const channel = createNativePromptChannel();
    const store = createChatStore(
      false,
      undefined,
      alternate ? FULLSCREEN_TRANSCRIPT_BOUND : INLINE_TRANSCRIPT_BOUND,
    );
    const session = {
      store,
      sessionId: 'id',
      processLine: async () => {},
      shouldStop: () => false,
      stopReason: () => 'exit' as const,
      teardown: () => Promise.resolve(),
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
      onExit: vi.fn(),
      onError: vi.fn(),
    });
    const h = render(
      <RootApp
        controller={controller}
        nativePrompt={channel.ui}
        nowMs={() => 0}
        color={false}
        alternateScreen={alternate}
        getSize={() => ({ cols: 80, rows: 24 })}
        subscribeResize={() => () => {}}
      />,
    );
    // The harness terminal is 100 columns wide; the Home is told 80, and a card wider than the terminal it measured is refused.
    Object.defineProperty(h.stdout, 'columns', { value: 80 });
    if (chat) {
      controller.handleKey('h', {});
      controller.handleKey('i', {});
      controller.handleKey('', { return: true });
      await waitFor(() => controller.getSnapshot().mode === 'chat');
      store.appendUser('existing transcript');
    }
    channel.flow.begin();
    const answer = channel.flow.select({
      message: 'Run which workflow?',
      options: workflows(60),
      escape: 'cancel',
    });
    const frame = (): string => h.lastFrame() ?? '';
    const visible = (): boolean => {
      try {
        channel.ui.assertVisible(channel.ui.getSnapshot());
        return true;
      } catch {
        return false;
      }
    };
    await waitFor(
      () => frame().includes('Run which workflow?') || frame().includes('does not fit'),
    );
    await waitFor(visible, 40);
    return { h, channel, answer, frame, visible };
  }

  it('draws the window and takes the keys: it is measured to fit, never refused', async () => {
    const m = await mount();
    try {
      expect(m.frame()).not.toContain('does not fit');
      expect(m.frame()).toContain('> wf-00');
      expect(m.frame()).toContain('v 40 more');
      expect(m.visible()).toBe(true);
      m.h.stdin.write(PGDN);
      await waitFor(() => m.channel.ui.getSnapshot().selected === 19);
      await waitFor(m.visible, 40);
      expect(m.frame()).toContain('> wf-19');
      m.h.stdin.write(UP);
      await waitFor(() => m.channel.ui.getSnapshot().selected === 18);
      await waitFor(m.visible, 40);
      m.h.stdin.write('\r');
      expect(await m.answer).toBe('wf-18');
    } finally {
      await m.channel.flow.end();
      m.channel.ui.dispose();
    }
  });
});
