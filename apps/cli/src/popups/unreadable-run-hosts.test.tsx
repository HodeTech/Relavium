// Chalk's level is read once, when it is first imported: the matrix's own first import (see `force-color.ts`).
import '../render/tui/force-color.js';

/**
 * The card of an unreadable run in the real Home (MVP-11 unit 7; ADR-0148 §1, §10), through the mounted `RootApp` and the Home's own popup host,
 * the way `driveHome` wires them: `↓` onto the work page, `Enter` on the unreadable row, the card over it, `Esc` back to the same row. What it pins:
 * the card says what its reason says, in both renderers at the floor and at a roomy terminal; it changes and starts nothing (no run launched, no
 * conversation resumed, no notice, no screen, the page and the focus where they were); a key held down on the row opens it ONCE, whenever its
 * repeats arrive, and the card that appeared under a held key answers nothing, because no key but its way out does anything.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HomeSnapshot, HomeUnreadableRun, UnreadableRunReason } from '../home/home-store.js';
import { createChordHistory } from '../render/tui/chord-guard.js';
import {
  EMPTY_SNAPSHOT,
  KEYS,
  MATRIX_NOW_MS,
  mountHome,
  type HomeMount,
} from '../render/tui/surface-matrix/home-host.js';
import type { Variant } from '../render/tui/surface-matrix/variants.js';
import { createNotificationChannel } from './notifications.js';
import { createPopupHost } from './popup-host.js';
import { openUnreadableRun } from './unreadable-run-port.js';

const WAIT_MS = 10_000;
/** The repeats that follow the first press at once, before anything has had time to open. */
const FIRST_REPEATS = 3;
/** One turn of the event loop: what a terminal leaves between two key events, so that two writes never reach the reader as one chunk. */
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
vi.setConfig({ testTimeout: 3 * WAIT_MS });

afterEach(() => {
  vi.useRealTimers();
});

const FIRST = '3f9a1c2e-5b7d-4e11-9a0c-77d2e3f4a5b6';
const SECOND = '9c0d4b7e-2a61-4f35-8e19-0b6a7d1c2e44';
const REASONS: readonly UnreadableRunReason[] = ['newer-version', 'corrupt-row', 'could-not-read'];

const unreadable = (
  runId: string,
  reason: UnreadableRunReason,
  slug: string | undefined,
): HomeUnreadableRun => ({
  runId,
  ...(slug === undefined ? {} : { workflowSlug: slug }),
  status: 'failed',
  createdAt: new Date(MATRIX_NOW_MS - 3 * 60 * 60 * 1000).toISOString(),
  reason,
});

const snapshotWith = (runs: readonly HomeUnreadableRun[]): HomeSnapshot => ({
  ...EMPTY_SNAPSHOT,
  unreadableRuns: runs,
  totals: { attention: runs.length, sessions: 0, runs: 0 },
  isEmpty: false,
});

const VARIANTS: readonly Variant[] = [
  { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } },
  { renderer: 'alt', color: true, size: { cols: 80, rows: 24 } },
  { renderer: 'alt', color: false, size: { cols: 120, rows: 40 } },
  { renderer: 'inline', color: false, size: { cols: 80, rows: 24 } },
  { renderer: 'inline', color: false, size: { cols: 120, rows: 40 } },
];
const nameOf = (variant: Variant): string =>
  `${variant.renderer} ${variant.color ? 'colour' : 'plain'} ${String(variant.size.cols)}×${String(variant.size.rows)}`;

/** What would be a start if the card did one: a run launched, a conversation resumed or begun. */
function spies() {
  return {
    launchRun: vi.fn(() => Promise.resolve('run-started')),
    resumeChat: vi.fn(() => new Promise<undefined>(() => {})),
    startChat: vi.fn(() => new Promise<never>(() => {})),
  };
}

function mount(variant: Variant, runs: readonly HomeUnreadableRun[]) {
  const started = spies();
  const m = mountHome(variant, {
    snapshot: snapshotWith(runs),
    deps: { launchRun: started.launchRun, resumeChat: started.resumeChat },
  });
  return { m, started };
}

const focusId = (m: HomeMount): string | undefined => m.controller.getSnapshot().stripFocus?.id;
const cardOf = (m: HomeMount) => m.popupFrame();

/** `↓` from the landing onto the work page and along to the `index`th row, each press once the frame it reaches is on screen. */
async function focusRow(m: HomeMount, runId: string, presses: number): Promise<void> {
  await m.until(() => m.homePainted());
  for (let n = 0; n < presses; n += 1) {
    m.key(KEYS.down);
    await m.until(() => m.homePainted());
    await m.settle();
  }
  await vi.waitFor(() => expect(focusId(m)).toBe(runId), { timeout: WAIT_MS, interval: 15 });
}

const opens = async (m: HomeMount): Promise<void> => {
  await vi.waitFor(() => expect(cardOf(m)?.spec.id).toBe('unreadable-run'), {
    timeout: WAIT_MS,
    interval: 15,
  });
  await m.settle();
};
const closes = async (m: HomeMount): Promise<void> => {
  await vi.waitFor(() => expect(m.popups.getSnapshot().open).toBe(false), {
    timeout: WAIT_MS,
    interval: 15,
  });
  await m.settle();
};

/** What the Home holds apart from the card: where the keys stand, and what the Home says. */
const homeState = (m: HomeMount) => {
  const state = m.controller.getSnapshot();
  return {
    page: state.homePage,
    focus: state.stripFocus,
    notice: state.notice,
    screen: state.screen,
    mode: state.mode,
    notification: m.notifications.getSnapshot().current,
  };
};

describe.each(VARIANTS)('the card in the Home, $renderer', (variant) => {
  describe(nameOf(variant), () => {
    it('Enter on the second unreadable row opens THAT run’s card over the work page; Esc closes it and the focus is still on the row', async () => {
      const { m, started } = mount(variant, [
        unreadable(FIRST, 'newer-version', 'release-notes'),
        unreadable(SECOND, 'could-not-read', undefined),
      ]);
      try {
        await focusRow(m, SECOND, 2);
        const before = homeState(m);
        m.key(KEYS.enter);
        await opens(m);
        const text = m.text();
        expect(text).toContain('Run 9c0d4b7e cannot be read');
        expect(text).toContain(SECOND);
        expect(text).not.toContain(FIRST);
        expect(text).toContain('Workflow  unknown');
        expect(text).toContain('Started   3h ago');
        expect(text).toContain('could not be read just now. Try again.');
        expect(text).toContain('Nothing was changed or started.');
        expect(text).toMatch(/Esc close/u);
        expect(text).not.toContain('more');
        expect(homeState(m)).toEqual(before);

        m.key(KEYS.escape);
        await closes(m);
        expect(homeState(m)).toEqual(before);
        expect(focusId(m)).toBe(SECOND);
        expect(started.launchRun).not.toHaveBeenCalled();
        expect(started.resumeChat).not.toHaveBeenCalled();
      } finally {
        m.unmount();
      }
    });

    it.each(REASONS)('says what to do for %s', async (reason) => {
      const { m } = mount(variant, [unreadable(FIRST, reason, 'release-notes')]);
      try {
        await focusRow(m, FIRST, 1);
        m.key(KEYS.enter);
        await opens(m);
        const text = m.text();
        const said: Readonly<Record<UnreadableRunReason, string>> = {
          'newer-version': 'Update Relavium and it reads.',
          'corrupt-row': "This run's log has a damaged row.",
          'could-not-read': 'Try again.',
        };
        expect(text).toContain(said[reason]);
        expect(text).toContain('Workflow  release-notes');
        expect(text).toContain('Status    failed');
        expect(text).toContain(FIRST);
      } finally {
        m.unmount();
      }
    });
  });
});

describe('a key held down on the row', () => {
  const INITIAL_DELAYS_MS = [0, 450, 1_800] as const;
  const REPEAT_INTERVALS_MS = [30, 100] as const;
  const HOLD_MS = 2_500;
  const variant: Variant = { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } };

  /** The keys that, on this step, answer something: there are none, so every one of them is a no-op, the way out aside. */
  const ANSWERLESS_KEYS: readonly (readonly [string, string])[] = [
    ['Enter', KEYS.enter],
    ['↑', KEYS.up],
    ['↓', KEYS.down],
    ['←', KEYS.left],
    ['→', KEYS.right],
    ['PgUp', KEYS.pageUp],
    ['PgDn', KEYS.pageDown],
    ['Tab', KEYS.tab],
    ['Ctrl+Y', KEYS.ctrlY],
    ['Ctrl+N', KEYS.ctrlN],
    ['Ctrl+R', KEYS.ctrlR],
    ['Ctrl+G', KEYS.ctrlG],
    ['Backspace', String.fromCharCode(0x7f)],
    ...['a', 'c', 'd', 'p', 'r', 'x', 'y', 'n', '1', ' ', '/'].map(
      (letter) => [`“${letter}”`, letter] as const,
    ),
  ];

  /** What the card holds that a key could change: its step, its scroll and its filter. */
  const cardState = (m: HomeMount) => {
    const frame = cardOf(m);
    const step = frame?.steps[frame.stepIndex];
    return {
      id: frame?.spec.id,
      stepIndex: frame?.stepIndex,
      offset: step?.offset,
      selected: step?.selected,
      filter: step?.filter,
      content: step?.content,
    };
  };

  it.each(
    INITIAL_DELAYS_MS.flatMap((initial) =>
      REPEAT_INTERVALS_MS.map((every) => [initial, every] as const),
    ),
  )(
    'opens the card ONCE and the repeats after it answer nothing: first repeat after %i ms, then every %i ms for 2.5 s',
    async (initial, every) => {
      const { m, started } = mount(variant, [unreadable(FIRST, 'corrupt-row', 'release-notes')]);
      try {
        await focusRow(m, FIRST, 1);
        const before = homeState(m);
        const openForUser = vi.spyOn(m.popups, 'openForUser');
        m.key(KEYS.enter);
        // the repeats follow at once, one event each as a terminal sends a held key (bytes written in one tick would arrive as one chunk of text)
        for (let repeat = 0; repeat < FIRST_REPEATS; repeat += 1) {
          await nextTurn();
          m.key(KEYS.enter);
        }
        await opens(m);
        const shown = cardState(m);
        m.skip(initial);
        for (let held = 0; held <= HOLD_MS; held += every) {
          m.key(KEYS.enter);
          m.skip(every);
          await nextTurn();
        }
        await m.settle();
        expect(openForUser, 'one open, whenever the repeats arrived').toHaveBeenCalledTimes(1);
        expect(cardState(m)).toEqual(shown);
        expect(m.popups.getSnapshot().depth).toBe(1);
        expect(homeState(m)).toEqual(before);
        expect(m.text()).not.toContain('cannot open now');
        expect(started.launchRun).not.toHaveBeenCalled();
        expect(started.resumeChat).not.toHaveBeenCalled();
      } finally {
        m.unmount();
      }
    },
  );

  it.each(ANSWERLESS_KEYS)(
    'the card answers nothing to %s: it stays as it was, and nothing starts',
    async (_name, bytes) => {
      const { m, started } = mount(variant, [unreadable(FIRST, 'corrupt-row', 'release-notes')]);
      try {
        await focusRow(m, FIRST, 1);
        m.key(KEYS.enter);
        await opens(m);
        m.skip(5_000); // past every guard the popup has: a key that could answer would have its chance
        const shown = cardState(m);
        const before = homeState(m);
        m.key(bytes);
        await m.settle();
        expect(cardState(m)).toEqual(shown);
        expect(homeState(m)).toEqual(before);
        expect(started.launchRun).not.toHaveBeenCalled();
        expect(started.resumeChat).not.toHaveBeenCalled();
      } finally {
        m.unmount();
      }
    },
  );

  it('Esc is the way out, Ctrl+C is the other: each closes the card with the Home as it was', async () => {
    for (const out of [KEYS.escape, KEYS.ctrlC]) {
      const { m } = mount(variant, [unreadable(FIRST, 'corrupt-row', 'release-notes')]);
      try {
        await focusRow(m, FIRST, 1);
        const before = homeState(m);
        m.key(KEYS.enter);
        await opens(m);
        m.key(out);
        await closes(m);
        expect(homeState(m)).toEqual(before);
        expect(focusId(m)).toBe(FIRST);
      } finally {
        m.unmount();
      }
    }
  });

  it('the row opens it again after it was closed', async () => {
    const { m } = mount(variant, [unreadable(FIRST, 'corrupt-row', 'release-notes')]);
    try {
      await focusRow(m, FIRST, 1);
      for (let round = 0; round < 2; round += 1) {
        m.key(KEYS.enter);
        await opens(m);
        m.key(KEYS.escape);
        await closes(m);
      }
    } finally {
      m.unmount();
    }
  });
});

describe('the opener of the card', () => {
  const run = unreadable(FIRST, 'corrupt-row', 'release-notes');
  const hostOf = () => {
    const notifications = createNotificationChannel();
    const host = createPopupHost({
      now: () => performance.now(),
      history: createChordHistory(),
      notifications,
      placement: 'overlay',
    });
    host.bindOpenGate(() => undefined);
    return { host, notifications };
  };

  it('drops the repeat of a press whose card is still loading: one open, no “another popup is open” notice', async () => {
    const { host, notifications } = hostOf();
    const request = { host, run, origin: 'home', now: () => MATRIX_NOW_MS } as const;
    const openForUser = vi.spyOn(host, 'openForUser');
    await Promise.all([
      openUnreadableRun(request),
      openUnreadableRun(request),
      openUnreadableRun(request),
    ]);
    expect(openForUser).toHaveBeenCalledTimes(1);
    expect(host.getSnapshot().frame?.spec.id).toBe('unreadable-run');
    expect(notifications.getSnapshot().current).toBeUndefined();
    expect(notifications.getSnapshot().queued).toBe(0);
    host.dispose();
    notifications.dispose();
  });

  it('is open to the next press once the first has settled', async () => {
    const { host, notifications } = hostOf();
    const request = { host, run, origin: 'home', now: () => MATRIX_NOW_MS } as const;
    const openForUser = vi.spyOn(host, 'openForUser');
    await openUnreadableRun(request);
    host.closeAll('command');
    await openUnreadableRun(request);
    expect(openForUser).toHaveBeenCalledTimes(2);
    expect(host.getSnapshot().open).toBe(true);
    host.dispose();
    notifications.dispose();
  });

  it('says a refusal in the host’s own one notification when a popup is already open', async () => {
    const { host, notifications } = hostOf();
    const request = { host, run, origin: 'home', now: () => MATRIX_NOW_MS } as const;
    await openUnreadableRun(request);
    await openUnreadableRun(request);
    expect(notifications.getSnapshot().current?.text).toContain('cannot open now');
    host.dispose();
    notifications.dispose();
  });
});
