/**
 * The native prompt channel's lock (`NativePromptUi.lock`; the maintainer's ruling of 2026-11-26 on ADR-0145 §3, MVP-11 step 6 round 1, O4): a
 * chord card's `Ctrl+Y` and a guarded option's `Enter` are drawn dim with `(wait)` while their guard's 2 s lockout holds them, from the moment
 * the prompt appears, and plain again at the unlock instant, by ONE timer; a refused early press moves that timer and the part stays dim;
 * resolution, `flow.end` and `dispose` clear it; a prompt that holds nothing runs none. The lock is a display value, never a snapshot field: the
 * unlock publishes no frame, so a key at that instant is judged exactly as it would be with no lock at all. The legend parts read it for the
 * popup frame and the card alike, and the popup's row at 80 columns keeps the waiting part before every other key but the ways out.
 */
import type { Key } from 'ink';
import { describe, expect, it } from 'vitest';

import { INIT_ALLOW_LABEL, INIT_DENY_LABEL } from '../../home/project-init.js';
import { RUN_CONFIRM_ALLOW, RUN_CONFIRM_DENY } from '../../home/run-launch.js';
import { fittedLegendItems } from '../../popups/frame-model.js';
import { popupInnerWidth } from '../../popups/geometry.js';
import {
  nativeLegendParts,
  nativePopupLayout,
  nativePopupLegend,
} from '../../popups/native-popup-body.js';
import { createChordHistory } from './chord-guard.js';
import { EXPORT_ALLOW_LABEL, EXPORT_DENY_LABEL } from './export-card.js';
import { IMPORT_ALLOW_LABEL, IMPORT_DENY_LABEL } from './import-card.js';
import { exitKey, legend, legendSpans } from './legend.js';
import {
  createNativePromptChannel,
  NATIVE_PROMPT_CANCEL,
  type NativePopupDescriptor,
  type NativePromptSnapshot,
} from './native-prompt-channel.js';
import { chordRowText, promptLegend } from './native-prompt-view.js';
import {
  PRICING_CLEAR_ALLOW_LABEL,
  PRICING_DENY_LABEL,
  PRICING_SET_ALLOW_LABEL,
} from './pricing-card.js';
import { APPROVAL_LOCKOUT_MS } from './tool-review-model.js';

const NONE: Key = {
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
const CTRL: Key = { ...NONE, ctrl: true };
const ENTER: Key = { ...NONE, return: true };
const DOWN: Key = { ...NONE, downArrow: true };

/** The inner width of a standard popup at the floor (80×24): the row a framed legend is fitted to. */
const FLOOR_WIDTH = popupInnerWidth(80, 'standard');

/** A manual clock whose one-shot timers run when time moves; `due` lists the instants of the timers still pending. */
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
    due: (): readonly number[] =>
      pending.filter((timer) => !timer.cancelled).map((timer) => timer.at),
  };
}

/**
 * A channel on a manual clock with the product's guard numbers, its frame "on screen" exactly when the snapshot is the one last acknowledged
 * (by reference, as the measured-frame acknowledgement is), and what its lock and its snapshot listeners heard.
 */
function rig(options: { readonly history?: ReturnType<typeof createChordHistory> } = {}) {
  const time = manualTimers();
  const channel = createNativePromptChannel({
    now: time.now,
    schedule: time.schedule,
    ...(options.history === undefined ? {} : { history: options.history }),
  });
  let acknowledged: NativePromptSnapshot | undefined;
  channel.ui.bindVisibility((snapshot) => snapshot === acknowledged);
  const heard: boolean[] = [];
  channel.ui.lock.subscribe(() => heard.push(channel.ui.lock.read()));
  let frames = 0;
  channel.ui.subscribe(() => {
    frames += 1;
  });
  return {
    time,
    ui: channel.ui,
    flow: channel.flow,
    heard,
    /** How many snapshots the channel published (a frame a view would draw). */
    frames: (): number => frames,
    /** The current snapshot measured and flushed on screen, as the live acknowledgement tells it. */
    ack: (): void => {
      acknowledged = channel.ui.getSnapshot();
      channel.ui.shown(acknowledged);
    },
    ctrlY: (): boolean => channel.ui.input('y', CTRL),
    ctrlN: (): boolean => channel.ui.input('n', CTRL),
  };
}

const PENDING: unique symbol = Symbol('pending');
/** What a promise has settled with by now (the microtasks run), or {@link PENDING}. */
async function settledWith<T>(promise: Promise<T>): Promise<T | typeof PENDING> {
  return Promise.race([
    promise,
    new Promise<typeof PENDING>((resolve) => setImmediate(() => resolve(PENDING))),
  ]);
}

const CREATE = {
  message: 'Create these project directories?',
  allow: 'Create them',
  deny: 'Create nothing',
};
const CONSENT_OPTIONS = [
  { value: 'use', label: 'Use it', guarded: true as const },
  { value: 'not-now', label: 'Not now' },
];

describe('a chord card: locked from the moment it appears, for the lockout, then open at one instant', () => {
  it('reads locked at once, with ONE timer at 2000 ms; at that instant it reads open, heard once, and no frame was published', () => {
    const r = rig();
    r.flow.begin();
    void r.flow.chord(CREATE);
    r.ack();
    expect(r.ui.lock.read()).toBe(true);
    expect(r.time.due()).toEqual([APPROVAL_LOCKOUT_MS]);
    expect(r.heard).toEqual([true]);
    const card = r.ui.getSnapshot();
    const published = r.frames();
    r.time.advance(APPROVAL_LOCKOUT_MS - 1);
    expect(r.ui.lock.read()).toBe(true);
    r.time.advance(1);
    expect(r.ui.lock.read()).toBe(false);
    expect(r.heard).toEqual([true, false]);
    expect(r.time.due()).toEqual([]);
    // The unlock is not a frame: the snapshot is the very one acknowledged, and no listener of the snapshot was called.
    expect(r.ui.getSnapshot()).toBe(card);
    expect(r.frames()).toBe(published);
  });

  it('a Ctrl+Y at the unlock instant is admitted exactly as with no lock: the frame acknowledged before it still counts, the dwell is not restarted', async () => {
    const r = rig();
    r.flow.begin();
    const answer = r.flow.chord(CREATE);
    r.ack(); // the card's frame on screen at 0: its dwell (400 ms) runs from here and nowhere else
    r.time.advance(APPROVAL_LOCKOUT_MS);
    expect(r.ui.lock.read()).toBe(false);
    r.ctrlY();
    expect(await answer).toBe('allow');
  });

  it('a refused early Ctrl+Y restarts the lockout: the part stays locked and the one timer moves to the new instant', async () => {
    const r = rig();
    r.flow.begin();
    const answer = r.flow.chord(CREATE);
    r.ack();
    r.time.advance(1500);
    r.ctrlY();
    expect(await settledWith(answer)).toBe(PENDING);
    expect(r.ui.lock.read()).toBe(true);
    expect(r.time.due()).toEqual([1500 + APPROVAL_LOCKOUT_MS]);
    r.time.advance(500); // the first lockout's end: still locked
    expect(r.ui.lock.read()).toBe(true);
    expect(r.heard).toEqual([true]);
    r.time.advance(1500);
    expect(r.ui.lock.read()).toBe(false);
    expect(r.heard).toEqual([true, false]);
    r.ctrlY();
    expect(await answer).toBe('allow');
  });

  it('a Ctrl+Y the host dropped (its frame not on screen yet) restarts it too, and the timer moves with it', () => {
    const r = rig();
    r.flow.begin();
    void r.flow.chord(CREATE);
    r.time.advance(1200);
    r.ui.unseenInput('y', CTRL);
    expect(r.time.due()).toEqual([1200 + APPROVAL_LOCKOUT_MS]);
    expect(r.ui.lock.read()).toBe(true);
  });

  it('a Ctrl+Y the opening guard refused (a framed card inside its first frame’s settle) restarts it, and the timer moves with it', () => {
    const r = rig();
    r.flow.begin();
    const descriptor: NativePopupDescriptor = {
      title: '/init',
      origin: 'home',
      stepIndex: 1,
      stepCount: 3,
      stepNames: ['Check', 'Confirm', 'Done'],
      exitLabel: 'close',
      depth: 1,
    };
    r.flow.popup?.(descriptor);
    void r.flow.chord(CREATE);
    r.ack();
    r.time.advance(100); // inside the popup's 500 ms opening settle: the opening admission refuses it before the card's guard sees it
    r.ctrlY();
    expect(r.time.due()).toEqual([100 + APPROVAL_LOCKOUT_MS]);
  });

  it('the lock is the guard’s, on the shared history: a resolution recorded there after the card opened keeps it locked as long as the guard refuses', async () => {
    const history = createChordHistory();
    const r = rig({ history });
    r.time.advance(1000);
    r.flow.begin();
    const answer = r.flow.chord(CREATE);
    r.ack();
    expect(r.time.due()).toEqual([1000 + APPROVAL_LOCKOUT_MS]);
    // Another surface of the Home records a resolution on the shared history at 1500: the card's guard now refuses until 3500.
    r.time.advance(500);
    history.lastResolvedAt = 1500;
    // The timer at 3000 reads the guard again rather than trusting its own instant: still locked, one timer at 3500.
    r.time.advance(1500);
    expect(r.ui.lock.read()).toBe(true);
    expect(r.time.due()).toEqual([1500 + APPROVAL_LOCKOUT_MS]);
    r.time.advance(500);
    expect(r.ui.lock.read()).toBe(false);
    r.ctrlY();
    expect(await answer).toBe('allow');
  });

  it('an answer clears it at once (Ctrl+N is never delayed), and so does Esc', async () => {
    const r = rig();
    r.flow.begin();
    const answer = r.flow.chord(CREATE);
    r.ack();
    r.time.advance(300);
    r.ctrlN();
    expect(await answer).toBe('deny');
    expect(r.ui.lock.read()).toBe(false);
    expect(r.time.due()).toEqual([]);
    expect(r.heard).toEqual([true, false]);

    const esc = rig();
    esc.flow.begin();
    const left = esc.flow.chord(CREATE);
    esc.ui.input('', { ...NONE, escape: true });
    expect(await left).toBe(NATIVE_PROMPT_CANCEL);
    expect(esc.ui.lock.read()).toBe(false);
    expect(esc.time.due()).toEqual([]);
  });

  it('flow.end and dispose clear it, and a disposed channel tells nobody again', async () => {
    const ended = rig();
    ended.flow.begin();
    void ended.flow.chord(CREATE);
    await ended.flow.end();
    expect(ended.ui.lock.read()).toBe(false);
    expect(ended.time.due()).toEqual([]);

    const disposed = rig();
    disposed.flow.begin();
    void disposed.flow.chord(CREATE);
    disposed.ui.dispose();
    expect(disposed.ui.lock.read()).toBe(false);
    expect(disposed.time.due()).toEqual([]);
    expect(disposed.heard).toEqual([true, false]);
    disposed.time.advance(10_000);
    expect(disposed.heard).toEqual([true, false]);
  });
});

describe('a guarded select: locked from the moment it appears; only the guarded option’s Enter waits', () => {
  it('reads locked with one timer; the card legend says `Enter choose (wait)` on the guarded row and `Enter choose` on the other', async () => {
    const r = rig();
    r.flow.begin();
    const answer = r.flow.select({ message: 'Use ANTHROPIC_API_KEY?', options: CONSENT_OPTIONS });
    r.ack();
    expect(r.ui.lock.read()).toBe(true);
    expect(r.time.due()).toEqual([APPROVAL_LOCKOUT_MS]);
    expect(promptLegend(r.ui.getSnapshot(), false, r.ui.lock.read())).toBe(
      '↑/↓ select · Enter choose (wait) · Esc close',
    );
    // The highlight on `Not now`: its `Enter` answers at once, so it does not wait, though the guarded option's lock still holds.
    r.ui.input('', DOWN);
    expect(r.ui.lock.read()).toBe(true);
    expect(promptLegend(r.ui.getSnapshot(), false, r.ui.lock.read())).toBe(
      '↑/↓ select · Enter choose · Esc close',
    );
    r.ack();
    r.ui.input('', ENTER);
    expect(await answer).toBe('not-now');
    expect(r.ui.lock.read()).toBe(false);
    expect(r.time.due()).toEqual([]);
  });

  it('opens at 2000 ms with no frame published; an Enter at that instant answers as with no lock', async () => {
    const r = rig();
    r.flow.begin();
    const answer = r.flow.select({ message: 'Use ANTHROPIC_API_KEY?', options: CONSENT_OPTIONS });
    r.ack();
    const select = r.ui.getSnapshot();
    r.time.advance(APPROVAL_LOCKOUT_MS);
    expect(r.ui.lock.read()).toBe(false);
    expect(r.ui.getSnapshot()).toBe(select);
    r.ui.input('', ENTER);
    expect(await answer).toBe('use');
  });

  it('a refused early Enter restarts it: still locked, the timer at the new instant', async () => {
    const r = rig();
    r.flow.begin();
    const answer = r.flow.select({ message: 'Use ANTHROPIC_API_KEY?', options: CONSENT_OPTIONS });
    r.ack();
    r.time.advance(1500);
    r.ui.input('', ENTER);
    expect(await settledWith(answer)).toBe(PENDING);
    expect(r.ui.lock.read()).toBe(true);
    expect(r.time.due()).toEqual([1500 + APPROVAL_LOCKOUT_MS]);
  });
});

describe('a prompt that holds nothing runs no timer and is never locked', () => {
  it.each([
    ['a text field', (flow: ReturnType<typeof rig>['flow']) => flow.text({ message: 'Path' })],
    ['a masked field', (flow: ReturnType<typeof rig>['flow']) => flow.password({ message: 'Key' })],
    [
      'a select with no guarded option',
      (flow: ReturnType<typeof rig>['flow']) =>
        flow.select({ message: 'Which?', options: [{ value: 'a', label: 'A' }] }),
    ],
    ['a Yes/No', (flow: ReturnType<typeof rig>['flow']) => flow.confirm('Sure?')],
  ])('%s', (_name, open) => {
    const r = rig();
    r.flow.begin();
    void open(r.flow);
    r.ack();
    r.ui.input('', ENTER);
    expect(r.ui.lock.read()).toBe(false);
    expect(r.time.due()).toEqual([]);
    expect(r.heard).toEqual([]);
  });

  it('a wait', () => {
    const r = rig();
    r.flow.begin();
    r.flow.busy('Checking');
    expect(r.ui.lock.read()).toBe(false);
    expect(r.time.due()).toEqual([]);
  });
});

/** A framed chord step, as the channel keeps it, with the product's labels. */
function framedChord(
  allow: string,
  deny: string,
  escape: NativePromptSnapshot['escape'] = 'cancel',
): NativePromptSnapshot {
  return {
    active: true,
    kind: 'chord',
    message: 'Confirm?',
    note: '',
    options: [
      { value: 'allow', label: allow },
      { value: 'deny', label: deny },
    ],
    selected: 0,
    display: '',
    error: '',
    escape,
    details: [],
    popup: {
      title: '/flow',
      origin: 'home',
      stepIndex: 1,
      stepCount: 3,
      stepNames: ['One', 'Confirm', 'Done'],
      exitLabel: 'close',
      depth: 1,
    },
  };
}

/** The legend row a framed prompt draws at the floor's inner width (66), as text. */
function floorRow(snapshot: NativePromptSnapshot, locked: boolean): string {
  const parts = nativePopupLegend(snapshot, false, locked);
  return legend(fittedLegendItems(parts, FLOOR_WIDTH), parts.exit);
}

describe('the popup legend of every chord step in use, at 80 columns (inner width 66)', () => {
  it.each([
    [
      '/init',
      INIT_ALLOW_LABEL,
      INIT_DENY_LABEL,
      'cancel',
      '[Ctrl+Y] Create them (wait) · [Ctrl+N] Create nothing · Esc denies',
      '[Ctrl+Y] Create them · [Ctrl+N] Create nothing · Esc denies',
    ],
    [
      '/import',
      IMPORT_ALLOW_LABEL,
      IMPORT_DENY_LABEL,
      'cancel',
      '[Ctrl+Y] Write the file (wait) · Esc denies',
      '[Ctrl+Y] Write the file · [Ctrl+N] Write nothing · Esc denies',
    ],
    [
      'the Defined export',
      EXPORT_ALLOW_LABEL,
      EXPORT_DENY_LABEL,
      'cancel',
      '[Ctrl+Y] Write the file (wait) · Esc denies',
      '[Ctrl+Y] Write the file · [Ctrl+N] Write nothing · Esc denies',
    ],
    [
      '/pricing (set)',
      PRICING_SET_ALLOW_LABEL,
      PRICING_DENY_LABEL,
      'cancel',
      '[Ctrl+Y] Record the price (wait) · Esc denies',
      '[Ctrl+Y] Record the price · [Ctrl+N] Write nothing · Esc denies',
    ],
    [
      '/pricing (clear), the longest label in use',
      PRICING_CLEAR_ALLOW_LABEL,
      PRICING_DENY_LABEL,
      'cancel',
      '[Ctrl+Y] Remove the override (wait) · Esc denies',
      '[Ctrl+Y] Remove the override · [Ctrl+N] Write nothing · Esc denies',
    ],
    [
      '/run',
      RUN_CONFIRM_ALLOW,
      RUN_CONFIRM_DENY,
      'back',
      '[Ctrl+Y] Start it (wait) · Esc back · [Ctrl+C] denies',
      '[Ctrl+Y] Start it · [Ctrl+N] Cancel · Esc back · [Ctrl+C] denies',
    ],
  ] as const)(
    '%s: while locked the waiting part is kept and `[Ctrl+N]` (which Esc also gives) goes where the row is short; open, it is back',
    (_flow, allow, deny, escape, locked, open) => {
      const snapshot = framedChord(allow, deny, escape);
      expect(floorRow(snapshot, true)).toBe(locked);
      expect(floorRow(snapshot, false)).toBe(open);
      expect([...floorRow(snapshot, true)].length).toBeLessThanOrEqual(FLOOR_WIDTH);
      // The step is on its page in both states (its answer is named on the row while it waits too).
      const layout = nativePopupLayout(snapshot, {
        bodyRows: 18,
        listRows: 18,
        innerWidth: FLOOR_WIDTH,
      });
      expect(layout.fits).toBe(true);
    },
  );

  it('the waiting part is drawn dim as a whole: its key too', () => {
    const parts = nativePopupLegend(framedChord(INIT_ALLOW_LABEL, INIT_DENY_LABEL), false, true);
    const kept = fittedLegendItems(parts, FLOOR_WIDTH);
    const spans = legendSpans(kept, parts.exit);
    expect(spans[0]).toEqual({ from: 0, to: 8, role: 'dim' });
    expect(spans[1]?.role).toBe('dim');
    // Unlocked, the affirmative's key is drawn in its role again.
    const plain = nativePopupLegend(framedChord(INIT_ALLOW_LABEL, INIT_DENY_LABEL), false, false);
    expect(legendSpans(fittedLegendItems(plain, FLOOR_WIDTH), plain.exit)[0]?.role).toBe('ok');
  });

  it('a step whose answer the waiting row would drop is on its page in NEITHER state (judged on the longer row), so the unlock is never a new frame', () => {
    // 40 columns of label: `[Ctrl+Y] <label> · Esc denies` fits 66, `[Ctrl+Y] <label> (wait) · Esc denies` does not.
    const label = 'A'.repeat(40);
    const snapshot = framedChord(label, 'No');
    expect(floorRow(snapshot, false)).toContain('[Ctrl+Y]');
    expect(floorRow(snapshot, true)).not.toContain('[Ctrl+Y]');
    const layout = nativePopupLayout(snapshot, {
      bodyRows: 18,
      listRows: 18,
      innerWidth: FLOOR_WIDTH,
    });
    expect(layout.fits).toBe(false);
  });

  it('on a short row the waiting part outlasts every key but the ways out (here `↑/↓ select`, which comes first)', () => {
    const select: NativePromptSnapshot = {
      ...framedChord('x', 'y'),
      kind: 'select',
      options: CONSENT_OPTIONS,
    };
    const parts = nativePopupLegend(select, false, true);
    // Room for one of the two keys beside `Esc close`.
    const room = [...legend([{ keys: 'Enter', verb: 'choose', wait: true }], parts.exit)].length;
    expect(legend(fittedLegendItems(parts, room), parts.exit)).toBe(
      'Enter choose (wait) · Esc close',
    );
  });

  it('R2-10 where only one of the two fits, the way out (`Esc back`) is kept before the waiting key: the ways out come last', () => {
    const waiting = { keys: 'Ctrl+Y', verb: 'Start it', role: 'ok', wait: true } as const;
    const esc = { keys: 'Esc', verb: 'back' } as const;
    const exit = exitKey.close('Ctrl+C', 'denies');
    const parts = { items: [waiting, esc], exit };
    // Room for `Esc back · [Ctrl+C] denies` and nothing more: the waiting part, which is longer, goes.
    const room = [...legend([esc], exit)].length;
    expect(legend(fittedLegendItems(parts, room), exit)).toBe('Esc back · [Ctrl+C] denies');
    // With room for the waiting part instead of the way out, it is the other way round (the rule is a rank, not a rule against waiting).
    expect(legend(fittedLegendItems(parts, 200), exit)).toBe(
      '[Ctrl+Y] Start it (wait) · Esc back · [Ctrl+C] denies',
    );
  });

  it('a label that says `(wait)` is an ordinary label: open, its part acts and is drawn in its role; the state comes from the lock alone', () => {
    const forged = framedChord('Allow (wait)', 'Deny');
    const parts = nativePopupLegend(forged, false, false);
    expect(parts.items[0]).toEqual({ keys: 'Ctrl+Y', verb: 'Allow (wait)', role: 'ok' });
    expect(legendSpans(parts.items, parts.exit)[0]?.role).toBe('ok');
    expect(nativeLegendParts(forged, false, 'popup', false).items[0]).not.toHaveProperty('wait');
  });
});

describe('the card form of the same prompts', () => {
  it('a chord card’s `[Ctrl+Y]` row says `(wait)` and is dim while locked; its refusal row never waits', () => {
    expect(chordRowText({ value: 'allow', label: 'Create them' }, true)).toEqual({
      text: '[Ctrl+Y] Create them (wait)',
      dim: true,
    });
    expect(chordRowText({ value: 'allow', label: 'Create them' }, false)).toEqual({
      text: '[Ctrl+Y] Create them',
      dim: false,
    });
    expect(chordRowText({ value: 'deny', label: 'Create nothing' }, true)).toEqual({
      text: '[Ctrl+N] Create nothing',
      dim: false,
    });
    // A label that says `(wait)` on an open card is not dim: the state is the lock's.
    expect(chordRowText({ value: 'allow', label: 'Allow (wait)' }, false).dim).toBe(false);
  });

  it('a chord card’s own legend is the way back alone, locked or not (its `[Ctrl+Y]` is on its answer row)', () => {
    const { popup, ...card } = framedChord('Allow', 'Deny');
    void popup;
    expect(promptLegend(card, false, true)).toBe('Esc denies');
    expect(promptLegend(card, false, false)).toBe('Esc denies');
  });
});
