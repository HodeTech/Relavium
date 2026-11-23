import './force-color.js';

import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HOME_PALETTE_COMMANDS } from '../../commands/repl-commands.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import { settleFrames } from './harness-util.js';
import { RootApp } from './home-app.js';
import { createHomeController, type HomeController } from './home-controller.js';

/**
 * The `/` palette on the bare Home never makes the landing taller than the terminal ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §3, MVP-8 step 5). The palette had no row cap: with `/import` and `/pricing` among its fourteen entries it was 25 lines on an empty Home at
 * 80×24, a terminal of 24 rows, and a Home with a strip or a long `/doctor` report was taller still. It now draws a window of its entries in the
 * rows the landing leaves (`palette-window.ts`; the strip and the notice give up rows to it), and a palette that fits is drawn whole, as before.
 *
 * Through a mounted `RootApp`, in the inline and the full-screen renderer, so the lines counted are the lines the terminal gets. The window's
 * arithmetic is `palette-window.test.ts`, and what `PaletteView` draws is `palette-view.test.tsx`.
 */
afterEach(cleanup);

const ESC = String.fromCharCode(0x1b);
const plain = (text: string): string => text.replace(new RegExp(`${ESC}\\[\\d+m`, 'gu'), '');

const session = (n: number) =>
  ({
    sessionId: `saved-${String(n)}`,
    title: `Saved conversation ${String(n)}`,
    workingDir: '/workspace',
    agentSlug: 'chat',
    modelId: undefined,
    status: 'ended',
    updatedAt: '2026-11-10T00:00:00.000Z',
    totalCostMicrocents: 0,
  }) as const;
const snapshotWith = (sessions: number): HomeSnapshot => ({
  attention: { gates: [], failedRuns: [] },
  recentSessions: Array.from({ length: sessions }, (_, index) => session(index)),
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: sessions === 0,
});

const FOOTER = '↑/↓ select · Enter run · Esc cancel';
const BANNER_TOP = '+--------------------------------------------------------+';

function mount(size: { cols: number; rows: number }, sessions: number, alternateScreen: boolean) {
  const onExit = vi.fn();
  const startChat = vi.fn(() => new Promise<never>(() => {}));
  const controller = createHomeController({
    doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
    startChat,
    homeStore: { read: () => snapshotWith(sessions) },
    schedule: () => () => {},
    onExit,
    onError: (cause) => {
      throw cause;
    },
  });
  const harness = render(
    <RootApp
      controller={controller}
      nowMs={() => 0}
      color={false}
      getSize={() => size}
      subscribeResize={() => () => {}}
      {...(alternateScreen ? { alternateScreen: true } : {})}
    />,
  );
  const frame = (): string[] => plain(harness.lastFrame() ?? '').split('\n');
  return { controller, harness, startChat, onExit, frame };
}
type Mounted = ReturnType<typeof mount>;

/** Open the palette from the empty prompt and let the frame settle. */
async function openPalette(m: Mounted): Promise<void> {
  await settleFrames();
  m.controller.handleKey('/', {});
  await settleFrames();
  expect(m.controller.getSnapshot().palette).toBeDefined();
}

const press = async (controller: HomeController, key: Record<string, boolean>): Promise<void> => {
  controller.handleKey('', key);
  await settleFrames();
};

/** The entries a frame names, by their slash words, in the order drawn. */
const entriesOf = (frame: readonly string[]): string[] =>
  frame.flatMap((line) => {
    const match = /^[› ] \/([a-z]+)(?: |$)/u.exec(line);
    return match?.[1] === undefined ? [] : [match[1]];
  });
const markersOf = (frame: readonly string[]): string[] =>
  frame.filter((line) => /^ {2}[▲▼] \d+ more$/u.test(line));
const highlightedOf = (frame: readonly string[]): string | undefined =>
  frame.map((line) => /^› \/([a-z]+)(?: |$)/u.exec(line)?.[1]).find((name) => name !== undefined);

describe.each([
  ['the inline renderer', false],
  ['the full-screen renderer', true],
] as const)('the palette on the landing in %s', (_name, alternateScreen) => {
  it('at 80×24 on an empty Home, with the banner, is a window of its entries and the landing is shorter than the terminal', async () => {
    const m = mount({ cols: 80, rows: 24 }, 0, alternateScreen);
    await openPalette(m);
    const frame = m.frame();
    expect(frame[0], 'the banner is drawn').toBe(BANNER_TOP);
    expect(frame, 'the greeting is drawn').toContain('  Welcome to Relavium.');
    expect(frame.length, 'a frame of the whole terminal makes Ink clear it').toBeLessThanOrEqual(
      23,
    );
    expect(frame.at(-1)).toBe(FOOTER);
    expect(markersOf(frame)).toEqual(['  ▼ 3 more']);
    expect(entriesOf(frame)).toEqual(
      HOME_PALETTE_COMMANDS.slice(0, 11).map((command) => command.name),
    );
    expect(highlightedOf(frame)).toBe('exit');
  });

  it('at 80×24 with one saved session draws every entry: they fit, so none is hidden and no marker is drawn', async () => {
    const m = mount({ cols: 80, rows: 24 }, 1, alternateScreen);
    await openPalette(m);
    const frame = m.frame();
    expect(frame.length).toBeLessThanOrEqual(23);
    expect(frame, 'the session is still on the landing').toContain('  Sessions');
    expect(entriesOf(frame)).toEqual(HOME_PALETTE_COMMANDS.map((command) => command.name));
    expect(markersOf(frame)).toEqual([]);
  });

  it('at 80×24 with a strip longer than the terminal, trims the strip and not the palette below the rows it keeps', async () => {
    const m = mount({ cols: 80, rows: 24 }, 8, alternateScreen);
    const closed = m.frame().length;
    await openPalette(m);
    const frame = m.frame();
    expect(closed, 'the landing alone fills the terminal').toBeGreaterThan(20);
    expect(frame.length).toBeLessThanOrEqual(23);
    expect(entriesOf(frame).length, 'the palette keeps its half of the terminal').toBeGreaterThan(
      6,
    );
    expect(frame.some((line) => line.startsWith('    Saved conversation 0'))).toBe(true);
    expect(frame.at(-1)).toBe(FOOTER);
  });

  it.each([0, 1, 3])(
    'at 80×24 with a long report on the landing (%i sessions), is windowed and the landing is shorter than the terminal',
    async (sessions) => {
      const m = mount({ cols: 80, rows: 24 }, sessions, alternateScreen);
      await openPalette(m);
      // A `/doctor` run that was started before the palette opened reports into the landing while it is open.
      m.controller.setProviderState(
        false,
        Array.from({ length: 40 }, (_, index) => `doctor line ${String(index)}`).join('\n'),
      );
      await settleFrames();
      const frame = m.frame();
      expect(frame.length).toBeLessThanOrEqual(23);
      expect(frame.some((line) => line.startsWith('Notice 1–'))).toBe(true);
      expect(frame, 'the report is drawn').toContain('doctor line 0');
      expect(frame.at(-1)).toBe(FOOTER);
      expect(highlightedOf(frame)).toBe('exit');
      expect(markersOf(frame).length).toBeGreaterThan(0);
    },
  );

  it('at 80×30 on an empty Home draws every entry, with no marker', async () => {
    const m = mount({ cols: 80, rows: 30 }, 0, alternateScreen);
    await openPalette(m);
    const frame = m.frame();
    expect(frame.length).toBeLessThanOrEqual(29);
    expect(entriesOf(frame)).toEqual(HOME_PALETTE_COMMANDS.map((command) => command.name));
    expect(markersOf(frame)).toEqual([]);
    expect(frame.at(-1)).toBe(FOOTER);
  });

  it('keeps the highlighted entry in the window: ↓ sixteen times from the first entry, then ↑ sixteen times', async () => {
    const m = mount({ cols: 80, rows: 24 }, 0, alternateScreen);
    await openPalette(m);
    const names = HOME_PALETTE_COMMANDS.map((command) => command.name);
    for (let step = 1; step <= 16; step += 1) {
      await press(m.controller, { downArrow: true });
      const frame = m.frame();
      expect(highlightedOf(frame), `↓ ${String(step)}`).toBe(names[Math.min(step, 13)]);
      expect(frame.length, `↓ ${String(step)}`).toBeLessThanOrEqual(23);
      expect(frame.at(-1)).toBe(FOOTER);
    }
    // At the end of the list the window shows the last entry and says what it hides above, and nothing below.
    const end = m.frame();
    expect(entriesOf(end).at(-1)).toBe('pricing');
    expect(markersOf(end).map((line) => line.trim().slice(0, 1))).toEqual(['▲']);
    for (let step = 1; step <= 16; step += 1) {
      await press(m.controller, { upArrow: true });
      const frame = m.frame();
      expect(highlightedOf(frame), `↑ ${String(step)}`).toBe(names[Math.max(0, 13 - step)]);
      expect(frame.length, `↑ ${String(step)}`).toBeLessThanOrEqual(23);
    }
    expect(entriesOf(m.frame())[0]).toBe('exit');
  });

  it('Enter runs the highlighted entry of a window, which is one the first frame did not show', async () => {
    const m = mount({ cols: 80, rows: 24 }, 0, alternateScreen);
    await openPalette(m);
    expect(entriesOf(m.frame()), 'the first frame stops before /import').not.toContain('import');
    for (let step = 0; step < 12; step += 1) await press(m.controller, { downArrow: true });
    expect(highlightedOf(m.frame())).toBe('import');
    await press(m.controller, { return: true });
    const snapshot = m.controller.getSnapshot();
    expect(snapshot.palette, 'the palette is closed').toBeUndefined();
    // No import port is wired in this Home, so the controller says so: the entry that ran was /import.
    expect(snapshot.notice).toBe('Import is unavailable in this session.');
    expect(m.startChat).not.toHaveBeenCalled();
    expect(m.frame().join('\n')).toContain('Import is unavailable in this session.');
  });

  it('Esc and Ctrl+C close a windowed palette and the prompt comes back, as they do for a whole one', async () => {
    for (const key of [{ escape: true }, { ctrl: true }]) {
      const m = mount({ cols: 80, rows: 24 }, 0, alternateScreen);
      await openPalette(m);
      expect(markersOf(m.frame()).length).toBeGreaterThan(0);
      m.controller.handleKey(key.ctrl === true ? 'c' : '', key);
      await settleFrames();
      expect(m.controller.getSnapshot().palette).toBeUndefined();
      expect(m.onExit).not.toHaveBeenCalled();
      expect(m.frame().join('\n')).toContain('/ for commands');
      expect(markersOf(m.frame())).toEqual([]);
      cleanup();
    }
  });

  it('typing narrows the window to what matches: a query that fits the rows is drawn whole', async () => {
    const m = mount({ cols: 80, rows: 24 }, 0, alternateScreen);
    await openPalette(m);
    for (const char of 'agent') m.controller.handleKey(char, {});
    await settleFrames();
    const frame = m.frame();
    expect(entriesOf(frame)).toEqual(['init', 'agents']);
    expect(markersOf(frame)).toEqual([]);
    expect(frame).toContain('/agent');
  });
});
