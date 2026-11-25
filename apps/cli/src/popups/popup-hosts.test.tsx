// Chalk's level is read once, when it is first imported: the matrix's own first import (see `force-color.ts`).
import '../render/tui/force-color.js';

/**
 * The popup in the three hosts of the product ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2, §4): the Home (`RootApp`), the stand-alone chat (`ChatApp`) and the chat the Home hosts (`ChatRegion` under `RootApp`), each in both
 * placements (the overlay in the alternate screen, the block that replaces the body inline). What it pins: the body stays drawn behind an
 * overlay and is replaced by a block; the drawn frame IS the popup's own rows (the occlusion check); `Esc` leaves exactly the frame it found;
 * the notification lands on the hint row and nowhere else; a popup that throws closes and the host stays; the opening guard holds a bare
 * `Enter` chain; and a framed native prompt (the channel's popup descriptor) is drawn and answered in both placements.
 */
import { describe, expect, it, vi } from 'vitest';

import { withGlyphForm } from '../render/tui/glyphs.js';
import {
  mountHostedChat,
  mountStandaloneChat,
  type ChatMount,
} from '../render/tui/surface-matrix/chat-host.js';
import { KEYS, mountHome, type HomeMount } from '../render/tui/surface-matrix/home-host.js';
import {
  popupBoxOf,
  TEST_POPUP_TITLE,
  testReportPopup,
} from '../render/tui/surface-matrix/popup-fixture.js';
import { reportsPortFor } from '../render/tui/surface-matrix/report-fixture.js';
import type { Variant } from '../render/tui/surface-matrix/variants.js';
import { naturalBodyRows, popupBody, popupFrameLines, reportPageRows } from './frame-model.js';
import {
  INLINE_LIST_MAX_ROWS,
  popupGeometry,
  popupInnerWidth,
  type PopupBoxGeometry,
} from './geometry.js';
import { createPopupHost, type PopupHost } from './popup-host.js';
import { currentStep, openFrame, popupLegend, type PopupSpec } from './popup-reducer.js';

type Host = 'home' | 'standalone-chat' | 'chat';
type Mounted = HomeMount | ChatMount;

const HOSTS: readonly Host[] = ['home', 'standalone-chat', 'chat'];
const RENDERERS = ['alt', 'inline'] as const;
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function mountIn(
  host: Host,
  variant: Variant,
  setup: Parameters<typeof mountHome>[1] = {},
): Promise<Mounted> {
  if (host === 'home') {
    const mounted = mountHome(variant, setup);
    await mounted.settle();
    return mounted;
  }
  const mounted =
    host === 'chat'
      ? await mountHostedChat(variant, { hosted: { home: setup } })
      : mountStandaloneChat(variant);
  await mounted.settle();
  return mounted;
}

const originOf = (host: Host): 'home' | 'chat' => (host === 'home' ? 'home' : 'chat');

/** The geometry and the rows the frame model draws for `spec` (its first step) at `variant`. */
function modelOf(
  spec: PopupSpec,
  variant: Variant,
): { readonly geometry: PopupBoxGeometry; readonly rows: readonly string[] } {
  const placement = variant.renderer === 'alt' ? 'overlay' : 'replace';
  const frame = openFrame(spec, 1);
  const { spec: step, state: opened } = currentStep(frame);
  // as the slot draws it: a filter line only for a step that has one
  const state = { ...opened, filter: step.filter === true ? opened.filter : undefined };
  const geometry = popupGeometry({
    columns: variant.size.cols,
    rows: variant.size.rows,
    kind: 'standard',
    placement,
    rail: spec.steps.length > 1,
    bodyRows: naturalBodyRows(
      state.content,
      state,
      placement === 'replace' ? INLINE_LIST_MAX_ROWS : undefined,
      popupInnerWidth(variant.size.cols, 'standard'),
    ),
  });
  if (!geometry.fits) throw new Error('refused');
  const lines = withGlyphForm(!variant.color, () =>
    popupFrameLines(
      {
        title: spec.title,
        origin: spec.origin,
        steps: spec.steps.map((step) => step.name),
        stepIndex: 0,
        legend: popupLegend(frame, reportPageRows(geometry, state.filter !== undefined)),
      },
      popupBody(state.content, state, geometry),
      geometry,
    ),
  );
  return { geometry, rows: lines.map((line) => line.text) };
}

/** The cells of the drawn frame the popup's box covers, row by row (Ink trims a row's trailing spaces, so a row is compared trimmed). */
function drawnBox(frame: readonly string[], geometry: PopupBoxGeometry): string[] {
  return Array.from({ length: geometry.height }, (_, index) =>
    Array.from(frame[geometry.top + index] ?? '')
      .slice(geometry.left, geometry.left + geometry.width)
      .join('')
      .trimEnd(),
  );
}

/** Every cell of `after` outside the box is the cell `before` had there. */
function outsideUnchanged(
  before: readonly string[],
  after: readonly string[],
  geometry: PopupBoxGeometry,
): string[] {
  const changed: string[] = [];
  const rows = Math.max(before.length, after.length);
  for (let row = 0; row < rows; row += 1) {
    const was = Array.from(before[row] ?? '');
    const now = Array.from(after[row] ?? '');
    const inside = row >= geometry.top && row < geometry.top + geometry.height;
    const width = Math.max(was.length, now.length);
    for (let column = 0; column < width; column += 1) {
      if (inside && column >= geometry.left && column < geometry.left + geometry.width) continue;
      if ((was[column] ?? ' ') !== (now[column] ?? ' '))
        changed.push(`${String(row)}:${String(column)}`);
    }
  }
  return changed;
}

async function closeWithEsc(m: Mounted): Promise<void> {
  m.key(KEYS.escape);
  // A lone Esc is held back a moment while the input layer rules out an escape sequence. The bound is a ceiling on a defect, never a delay
  // anything waits out: generous, so a loaded machine (a failure at load ~60 was seen with 3 s) does not fail a correct host.
  await vi.waitFor(() => expect(m.popups.getSnapshot().open).toBe(false), {
    timeout: 10_000,
    interval: 15,
  });
  await m.settle();
}

describe.each(HOSTS)('the popup in the %s host', (host) => {
  describe.each(RENDERERS)('%s', (renderer) => {
    const variant: Variant = { renderer, color: false, size: { cols: 80, rows: 24 } };

    it('is drawn in its placement, is exactly its own rows, and Esc leaves exactly the frame it found', async () => {
      const m = await mountIn(host, variant);
      try {
        const before = m.frame();
        const spec = testReportPopup(originOf(host));
        expect(m.popups.openForUser(spec).opened).toBe(true);
        await m.until(() => m.frame().join('\n').includes(TEST_POPUP_TITLE));
        await m.settle();
        const after = m.frame();
        const { geometry, rows } = modelOf(spec, variant);
        if (renderer === 'alt') {
          // The overlay: the popup's box holds exactly its own rows (nothing drew over it) and every other cell is the body's, still drawn.
          expect(drawnBox(after, geometry)).toEqual(rows.map((row) => row.trimEnd()));
          expect(outsideUnchanged(before, after, geometry)).toEqual([]);
          expect(after.length).toBeLessThanOrEqual(variant.size.rows);
        } else {
          // The block replaces the body: the live region is the popup's rows and nothing else, at most rows − 1 lines.
          expect(after.map((row) => row.trimEnd())).toEqual(rows.map((row) => row.trimEnd()));
          expect(after.length).toBeLessThanOrEqual(variant.size.rows - 1);
          expect(m.raw()).not.toContain('\u001b[3J');
        }
        await closeWithEsc(m);
        expect(m.frame()).toEqual(before);
      } finally {
        m.unmount();
      }
    });

    it('draws a notification on the hint row, and writes nothing into the transcript or the Home’s notice', async () => {
      const m = await mountIn(host, variant);
      try {
        const transcript = 'store' in m ? m.store.getSnapshot().state.transcript : undefined;
        m.notifications.notify('Settings saved for this chat');
        await m.until(() => m.frame().join('\n').includes('Settings saved for this chat'));
        const hintRow = m.frame().find((row) => row.includes('Settings saved for this chat'));
        expect(hintRow?.trim()).toBe('Settings saved for this chat');
        if ('store' in m) expect(m.store.getSnapshot().state.transcript).toBe(transcript);
        if ('controller' in m) expect(m.controller.getSnapshot().notice).toBeUndefined();
      } finally {
        m.unmount();
      }
    });
  });
});

describe('a refused open, in a real host', () => {
  it('says so in one notification on the hint row and opens nothing (a card is open in the chat)', async () => {
    const m = mountStandaloneChat({ renderer: 'alt', color: false, size: { cols: 80, rows: 24 } });
    try {
      await m.settle();
      void m.store.requestApproval(
        { toolId: 'write_file', action: 'fs_write', preview: { path: 'a.md' } },
        true,
      );
      await m.settle();
      expect(m.popups.openForUser(testReportPopup('chat'))).toEqual({
        opened: false,
        reason: 'card-open',
      });
      // Held while the card is on screen: nothing paints over its rows.
      expect(m.notifications.getSnapshot().held).toBe(true);
      expect(m.notifications.getSnapshot().queued).toBe(1);
    } finally {
      m.unmount();
    }
  });
});

describe('a popup that throws while it is drawn', () => {
  it.each(HOSTS)(
    'closes unanswered in the %s host, which stays (the error boundary)',
    async (host) => {
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const m = await mountIn(host, {
        renderer: 'alt',
        color: false,
        size: { cols: 80, rows: 24 },
      });
      try {
        const broken: PopupSpec = {
          id: 'broken',
          title: 'Broken',
          origin: originOf(host),
          steps: [
            {
              name: 'One',
              content: {
                kind: 'list',
                rows: [
                  {
                    id: 'x',
                    get label(): string {
                      throw new Error('a row that cannot be drawn');
                    },
                  },
                ],
              },
            },
          ],
        };
        m.popups.openForUser(broken);
        await m.until(() => !m.popups.getSnapshot().open);
        await m.settle();
        expect(m.popups.getSnapshot().open).toBe(false);
        expect(m.notifications.getSnapshot().current?.text).toBe(
          'Broken closed: it could not be shown',
        );
        // The host is still there and takes the next popup.
        expect(m.popups.openForUser(testReportPopup(originOf(host))).opened).toBe(true);
        await m.until(() => m.frame().join('\n').includes(TEST_POPUP_TITLE));
      } finally {
        m.unmount();
        quiet.mockRestore();
      }
    },
  );
});

describe('the opening guard, on a popup the person opened (ADR-0148 §3)', () => {
  it('a bare Enter chain as it opens changes nothing; an Enter after the settle answers on the current value', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const m = await mountIn('home', {
        renderer: 'alt',
        color: false,
        size: { cols: 80, rows: 24 },
      });
      try {
        const enter = vi.fn();
        const spec: PopupSpec = {
          ...testReportPopup('home'),
          steps: [{ ...testReportPopup('home').steps[0]!, enter: 'apply', initialRow: 'bravo' }],
        };
        m.popups.openForUser(spec, {
          enter: (_context, row) => {
            enter(row?.id);
          },
        });
        // the Enter keys of a chain land with it, then for the next half second
        for (let press = 0; press < 5; press += 1) {
          m.key(KEYS.enter);
          await m.settle();
          vi.advanceTimersByTime(90);
        }
        expect(enter).not.toHaveBeenCalled();
        vi.advanceTimersByTime(500);
        m.key(KEYS.enter);
        await vi.waitFor(() => expect(enter).toHaveBeenCalledTimes(1));
        // it opened on the current value, so the answer is the value it already was
        expect(enter).toHaveBeenCalledWith('bravo');
      } finally {
        m.unmount();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a native prompt a flow drew as a popup (the channel’s descriptor, ADR-0148 §2)', () => {
  it.each(HOSTS.flatMap((host) => RENDERERS.map((renderer) => [host, renderer] as const)))(
    'in the %s host, %s: drawn in the popup frame in its placement, and answered there',
    async (host, renderer) => {
      const variant: Variant = { renderer, color: false, size: { cols: 80, rows: 24 } };
      const m: Mounted =
        host === 'home'
          ? mountHome(variant, { nativePrompt: true })
          : host === 'chat'
            ? await mountHostedChat(variant, { nativePrompt: true })
            : mountStandaloneChat(variant, { nativePrompt: true });
      try {
        await m.settle();
        const before = m.frame();
        const channel = m.channel;
        if (channel === undefined) throw new Error('no channel');
        channel.flow.begin();
        channel.flow.popup?.({
          placement: 'overlay',
          title: '/flow',
          origin: originOf(host),
          stepIndex: 0,
          stepCount: 2,
          exitLabel: 'close',
          depth: 1,
        });
        const answer = channel.flow.select({
          message: 'Which one?',
          options: [
            { value: 'a', label: 'First' },
            { value: 'b', label: 'Second' },
          ],
        });
        await m.until(() => m.frame().join('\n').includes('/flow'));
        await m.settle();
        const frame = m.frame();
        const text = frame.join('\n');
        expect(text).toContain('from ' + (host === 'home' ? 'Home' : 'chat') + ' · step 1 of 2');
        expect(text).toMatch(/> First/u);
        if (renderer === 'alt') {
          // the body stays drawn behind it: a row of the body that the box does not cover is still there
          const geometry = popupGeometry({
            columns: 80,
            rows: 24,
            kind: 'standard',
            placement: 'overlay',
            rail: true,
            bodyRows: 3,
          });
          if (!geometry.fits) throw new Error('refused');
          expect(outsideUnchanged(before, frame, geometry)).toEqual([]);
        } else {
          expect(frame.length).toBeLessThanOrEqual(23);
          expect(m.raw()).not.toContain('\u001b[3J');
        }
        await pause(40); // the frame is flushed and acknowledged
        m.key(KEYS.down);
        await m.until(() => /> Second/u.test(m.frame().join('\n')));
        await pause(40);
        m.key(KEYS.enter);
        await expect(answer).resolves.toBe('b');
        await channel.flow.end();
      } finally {
        m.unmount();
      }
    },
  );
});

/** A popup host whose acknowledgement the test can read, on a manual clock: the visibility the root binds and every NEW frame it reports. */
function observedPopups(
  placement: 'overlay' | 'replace',
  now: () => number,
  schedule: (run: () => void, ms: number) => () => void,
) {
  const real = createPopupHost({ placement, now, schedule });
  let visible: ((snapshot: ReturnType<PopupHost['getSnapshot']>) => boolean) | undefined;
  let shown = 0;
  const host: PopupHost = {
    ...real,
    bindVisibility: (check) => {
      visible = check;
      real.bindVisibility(check);
    },
    shown: (snapshot) => {
      shown += 1;
      real.shown(snapshot);
    },
  };
  return { host, visible: () => visible?.(real.getSnapshot()) === true, shown: () => shown };
}

describe('the measured frame and the loading clock (ADR-0147 §2, ADR-0148 §2)', () => {
  it('a thousand clock ticks leave the acknowledgement valid, the snapshot the same, and the frame shown once', async () => {
    let now = 0;
    const timers: { at: number; run: () => void; cancelled: boolean }[] = [];
    const schedule = (run: () => void, ms: number) => {
      const timer = { at: now + ms, run, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    };
    const observed = observedPopups('overlay', () => now, schedule);
    const m = mountHome(
      { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } },
      { props: { popups: observed.host } },
    );
    try {
      await m.settle();
      observed.host.openForUser({
        id: 'loading',
        title: 'Loading report',
        origin: 'home',
        steps: [{ name: 'Check', content: { kind: 'loading', what: 'Checking' } }],
      });
      await m.until(() => observed.visible());
      const snapshot = observed.host.getSnapshot();
      expect(observed.shown()).toBe(1);
      for (let tick = 0; tick < 1000; tick += 1) {
        now += 80;
        for (const timer of timers.filter((entry) => !entry.cancelled && entry.at <= now)) {
          timer.cancelled = true;
          timer.run();
        }
        if (tick % 50 === 0) await m.settle();
      }
      await m.settle();
      // the clock was read at its last one-second tick: 79 or 80 seconds into the 80
      expect(m.frame().join('\n')).toMatch(/Checking… {2}(?:79|80) s/u);
      expect(observed.host.getSnapshot()).toBe(snapshot);
      expect(observed.visible(), 'still acknowledged after every tick').toBe(true);
      expect(observed.shown(), 'the frame was new once: no tick restarted it').toBe(1);
    } finally {
      m.unmount();
    }
  });
});

describe('the inline block through a resize (ADR-0148 §4)', () => {
  it.each(['standard', 'inspection'] as const)(
    'a %s popup keeps the whole live region at most rows − 1 at 80×30, 80×25 and 80×24, and never clears the scrollback',
    async (kind) => {
      let size = { cols: 80, rows: 30 };
      const listeners = new Set<() => void>();
      const m = mountHome(
        { renderer: 'inline', color: false, size: { cols: 80, rows: 30 } },
        {
          getSize: () => size,
          subscribeResize: (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
        },
      );
      try {
        await m.settle();
        const rows = Array.from({ length: 40 }, (_, index) => ({
          id: `r${String(index)}`,
          label: `row ${String(index)}`,
        }));
        m.popups.openForUser({
          id: 'tall',
          title: 'Tall report',
          origin: 'home',
          kind,
          steps: [{ name: 'Rows', content: { kind: 'list', rows } }],
        });
        await m.until(() => m.frame().join('\n').includes('Tall report'));
        for (const next of [
          { cols: 80, rows: 30 },
          { cols: 80, rows: 25 },
          { cols: 80, rows: 24 },
        ]) {
          size = next;
          m.resize(next.cols, next.rows);
          for (const listener of listeners) listener();
          await m.settle();
          const frame = m.frame();
          expect(frame.length, `${String(next.rows)} rows`).toBeLessThanOrEqual(next.rows - 1);
          expect(frame.join('\n')).toContain('Tall report');
        }
        // A standard popup is never taller than 21 rows, so no size here makes the renderer clear the user's scrollback. The inspection
        // popup is `rows − 1` at every render too, but a terminal that SHRINKS below the region it drew a moment ago makes the renderer
        // clear (its frame now overflows the new size, whatever the next frame is): a property of the resize, not of the popup's height.
        if (kind === 'standard') expect(m.raw()).not.toContain('\u001b[3J');
      } finally {
        m.unmount();
      }
    },
  );
});

describe('an empty or error state draws both its sentences whole in a real host (MVP-11 step 4 review)', () => {
  const WHAT =
    'There is no project here, so there is nothing to list: no workflow and no agent was found in this folder or above it.';
  const NEXT =
    'Open Relavium in a project folder, or use /init on the Home to start one here, then open this list again.';

  it.each([
    ['home', 'alt'],
    ['home', 'inline'],
    ['standalone-chat', 'alt'],
  ] as const)(
    'in the %s host (%s): the sentences wrap inside the frame, and it is the frame the model draws',
    async (host, renderer) => {
      const variant: Variant = { renderer, color: false, size: { cols: 80, rows: 24 } };
      const m = await mountIn(host, variant);
      try {
        const spec: PopupSpec = {
          id: 'states',
          title: '/states',
          origin: originOf(host),
          steps: [{ name: 'One', content: { kind: 'empty', what: WHAT, next: NEXT } }],
        };
        expect(m.popups.openForUser(spec).opened).toBe(true);
        await m.until(() => m.frame().join('\n').includes('then open this list again.'));
        await m.settle();
        // The popup's own cells, as the model draws them: the drawn frame holds exactly these rows, in its box.
        const box = popupBoxOf(m.popupFrame(), variant);
        const frame = m.frame();
        const first =
          box.placement === 'overlay'
            ? box.top
            : frame.findIndex((row) => row.trimEnd() === (box.rows[0] ?? '').trimEnd());
        expect(first).toBeGreaterThanOrEqual(0);
        const left = box.placement === 'overlay' ? box.left : 0;
        const drawn = box.rows.map((_, index) =>
          (frame[first + index] ?? '').slice(left, left + box.width).trimEnd(),
        );
        expect(drawn).toEqual(box.rows.map((row) => row.trimEnd()));
        // Both sentences are there whole, wrapped over rows of the popup, and nothing is cut.
        const words = drawn
          .map((row) => row.trim())
          .join(' ')
          .replace(/\s+/gu, ' ');
        expect(words).toContain(WHAT);
        expect(words).toContain(NEXT);
        expect(words).not.toContain('…');
      } finally {
        m.unmount();
      }
    },
  );
});

describe('the hosts’ own wiring around an open popup (MVP-11 step 4, review round 2, mutation sweep L01–L04, L23)', () => {
  const NOTICE = 'QXS settings saved for this chat';

  it('L04/L06: while a popup is open over the body, its notification is read once, in the popup, not again on the hint row behind it', async () => {
    const variant: Variant = { renderer: 'alt', color: false, size: { cols: 100, rows: 40 } };
    const m = mountStandaloneChat(variant);
    try {
      await m.settle();
      expect(m.popups.openForUser(testReportPopup('chat')).opened).toBe(true);
      await m.settle();
      m.notifications.notify(NOTICE);
      await m.until(() => m.frame().join('\n').includes(NOTICE));
      await m.settle();
      expect(m.frame().join('\n').split(NOTICE).length - 1).toBe(1);
    } finally {
      m.unmount();
    }
  });

  it('L01/L02: the composer’s cursor block is not lit while a popup owns the keys (the control: it is lit before)', async () => {
    const variant: Variant = { renderer: 'alt', color: true, size: { cols: 100, rows: 40 } };
    const m = mountStandaloneChat(variant);
    try {
      await m.settle();
      const lit = (): number =>
        m
          .cells()
          .flat()
          .filter((cell) => cell.style.inverse).length;
      expect(lit()).toBeGreaterThan(0);
      expect(m.popups.openForUser(testReportPopup('chat')).opened).toBe(true);
      await m.settle();
      const frame = m.popups.getSnapshot().frame;
      if (frame === undefined) throw new Error('open');
      const box = popupBoxOf(frame, variant);
      const outside = m
        .cells()
        .flatMap((row, index) => (index >= box.top && index < box.top + box.height ? [] : row))
        .filter((cell) => cell.style.inverse).length;
      expect(outside).toBe(0);
    } finally {
      m.unmount();
    }
  });

  it('L03: what was typed stays on the composer behind the popup (only the cursor is taken away)', async () => {
    const variant: Variant = { renderer: 'alt', color: false, size: { cols: 100, rows: 40 } };
    const m = mountStandaloneChat(variant);
    try {
      await m.settle();
      m.key('hello there');
      await m.until(() => m.frame().join('\n').includes('hello there'));
      expect(m.popups.openForUser(testReportPopup('chat')).opened).toBe(true);
      await m.settle();
      expect(m.frame().join('\n')).toContain('hello there');
    } finally {
      m.unmount();
    }
  });

  it('L23: a report opened in a chat says on its top edge that it came from the chat', async () => {
    const variant: Variant = { renderer: 'alt', color: false, size: { cols: 100, rows: 40 } };
    const m = mountStandaloneChat(variant, { reports: reportsPortFor('standalone-chat', 'help') });
    try {
      await m.settle();
      await m.typeLine('/help');
      await m.until(() => m.popups.getSnapshot().frame?.spec.id === 'help');
      await m.settle();
      expect(m.frame().join('\n')).toContain('from chat');
      expect(m.frame().join('\n')).not.toContain('from Home');
    } finally {
      m.unmount();
    }
  });
});
