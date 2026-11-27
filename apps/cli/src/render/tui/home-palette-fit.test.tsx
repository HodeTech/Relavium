import './force-color.js';

import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HOME_PALETTE_COMMANDS } from '../../commands/repl-commands.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import { settleFrames } from './harness-util.js';
import { RootApp } from './home-app.js';
import { createHomeController, type HomeController } from './home-controller.js';
import { homeMargin, WORDMARK } from './home-layout.js';

/**
 * The `/` palette on the bare Home never makes the landing taller than the terminal ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §3, MVP-8 step 5). The palette had no row cap: with `/import` and `/pricing` among its fourteen entries it was 25 lines on an empty Home at
 * 80×24, a terminal of 24 rows, and a Home with a strip or a long `/doctor` report was taller still. It now draws a window of its entries in the
 * rows the landing leaves (`palette-window.ts`; the notice gives up rows to it), and a palette that fits is drawn whole, as before.
 *
 * **Round 1 of unit 7 (OB72) moved the palette BELOW the prompt row and pinned page 1** (the study's frame 11): the head, the prompt row and the
 * rows above it are what they are at rest, the query is typed on the prompt row, the rule is under it, and the list takes the rows beneath, at most
 * half the terminal as a chat's palette has (8 entries and a marker at 80×24, where 13 and a marker had fitted when the head gave its gap up). The
 * legend stands on the frame's last row in the full-screen renderer and directly under the list inline.
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
  failedRuns: [],
  recentSessions: Array.from({ length: sessions }, (_, index) => session(index)),
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions, runs: 0 },
  isEmpty: sessions === 0,
});

const FOOTER = '↑/↓ select · Enter run · Esc close';

function mount(size: { cols: number; rows: number }, sessions: number, alternateScreen: boolean) {
  const onExit = vi.fn();
  const startChat = vi.fn(() => new Promise<never>(() => {}));
  // What the Home says on its notification channel (ADR-0148 §6: a flow that cannot run says so there, never in a Home notice).
  const announced: string[] = [];
  // What the Home asked its popup host to open (`/help` is a popup of the Home: MVP-11 unit 8).
  const popups: string[] = [];
  const controller = createHomeController({
    announce: (text) => {
      announced.push(text);
    },
    openHomePopup: (request) => {
      popups.push(request.kind);
    },
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
  // The landing is left-hung at its margin (ADR-0146 §1), the palette with it, whatever there is to continue: it is ALWAYS the calm landing
  // (MVP-11 unit 7). The rows are read from their own first column, so the helpers below say what a row holds and not where the landing starts.
  const margin = homeMargin(size.cols);
  const frame = (): string[] =>
    plain(harness.lastFrame() ?? '')
      .split('\n')
      .map((row) => (row.startsWith(' '.repeat(margin)) ? row.slice(margin) : row));
  return { controller, harness, startChat, onExit, frame, announced, popups };
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

/** The rows under the thin rule that stands under the prompt row: the palette's list, the blank rows and the legend. */
const belowRule = (frame: readonly string[]): readonly string[] => {
  const rule = frame.findIndex((line) => /^-{20,}$/u.test(line));
  return rule < 0 ? frame : frame.slice(rule + 1);
};
/** The entries a frame names, by their slash words, in the order drawn (the prompt row above the rule is not one of them). */
const entriesOf = (frame: readonly string[]): string[] =>
  belowRule(frame).flatMap((line) => {
    const match = /^[> ] \/([a-z]+)(?: |$)/u.exec(line);
    return match?.[1] === undefined ? [] : [match[1]];
  });
const markersOf = (frame: readonly string[]): string[] =>
  frame.filter((line) => /^ {2}[\^v] \d+ more$/u.test(line));
const highlightedOf = (frame: readonly string[]): string | undefined =>
  belowRule(frame)
    .map((line) => /^> \/([a-z]+)(?: |$)/u.exec(line)?.[1])
    .find((name) => name !== undefined);
/** The row the prompt is on, 0-based: the one above the thin rule (the query is typed on it). */
const promptRowOf = (frame: readonly string[]): number =>
  frame.findIndex((line) => /^-{20,}$/u.test(line)) - 1;
/** The blank rows between the first entry and the last: the gaps between the groups (the palette's own, not the landing's, and not the rows that keep the legend at the bottom). */
const gapsOf = (frame: readonly string[]): number => {
  const body = belowRule(frame);
  const first = body.findIndex((line) => /^[> ] \/[a-z]+(?: |$)/u.test(line));
  const last = body.findLastIndex((line) => /^[> ] \/[a-z]+(?: |$)/u.test(line));
  return body.slice(first, last + 1).filter((line) => line.trim() === '').length;
};

/** The entries an arrow key can reach on a Home with no saved session: /resume and /clear are dim, so the arrows skip them. */
const REACHABLE = HOME_PALETTE_COMMANDS.map((command) => command.name).filter(
  (name) => name !== 'resume' && name !== 'clear',
);

describe.each([
  ['the inline renderer', false],
  ['the full-screen renderer', true],
] as const)('the palette on the landing in %s', (_name, alternateScreen) => {
  it('at 80×24 on an empty Home, with the landing, is a window of its entries and the landing is shorter than the terminal', async () => {
    const m = mount({ cols: 80, rows: 24 }, 0, alternateScreen);
    await openPalette(m);
    const frame = m.frame();
    expect(frame, 'the block is drawn').toContain(WORDMARK);
    expect(
      frame.some((row) => row.startsWith('Start as an agent') && row.includes('Ship the workflow')),
      'the block is drawn',
    ).toBe(true);
    expect(frame.length, 'a frame of the whole terminal makes Ink clear it').toBeLessThanOrEqual(
      23,
    );
    expect(frame.at(-1)).toBe(FOOTER);
    // The palette is half the terminal, as a chat's is (12 rows at 24): the prompt row, the rule, the legend and a window of nine lines, eight
    // entries and the marker. (OB72: 13 entries and `v 2 more` fitted when the full-screen head gave its gap up; page 1 now stays where it is.)
    expect(markersOf(frame)).toEqual(['  v 7 more']);
    expect(entriesOf(frame)).toEqual(
      HOME_PALETTE_COMMANDS.slice(0, 8).map((command) => command.name),
    );
    // `/` then `Enter` must never leave the application: the highlight is the first row that can act. /resume has nothing to resume, so it
    // is dim and says so in words, and the highlight is /run.
    // (the names are padded to the widest in view, `/permissions`, so the words start in one column: OB7-L8)
    expect(
      frame.some((row) => /^ {2}\/resume {2,}unavailable · nothing to resume/u.test(row)),
      'the dim row says why',
    ).toBe(true);
    expect(highlightedOf(frame)).toBe('run');
    expect(gapsOf(frame), 'no room for a gap: the entries are windowed').toBe(0);
  });

  // OB72, the study's frame 11 (`/mo` typed at 80×24): the prompt stays on row 11 of the full-screen Home with the head above it unmoved, the query is
  // typed on it, the thin rule is under it, the entries below and the legend on the last row.
  it('at 80×24 the query is typed on the prompt row, the rule is under it and the entries below it; page 1 has not moved', async () => {
    const m = mount({ cols: 80, rows: 24 }, 0, alternateScreen);
    await settleFrames();
    const closed = m.frame();
    await openPalette(m);
    for (const char of 'mo') m.controller.handleKey(char, {});
    await settleFrames();
    const frame = m.frame();
    const promptRow = promptRowOf(frame);
    expect(frame[promptRow]?.trimEnd()).toBe('> /mo');
    expect(frame[promptRow + 1], 'the rule is under the prompt row').toMatch(/^-{68}$/u);
    expect(entriesOf(frame)).toEqual(['models', 'mode', 'pricing']);
    expect(frame.at(-1)).toBe(FOOTER);
    // Everything above the prompt row is what the closed landing drew, row for row.
    const closedPrompt = closed.findIndex((row) => row.startsWith('> '));
    expect(promptRow).toBe(closedPrompt);
    expect(frame.slice(0, promptRow)).toEqual(closed.slice(0, closedPrompt));
    // The full-screen frame is the study's: the prompt on row 11 and the legend on row 23 (this one: the rows the closed frame had above it).
    if (alternateScreen) {
      expect(promptRow).toBe(10);
      expect(frame.length).toBe(23);
    }
  });

  // A Home with something to continue draws the same landing (MVP-11 unit 7): its strip is the work page's, so the palette has the same rows
  // as on the empty Home.
  it('at 80×24 with one saved session draws the same window as the empty Home: the session is the work page’s', async () => {
    const m = mount({ cols: 80, rows: 24 }, 1, alternateScreen);
    await openPalette(m);
    const frame = m.frame();
    expect(frame.length).toBeLessThanOrEqual(23);
    expect(frame, 'the session is not on the landing').not.toContain('Sessions');
    expect(entriesOf(frame)).toEqual(
      HOME_PALETTE_COMMANDS.slice(0, 8).map((command) => command.name),
    );
    expect(markersOf(frame), '/clear and /exit are behind the marker').toEqual(['  v 7 more']);
    expect(
      highlightedOf(frame),
      'there is something to resume, so /resume is the default row',
    ).toBe('resume');
    expect(frame.join('\n')).not.toContain('unavailable');
  });

  it('at 80×24 with a strip longer than the terminal, draws the landing and not the strip, and the palette keeps its rows', async () => {
    const m = mount({ cols: 80, rows: 24 }, 8, alternateScreen);
    const closed = m.frame().length;
    await openPalette(m);
    const frame = m.frame();
    expect(closed, 'the landing is the calm landing, not the strip').toBeLessThanOrEqual(16);
    expect(frame.length).toBeLessThanOrEqual(23);
    expect(entriesOf(frame)).toEqual(
      HOME_PALETTE_COMMANDS.slice(0, 8).map((command) => command.name),
    );
    expect(frame.some((line) => line.includes('Saved conversation 0'))).toBe(false);
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
      // The report leaves the palette its budget (half the terminal: its chrome and nine rows, eight entries and a marker), never the whole
      // of what the report could have taken.
      if (sessions === 0) expect(entriesOf(frame).length).toBe(8);
    },
  );

  // OB72 changed this test on purpose: at 80×30 the whole list (15 entries and three gaps, 21 rows) used to fit because the head gave up four of
  // its six top rows. Page 1 stays where it is, so the palette is the half terminal a chat's is (15 rows at 30: 12 lines, eleven entries and a marker).
  it('at 80×30 on an empty Home draws a window of eleven entries and the marker, no gap, and /exit is the farthest row', async () => {
    const m = mount({ cols: 80, rows: 30 }, 0, alternateScreen);
    await openPalette(m);
    const frame = m.frame();
    expect(frame.length).toBeLessThanOrEqual(29);
    expect(entriesOf(frame)).toEqual(
      HOME_PALETTE_COMMANDS.slice(0, 11).map((command) => command.name),
    );
    expect(markersOf(frame)).toEqual(['  v 4 more']);
    expect(frame.at(-1)).toBe(FOOTER);
    expect(gapsOf(frame), 'no room for a gap: the entries are windowed').toBe(0);
    // `/exit` is the farthest entry: reachable with ↓ (below) and by typing `/ex`.
    for (let step = 0; step < REACHABLE.length; step += 1)
      m.controller.handleKey('', { downArrow: true });
    await settleFrames();
    expect(highlightedOf(m.frame())).toBe('exit');
  });

  // All or none (MVP-11 Step 2 review, C9c): a list with one group set apart and the others run together says nothing about the groups. The three
  // blank rows are drawn when ALL of them fit and not at all otherwise, and a gap never costs an entry its row. The palette is half the terminal
  // (the budget of a chat's), so the fifteen entries, their three gaps and the chrome (21 rows) fit from 42 rows; at 40 and 41 the fifteen entries
  // are all drawn, with no gap. (Before OB72 the gaps fitted from 28 rows, with the head moved out of their way.)
  it.each([
    [40, 0],
    [41, 0],
    [42, 3],
    [43, 3],
  ])(
    'at 80×%i the gaps are all or nothing, never an entry: %i of the three blank rows are drawn (the palette is asked for 21 rows, gaps first to go)',
    async (rows, gaps) => {
      const m = mount({ cols: 80, rows }, 0, alternateScreen);
      await openPalette(m);
      const frame = m.frame();
      expect(frame.length).toBeLessThanOrEqual(rows - 1);
      expect(gapsOf(frame)).toBe(gaps);
      expect(entriesOf(frame)).toEqual(HOME_PALETTE_COMMANDS.map((command) => command.name));
      expect(markersOf(frame)).toEqual([]);
      expect(entriesOf(frame).at(-1), 'a gap never costs /exit its row').toBe('exit');
    },
  );

  // OB72 replaced `the full-screen Home gives up only the top gap the palette needs` (it moved the wordmark 3 → 0 at 24 rows and 6 → 2 at 30): page 1
  // never changes. Every row above the prompt row, the top gap included, is what the closed landing drew, at every size the Home supports.
  it.each([24, 25, 28, 30, 36, 40, 50])(
    'at 80×%i opening the palette moves nothing above the prompt row: the wordmark and the prompt keep their rows',
    async (rows) => {
      const m = mount({ cols: 80, rows }, 0, alternateScreen);
      await settleFrames();
      const closed = m.frame();
      const closedPrompt = closed.findIndex((row) => row.startsWith('> '));
      await openPalette(m);
      const open = m.frame();
      expect(promptRowOf(open)).toBe(closedPrompt);
      expect(open.findIndex((row) => row === WORDMARK)).toBe(
        closed.findIndex((row) => row === WORDMARK),
      );
      expect(open.slice(0, closedPrompt)).toEqual(closed.slice(0, closedPrompt));
      expect(open.length).toBeLessThanOrEqual(rows - 1);
    },
  );

  it('at 100×30 and 120×40 the palette keeps page 1 too, and the wordmark stays where the frames put it', async () => {
    for (const [cols, rows, wordmarkRow] of [
      [100, 30, alternateScreen ? 6 : 0],
      [120, 40, alternateScreen ? 11 : 0],
    ] as const) {
      const m = mount({ cols, rows }, 0, alternateScreen);
      await settleFrames();
      const closed = m.frame();
      await openPalette(m);
      const open = m.frame();
      expect(
        open.findIndex((row) => row === WORDMARK),
        `${String(cols)}×${String(rows)}`,
      ).toBe(wordmarkRow);
      expect(open.slice(0, promptRowOf(open))).toEqual(
        closed.slice(
          0,
          closed.findIndex((row) => row.startsWith('> ')),
        ),
      );
      expect(open.length).toBeLessThanOrEqual(rows - 1);
      cleanup();
    }
  });

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
    expect(markersOf(end).map((line) => line.trim().slice(0, 1))).toEqual(['^']);
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
    // A report on the landing takes rows the palette would have had: the window is the first eight entries and /help is behind the marker.
    m.controller.setProviderState(
      false,
      Array.from({ length: 40 }, (_, index) => `doctor line ${String(index)}`).join('\n'),
    );
    await settleFrames();
    expect(entriesOf(m.frame()), 'the first frame stops before /help').not.toContain('help');
    for (let step = 0; step < REACHABLE.indexOf('help'); step += 1)
      await press(m.controller, { downArrow: true });
    expect(highlightedOf(m.frame())).toBe('help');
    await press(m.controller, { return: true });
    const snapshot = m.controller.getSnapshot();
    expect(snapshot.palette, 'the palette is closed').toBeUndefined();
    // The entry that ran was /help: the Home asked for its help popup, and opened no screen.
    expect(m.popups).toEqual(['help']);
    expect(snapshot.screen).toBeUndefined();
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
      expect(m.announced.at(-1)).toMatch(
        sessions === 0 ? /^Running a workflow is unavailable/u : /^Session resume is unavailable/u,
      );
      expect(m.controller.getSnapshot().notice).toBeUndefined();
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
      expect(m.frame().join('\n')).toContain('[/] commands');
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
    expect(frame[promptRowOf(frame)]?.trimEnd(), 'the query is typed on the prompt row').toBe(
      '> /agent',
    );
  });
});
