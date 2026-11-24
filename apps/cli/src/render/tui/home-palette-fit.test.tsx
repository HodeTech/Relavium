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
/** The blank rows between the query line and the legend: the gaps between the groups (the palette's own, not the landing's). */
const gapsOf = (frame: readonly string[]): number => {
  const from = frame.findIndex((line) => line === '/');
  const to = frame.indexOf(FOOTER);
  return frame.slice(from + 1, to).filter((line) => line.trim() === '').length;
};

/** The entries an arrow key can reach on a Home with no saved session: /resume and /clear are dim, so the arrows skip them. */
const REACHABLE = HOME_PALETTE_COMMANDS.map((command) => command.name).filter(
  (name) => name !== 'resume' && name !== 'clear',
);

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
    expect(markersOf(frame)).toEqual(['  ▼ 4 more']);
    expect(entriesOf(frame)).toEqual(
      HOME_PALETTE_COMMANDS.slice(0, 11).map((command) => command.name),
    );
    // `/` then `Enter` must never leave the application: the highlight is the first row that can act. /resume has nothing to resume, so it
    // is dim and says so in words, and the highlight is /run.
    expect(frame, 'the dim row says why').toContain('  /resume  unavailable · nothing to resume');
    expect(highlightedOf(frame)).toBe('run');
    expect(gapsOf(frame), 'no room for a gap: the entries are windowed').toBe(0);
  });

  it('at 80×24 with one saved session is a window of its entries too: with /help among them the fifteen no longer fit beside the session', async () => {
    const m = mount({ cols: 80, rows: 24 }, 1, alternateScreen);
    await openPalette(m);
    const frame = m.frame();
    expect(frame.length).toBeLessThanOrEqual(23);
    expect(frame, 'the session is still on the landing').toContain('  Sessions');
    expect(entriesOf(frame)).toEqual(
      HOME_PALETTE_COMMANDS.slice(0, 13).map((command) => command.name),
    );
    expect(markersOf(frame), '/clear and /exit are behind the marker').toEqual(['  ▼ 2 more']);
    expect(
      highlightedOf(frame),
      'there is something to resume, so /resume is the default row',
    ).toBe('resume');
    expect(frame.join('\n')).not.toContain('unavailable');
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
      expect(highlightedOf(frame)).toBe(sessions === 0 ? 'run' : 'resume');
      expect(markersOf(frame).length).toBeGreaterThan(0);
    },
  );

  it('at 80×30 on an empty Home draws every entry and the three blank rows between the groups, with no marker', async () => {
    const m = mount({ cols: 80, rows: 30 }, 0, alternateScreen);
    await openPalette(m);
    const frame = m.frame();
    expect(frame.length).toBeLessThanOrEqual(29);
    expect(entriesOf(frame)).toEqual(HOME_PALETTE_COMMANDS.map((command) => command.name));
    expect(markersOf(frame)).toEqual([]);
    expect(frame.at(-1)).toBe(FOOTER);
    expect(gapsOf(frame), 'Work · Set up · Check · End: three gaps').toBe(3);
    // The gaps sit before /providers, /doctor and /clear, the first row of each group after the first.
    for (const name of ['providers', 'doctor', 'clear']) {
      const at = frame.findIndex((line) => new RegExp(`^[› ] /${name}( |$)`, 'u').test(line));
      expect(frame[at - 1]?.trim(), `a blank row before /${name}`).toBe('');
    }
  });

  it.each([
    [26, 0],
    [27, 0],
    [28, 1],
    [29, 2],
    [30, 3],
  ])(
    'at 80×%i the gaps give way one by one, never an entry: %i of the three blank rows are drawn (the palette is asked for 21 rows, gaps first to go)',
    async (rows, gaps) => {
      const m = mount({ cols: 80, rows }, 0, alternateScreen);
      await openPalette(m);
      const frame = m.frame();
      expect(frame.length).toBeLessThanOrEqual(rows - 1);
      expect(gapsOf(frame)).toBe(gaps);
      // 80×26 cannot hold the fifteen entries even with no gap: it windows them (and never draws a gap in a window).
      if (rows === 26) {
        expect(entriesOf(frame).length).toBeLessThan(HOME_PALETTE_COMMANDS.length);
        expect(markersOf(frame)).toHaveLength(1);
      } else {
        expect(entriesOf(frame)).toEqual(HOME_PALETTE_COMMANDS.map((command) => command.name));
        expect(markersOf(frame)).toEqual([]);
        expect(entriesOf(frame).at(-1), 'a gap never costs /exit its row').toBe('exit');
      }
    },
  );

  it('keeps the highlighted entry in the window: ↓ sixteen times from the first row that can act, then ↑ sixteen times; the arrows skip the dim rows and stop at both ends', async () => {
    const m = mount({ cols: 80, rows: 24 }, 0, alternateScreen);
    await openPalette(m);
    expect(highlightedOf(m.frame())).toBe('run');
    const last = REACHABLE.length - 1;
    for (let step = 1; step <= 16; step += 1) {
      await press(m.controller, { downArrow: true });
      const frame = m.frame();
      expect(highlightedOf(frame), `↓ ${String(step)}`).toBe(REACHABLE[Math.min(step, last)]);
      expect(frame.length, `↓ ${String(step)}`).toBeLessThanOrEqual(23);
      expect(frame.at(-1)).toBe(FOOTER);
    }
    // At the end of the list the window shows /exit, the last entry, and says what it hides above, and nothing below. /clear above it
    // is dim, and the highlight went over it.
    const end = m.frame();
    expect(highlightedOf(end)).toBe('exit');
    expect(entriesOf(end).at(-1)).toBe('exit');
    expect(markersOf(end).map((line) => line.trim().slice(0, 1))).toEqual(['▲']);
    for (let step = 1; step <= 16; step += 1) {
      await press(m.controller, { upArrow: true });
      const frame = m.frame();
      expect(highlightedOf(frame), `↑ ${String(step)}`).toBe(REACHABLE[Math.max(0, last - step)]);
      expect(frame.length, `↑ ${String(step)}`).toBeLessThanOrEqual(23);
    }
    // Back at the top: /run, and never /resume, which is dim and above it; the window shows the head of the list again.
    expect(highlightedOf(m.frame())).toBe('run');
    expect(entriesOf(m.frame())[0]).toBe('resume');
  });

  it('Enter runs the highlighted entry of a window, which is one the first frame did not show', async () => {
    const m = mount({ cols: 80, rows: 24 }, 0, alternateScreen);
    await openPalette(m);
    expect(entriesOf(m.frame()), 'the first frame stops before /help').not.toContain('help');
    for (let step = 0; step < REACHABLE.indexOf('help'); step += 1)
      await press(m.controller, { downArrow: true });
    expect(highlightedOf(m.frame())).toBe('help');
    await press(m.controller, { return: true });
    const snapshot = m.controller.getSnapshot();
    expect(snapshot.palette, 'the palette is closed').toBeUndefined();
    // The entry that ran was /help: the Home's help screen is open.
    expect(snapshot.screen?.kind).toBe('help');
    expect(m.startChat).not.toHaveBeenCalled();
    expect(m.onExit).not.toHaveBeenCalled();
  });

  it('`/` then `Enter` never leaves the application: on a Home with no saved session it runs /run, and with one it runs /resume', async () => {
    for (const sessions of [0, 1]) {
      const m = mount({ cols: 80, rows: 24 }, sessions, alternateScreen);
      await openPalette(m);
      await press(m.controller, { return: true });
      expect(m.onExit, `${String(sessions)} sessions`).not.toHaveBeenCalled();
      expect(m.controller.getSnapshot().palette).toBeUndefined();
      // No launch or resume port is wired in this Home, so the controller says so: the entry that ran was /run, or /resume.
      expect(m.controller.getSnapshot().notice).toMatch(
        sessions === 0 ? /^Running a workflow is unavailable/u : /^Session resume is unavailable/u,
      );
      cleanup();
    }
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
    // `/agents` starts with the query and leads; `/init` matches only by its description (it names "agent directories") and follows.
    expect(entriesOf(frame)).toEqual(['agents', 'init']);
    expect(markersOf(frame)).toEqual([]);
    expect(frame).toContain('/agent');
  });
});
