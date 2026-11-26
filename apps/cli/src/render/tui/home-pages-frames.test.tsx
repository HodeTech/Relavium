/**
 * The Home's two pages as drawn (MVP-11 unit 7; the study's frames 01–21 at 80×24 and 100×30): page 1 is the calm landing whatever there is to
 * continue, with the indicator in its hint; page 2 is the work page, `↑ start page`, the strip's sections and the docked prompt block in its last
 * five rows; in the alternate screen the slide between them is a window onto the two pages stacked, never taller than `rows − 1`. Mounted, the
 * slide's frames come from the controller's scheduler and the keys typed during it wait for its arrival; the exit guard takes the place of the
 * docked block and its `Ctrl+Y` counts only for a measured frame of the work page.
 */
import { vi } from 'vitest';

// Ink draws colour only when the terminal supports it, and the test runs on none: the level is forced before ink is first loaded.
vi.hoisted(() => {
  process.env['FORCE_COLOR'] = '1';
});

import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import type { HomeStatusFacts } from '../../home/home-status-facts.js';
import type { HomeRunRow, HomeSessionRow, HomeSnapshot } from '../../home/home-store.js';
import type { RunHostSnapshot } from '../../home/run-host.js';
import type { ParkedRunRow } from './home-attention.js';
import { RootApp } from './home-app.js';
import { createHomeController, type HomeChatSession } from './home-controller.js';
import { slideFrames, SLIDE_FRAME_MS } from './home-pages.js';
import { HomeView } from './home-view.js';
import { settleFrames, waitFor } from './harness-util.js';
import { openPalette, type OpenPalette } from './palette-reducer.js';
import { buildPaletteEntries } from './palette-entries.js';
import { focusAt, stripRows, type StripFocus } from './strip-focus.js';

afterEach(cleanup);

const SGR = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'gu');
const plain = (frame: string): string[] => frame.replace(SGR, '').split('\n');
const trimmed = (rows: readonly string[]): string[] => rows.map((row) => row.trimEnd());

const runRow = (id: string, status: HomeRunRow['status']): HomeRunRow => ({
  runId: id,
  workflowSlug: `wf-${id}`,
  status,
  createdAt: '2026-11-23T00:00:00.000Z',
  startedAt: undefined,
  completedAt: '2026-11-23T00:00:00.000Z',
  totalCostMicrocents: 0,
});
const sessionRow = (n: number): HomeSessionRow => ({
  sessionId: `session-${String(n)}`,
  workingDir: `/work/${String(n)}`,
  title: `Conversation ${String(n)}`,
  agentSlug: 'chat',
  modelId: undefined,
  status: 'ended',
  updatedAt: '2026-11-23T00:00:00.000Z',
  totalCostMicrocents: 0,
});
/** The study's H3 state: a gate to answer (a parked run) and a failed run under Attention, two sessions, two runs. */
const PARKED: readonly ParkedRunRow[] = [{ runId: 'run-gate', kind: 'approval', gates: 1 }];
const BUSY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [runRow('run-failed', 'failed')] },
  recentSessions: [sessionRow(1), sessionRow(2)],
  recentRuns: [runRow('run-a', 'completed'), runRow('run-b', 'completed')],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: false,
};
const EMPTY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: true,
};
const SESSIONS_ONLY: HomeSnapshot = {
  ...EMPTY,
  recentSessions: [sessionRow(1), sessionRow(2)],
  isEmpty: false,
};
const STATUS: HomeStatusFacts = {
  provider: 'anthropic',
  model: 'claude-haiku-5-5',
  mode: 'ask',
  directory: '~/acme-web',
};
const H3_HINT = '[/] commands · ↓ 2 need you · 2 sessions · 2 runs · [Ctrl+C] exit (twice)';

interface Draw {
  readonly snapshot?: HomeSnapshot;
  readonly parked?: readonly ParkedRunRow[];
  readonly page?: 'start' | 'work' | undefined;
  readonly focus?: StripFocus | undefined;
  readonly text?: string;
  readonly cols?: number;
  readonly rows?: number;
  readonly color?: boolean;
  readonly alternateScreen?: boolean;
  readonly slideOffset?: number;
  readonly keyless?: boolean;
  readonly palette?: OpenPalette;
  readonly exitGuard?: 'confirm';
  readonly hostedRun?: RunHostSnapshot;
}

function frameOf(over: Draw): string {
  const text = over.text ?? '';
  const view = render(
    <HomeView
      snapshot={over.snapshot ?? BUSY}
      parkedRuns={over.parked ?? PARKED}
      editor={{ text, cursor: text.length }}
      nowMs={Date.parse('2026-11-23T01:00:00.000Z')}
      cols={over.cols ?? 80}
      rows={over.rows ?? 24}
      color={over.color ?? false}
      alternateScreen={over.alternateScreen ?? true}
      status={STATUS}
      page={over.page}
      stripFocus={over.focus}
      slideOffset={over.slideOffset}
      keyless={over.keyless === true}
      paletteOpen={over.palette !== undefined}
      {...(over.palette === undefined ? {} : { palette: over.palette })}
      exitGuard={over.exitGuard}
      hostedRun={over.hostedRun}
    />,
  );
  const frame = view.lastFrame() ?? '';
  view.unmount();
  return frame;
}
const rowsOf = (over: Draw): string[] => trimmed(plain(frameOf(over)));
const FIRST_ROW = focusAt(stripRows(PARKED, BUSY), 0);

describe.each([
  [80, 24, 6],
  [100, 30, 8],
] as const)('at %i×%i (margin %i)', (cols, rows, margin) => {
  const pad = ' '.repeat(margin);

  it('page 1 is the calm landing whatever there is to continue: the empty Home’s rows, and the indicator in its hint', () => {
    const busy = rowsOf({ cols, rows });
    const empty = rowsOf({ cols, rows, snapshot: EMPTY, parked: [] });
    const hintAt = busy.findIndex((row) => row.includes('[Ctrl+C] exit (twice)'));
    expect(hintAt).toBeGreaterThan(0);
    expect(busy.slice(0, hintAt), 'every row above the hint is the empty Home’s').toEqual(
      empty.slice(0, hintAt),
    );
    expect(busy[hintAt]).toBe(`${pad}${H3_HINT}`);
    expect(busy.join('\n')).not.toContain('Attention required');
    expect(busy.length).toBeLessThanOrEqual(rows - 1);
  });

  it('page 2 is the work page: the way back, a blank row, the sections, and the docked prompt block in the last five rows', () => {
    const page = rowsOf({ cols, rows, page: 'work', focus: FIRST_ROW });
    expect(page, 'exactly rows − 1 rows').toHaveLength(rows - 1);
    expect(page[0]).toBe(`${pad}↑ start page`);
    expect(page[1]).toBe('');
    expect(page[2]).toBe(`${pad}Attention required`);
    expect(page[3]?.startsWith(`${pad}  > || run-gate`), page[3]).toBe(true);
    const block = page.slice(-5);
    expect(block[0], 'the blank lead row').toBe('');
    expect(block[1]).toBe(`${pad}> type a message, or / for commands`);
    expect(block[2]).toBe(`${pad}${'-'.repeat(cols - 2 * margin)}`);
    expect(block[3]).toBe(`${pad}next chat: anthropic · claude-haiku-5-5 · ask mode   ~/acme-web`);
    expect(block[4]).toBe(`${pad}↑/↓ select · Enter open the gate · type to chat · Esc start page`);
  });

  it('page 2 with the docked prompt focused: no row marked, the draft in the prompt and its own hint (frame 08)', () => {
    const page = rowsOf({ cols, rows, page: 'work', text: 'fix the flaky test' });
    expect(
      page.some((row) => /^ *> (\||x |wf-|Conv)/u.test(row)),
      'no row marked',
    ).toBe(false);
    expect(page.at(-4)?.startsWith(`${pad}> fix the flaky test`)).toBe(true);
    // at 100 columns there is room for `[Ctrl+J] newline` too, before the way back
    expect(page.at(-1)).toBe(
      cols === 80
        ? `${pad}Enter start the chat · ↑ back to the list · Esc start page`
        : `${pad}Enter start the chat · ↑ back to the list · [Ctrl+J] newline · Esc start page`,
    );
  });

  it('the inline renderer draws the same work page: it does not slide, and an offset is ignored', () => {
    const inline = rowsOf({ cols, rows, page: 'work', focus: FIRST_ROW, alternateScreen: false });
    expect(inline).toEqual(rowsOf({ cols, rows, page: 'work', focus: FIRST_ROW }));
    expect(
      rowsOf({
        cols,
        rows,
        page: 'work',
        focus: FIRST_ROW,
        alternateScreen: false,
        slideOffset: 6,
      }),
    ).toEqual(inline);
  });

  it.each(['work', 'start'] as const)(
    'every frame of the slide to the %s page is the window of rows − 1 onto the two pages stacked',
    (to) => {
      // The document: the landing, as tall as a page, then the work page, each as it is drawn at rest (the cursor cell is styling only).
      const landingPage = rowsOf({ cols, rows, page: 'start' });
      const work = rowsOf({
        cols,
        rows,
        page: 'work',
        focus: to === 'work' ? FIRST_ROW : undefined,
      });
      const doc = [
        ...landingPage,
        ...Array<string>(rows - 1 - landingPage.length).fill(''),
        ...work,
      ];
      for (const offset of slideFrames(rows, to)) {
        const frame = rowsOf({
          cols,
          rows,
          page: to,
          focus: to === 'work' ? FIRST_ROW : undefined,
          slideOffset: offset,
        });
        expect(frame.length, `offset ${String(offset)}`).toBeLessThanOrEqual(rows - 1);
        const window = doc.slice(offset, offset + rows - 1);
        while (window.at(-1) === '') window.pop();
        while (frame.at(-1) === '') frame.pop();
        expect(frame, `offset ${String(offset)}`).toEqual(window);
      }
    },
  );
});

describe('the indicator and its colour', () => {
  it('draws the attention count in the warning colour and the rest of the hint dim; without colour the words are the same and no colour is drawn', () => {
    const coloured = frameOf({ color: true });
    const row = coloured.split('\n').find((line) => line.includes('need you')) ?? '';
    expect(row).toContain('\u001b[33m↓ 2 need you');
    expect(row).toContain('\u001b[2m[/] commands · ');
    const bare = frameOf({ color: false });
    // eslint-disable-next-line no-control-regex -- the assertion is that no colour code is drawn
    expect(bare).not.toMatch(/\u001b\[(?:3[0-7]|9[0-7])m/u);
    expect(plain(bare).some((line) => line.trim() === H3_HINT)).toBe(true);
  });

  it('counts exactly the Attention rows of the work page: `1 needs you` for one', () => {
    const one = rowsOf({ parked: [] });
    expect(one.some((row) => row.includes('↓ 1 needs you · 2 sessions · 2 runs'))).toBe(true);
    const work = rowsOf({ parked: [], page: 'work' });
    const heading = work.indexOf('      Attention required');
    const end = work.findIndex((row, at) => at > heading && row.trim() === '');
    expect(heading).toBeGreaterThan(0);
    expect(work.slice(heading + 1, end)).toHaveLength(1);
  });

  it('is not drawn with nothing to continue: no `↓` at all (frame 05)', () => {
    const empty = rowsOf({ snapshot: EMPTY, parked: [] });
    expect(empty.join('\n')).not.toContain('↓');
  });
});

describe('a notice on the work page', () => {
  it('takes what the list leaves under the way back once the rows the focus reaches are kept: at 80×24 seven of them, its footer included', () => {
    const notice = Array.from({ length: 60 }, (_, n) => `line ${String(n)}`).join('\n');
    const view = render(
      <HomeView
        page="work"
        snapshot={BUSY}
        parkedRuns={PARKED}
        editor={{ text: '', cursor: 0 }}
        nowMs={0}
        cols={80}
        rows={24}
        color={false}
        alternateScreen
        status={STATUS}
        notice={notice}
      />,
    );
    const page = trimmed(plain(view.lastFrame() ?? ''));
    view.unmount();
    expect(page).toHaveLength(23);
    // 16 rows of list less the notice's blank row less what the focus must reach (the Attention section's three, a session's four): 8 rows
    const noticeRows = page.filter((row) => /^ {6}line \d+$/u.test(row) || row.includes('PgUp/PgDn'));
    expect(noticeRows).toHaveLength(8);
    expect(noticeRows.at(-1)).toContain('Notice 1–7 of 60');
    expect(page.at(-4)?.trim(), 'the docked prompt is still there').toBe('> type a message, or / for commands');
  }); // prettier-ignore
});

describe('the work page’s other bottom blocks', () => {
  it('the exit guard takes the place of the docked prompt block, and the page keeps to rows − 1', () => {
    const running: RunHostSnapshot = {
      launching: false,
      active: { leg: 'start', runId: 'run-0001', cancelling: false },
      last: undefined,
    };
    const page = rowsOf({ page: 'work', exitGuard: 'confirm', hostedRun: running });
    expect(page).toHaveLength(23);
    expect(page.join('\n')).not.toContain('type a message, or / for commands');
    expect(page.at(-1)?.trim()).toBe(
      '[Ctrl+Y] stop the run and leave · Esc / [Ctrl+C] / [Ctrl+N] stay',
    );
    expect(page.some((row) => row.includes('A workflow run is executing: run-0001.'))).toBe(true);
  });

  it('the palette runs UP from the docked prompt: the list above it, the first entry beside it, the query on the prompt row, the legend last', () => {
    const palette = openPalette(
      buildPaletteEntries('home', {
        hasSession: false,
        hasKey: true,
        hasSavedSessions: true,
        turnRunning: false,
      }),
      'up',
    );
    const page = rowsOf({ page: 'work', palette });
    expect(page).toHaveLength(23);
    expect(page.at(-1)?.trim()).toBe('↑/↓ select · Enter run · Esc close');
    expect(page.at(-2)?.trim()).toMatch(/^-+$/u);
    expect(page.at(-3)?.trim()).toBe('> /');
    expect(page.at(-4)?.trim().startsWith('> /resume'), 'the first entry, highlighted, beside the prompt').toBe(true);
    expect(page[0]?.trim(), 'the way back stays').toBe('↑ start page');
  }); // prettier-ignore

  it('with no key the status row is the call to connect, and it promises only the command word while a row has `Enter`', () => {
    expect(rowsOf({ page: 'work', keyless: true }).at(-2)?.trim()).toBe(
      'No provider key yet · Enter connect · /providers',
    );
    expect(rowsOf({ page: 'work', keyless: true, focus: FIRST_ROW }).at(-2)?.trim()).toBe(
      'No provider key yet · /providers connects one',
    );
  });
});

// ---- Mounted: the slide's frames, the keys during it, and the exit guard on the work page -----------------------------------------

function mounted(
  options: {
    readonly hosted?: RunHostSnapshot;
    readonly resumeChat?: (id?: string) => Promise<undefined>;
    readonly snapshot?: HomeSnapshot;
  } = {},
) {
  const timers: { at: number; run: () => void }[] = [];
  let now = 0;
  const controller = createHomeController({
    startChat: () => new Promise<HomeChatSession>(() => {}),
    homeStore: { read: () => options.snapshot ?? BUSY },
    ...(options.resumeChat === undefined ? {} : { resumeChat: options.resumeChat }),
    hostedRuns: {
      snapshot: () => options.hosted ?? { launching: false, active: undefined, last: undefined },
      cancel: () => true,
      close: () => Promise.resolve(),
    },
    schedule: (run, delayMs) => {
      const timer = { at: now + delayMs, run };
      timers.push(timer);
      return () => {
        const at = timers.indexOf(timer);
        if (at >= 0) timers.splice(at, 1);
      };
    },
    slideTransitions: true,
    onExit: () => {},
    onError: (cause) => {
      throw cause;
    },
  });
  const harness = render(
    <RootApp
      controller={controller}
      nowMs={() => 0}
      color={false}
      alternateScreen
      getSize={() => ({ cols: 80, rows: 24 })}
      subscribeResize={() => () => {}}
    />,
  );
  /** Fire the next timer of the slide (its frames are the only timers here). */
  const step = (): void => {
    timers.sort((a, b) => a.at - b.at);
    const next = timers.shift();
    if (next === undefined) throw new Error('no frame of the slide is scheduled');
    now = next.at;
    next.run();
  };
  /**
   * The three frames between and the arrival, and nothing else: the bound on the wait for the arrival's frame is a timer too, and firing it
   * would apply the waiting keys without the host's evidence.
   */
  const arrive = (): void => {
    for (let frame = 0; frame < 3; frame += 1) step();
  };
  return { controller, harness, step, arrive, pending: () => timers.length };
}

describe('mounted in the alternate screen', () => {
  it('slides: each frame has the work page’s first row where the offset puts it, and never more than 23 rows', async () => {
    const m = mounted();
    await settleFrames();
    m.harness.stdin.write('\u001b[B');
    await waitFor(() => m.controller.getSnapshot().slide !== undefined);
    for (const offset of slideFrames(24, 'work')) {
      await settleFrames();
      const frame = trimmed(plain(m.harness.lastFrame() ?? ''));
      expect(frame.length).toBeLessThanOrEqual(23);
      expect(frame.indexOf('      ↑ start page'), `offset ${String(offset)}`).toBe(23 - offset);
      if (m.pending() > 0) m.step();
    }
    expect(m.controller.getSnapshot().slide).toBeUndefined();
  });

  it('keys typed while it slides are applied in order once the arrival is on screen', async () => {
    const m = mounted();
    await settleFrames();
    m.harness.stdin.write('\u001b[B');
    await waitFor(() => m.controller.getSnapshot().slide !== undefined);
    m.harness.stdin.write('h');
    m.harness.stdin.write('i');
    await settleFrames();
    expect(m.controller.getSnapshot().input.text, 'nothing yet: it slides').toBe('');
    m.arrive();
    await waitFor(() => m.controller.getSnapshot().input.text === 'hi');
    expect(m.controller.getSnapshot().stripFocus, 'the first key moved to the docked prompt').toBeUndefined();
    expect(m.harness.lastFrame()).toContain('> hi');
  }); // prettier-ignore

  it('an `Enter` typed while it slides is dropped: no row opens, even once the arrival is on screen (it was pressed before the row was seen)', async () => {
    const resumeChat = vi.fn(() => new Promise<undefined>(() => {}));
    const m = mounted({ resumeChat, snapshot: SESSIONS_ONLY });
    await settleFrames();
    m.harness.stdin.write('\u001b[B');
    await waitFor(() => m.controller.getSnapshot().slide !== undefined);
    m.harness.stdin.write('\r'); // `Enter` on the row the slide arrives at, the first session
    await settleFrames();
    expect(resumeChat, 'nothing is opened while it slides').not.toHaveBeenCalled();
    m.arrive();
    await waitFor(() => (m.harness.lastFrame() ?? '').includes('Enter resume'));
    await settleFrames();
    expect(m.controller.getSnapshot().stripFocus?.id, 'the row is focused, unopened').toBe(
      'session-1',
    );
    expect(resumeChat).not.toHaveBeenCalled();
    m.harness.stdin.write('\r'); // the same key on the row at rest, which the person has now seen
    await waitFor(() => resumeChat.mock.calls.length > 0);
    expect(resumeChat).toHaveBeenCalledWith('session-1');
  });

  it('a `↓` and an `Enter` that waited together: the `Enter` would open a row no frame has shown, so it is dropped, as the host drops a live one', async () => {
    const resumeChat = vi.fn(() => new Promise<undefined>(() => {}));
    const m = mounted({ resumeChat, snapshot: SESSIONS_ONLY });
    await settleFrames();
    m.harness.stdin.write('\u001b[B');
    await waitFor(() => m.controller.getSnapshot().slide !== undefined);
    m.harness.stdin.write('\u001b[B');
    m.harness.stdin.write('\r');
    m.arrive();
    await waitFor(() => m.controller.getSnapshot().stripFocus?.id === 'session-2');
    await settleFrames();
    expect(resumeChat).not.toHaveBeenCalled();
  });

  it('the exit guard on the work page takes the docked block’s place, and its `Ctrl+Y` counts for the measured frame of the page', async () => {
    const hosted: RunHostSnapshot = {
      launching: false,
      active: { leg: 'start', runId: 'run-0001', cancelling: false },
      last: undefined,
    };
    const m = mounted({ hosted });
    await settleFrames();
    m.harness.stdin.write('\u001b[B');
    await waitFor(() => m.controller.getSnapshot().slide !== undefined);
    m.arrive();
    await settleFrames();
    m.harness.stdin.write('\u001b[B\u001b[B\u001b[B\u001b[B\u001b[B'); // past the last row, onto the docked prompt
    await waitFor(() => m.controller.getSnapshot().stripFocus === undefined);
    m.harness.stdin.write('\u0004'); // Ctrl+D on the empty docked prompt
    await waitFor(() => m.controller.getSnapshot().exitGuard === 'confirm');
    await waitFor(() => (m.harness.lastFrame() ?? '').includes('[Ctrl+Y] stop the run and leave'));
    const frame = trimmed(plain(m.harness.lastFrame() ?? ''));
    expect(frame[0]?.trim(), 'the work page is still in front').toBe('↑ start page');
    expect(frame.join('\n')).not.toContain('type a message, or / for commands');
    expect(frame.length).toBeLessThanOrEqual(23);
    await settleFrames(); // the card's exact frame is measured and flushed: only then does Ctrl+Y count
    m.harness.stdin.write('\u0019');
    await waitFor(() => (m.harness.lastFrame() ?? '').includes('Stopping the run…'));
    expect(m.controller.getSnapshot().exitGuard).toBe('stopping');
  });
});

it('keeps SLIDE_FRAME_MS a whole frame: three between at 40 ms each are the ≈120 ms of the study', () => {
  expect(SLIDE_FRAME_MS * 3).toBe(120);
});
