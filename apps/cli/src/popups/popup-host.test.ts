/**
 * The popup host of one terminal host ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2, §3, §5), as a store on an injected clock: the opening rules, the opening guard, the one key history it shares with the chat store's
 * approval guards, what closes a popup unanswered (a sheet, a throw, a resize that would hide a pending chord), late results that land
 * nowhere, a stack of depth two, and a loading clock that is not part of the snapshot.
 */
import type { ToolApprovalRequest } from '@relavium/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createChatStore } from '../render/tui/chat-store.js';
import { createChordHistory } from '../render/tui/chord-guard.js';
import { INLINE_TRANSCRIPT_BOUND } from '../render/tui/session-view-model.js';
import { APPROVAL_TYPEAHEAD_MS } from '../render/tui/tool-review-model.js';
import { displayWidth } from '../render/tui/viewport.js';
import { POPUP_NOTICE_MAX_COLUMNS } from './geometry.js';
import { createNotificationChannel, NOTIFICATION_MS, type Schedule } from './notifications.js';
import {
  closedUnansweredText,
  createPopupHost,
  PASTE_LIMIT,
  refusedOpenText,
  type PopupContext,
  type PopupHandlers,
  type PopupHostOptions,
} from './popup-host.js';
import { currentStep, type PopupSpec, type PopupStep } from './popup-reducer.js';

const ENTER = { return: true } as const;
const ESC = { escape: true } as const;
const DOWN = { downArrow: true } as const;

const LIST: PopupStep = {
  name: 'Pick',
  content: {
    kind: 'list',
    rows: [
      { id: 'one', label: 'one' },
      { id: 'two', label: 'two' },
    ],
  },
  enter: 'apply',
  controls: [{ key: 'r', verb: 'again' }],
};
const spec = (over: Partial<PopupSpec> = {}): PopupSpec => ({
  id: 'test',
  title: '/test',
  origin: 'chat',
  steps: [LIST],
  ...over,
});

/** A manual timer for the loading clock and the notifications. */
function timers() {
  const pending: { at: number; run: () => void; cancelled: boolean }[] = [];
  let now = 0;
  const schedule: Schedule = (run, ms) => {
    const timer = { at: now + ms, run, cancelled: false };
    pending.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  return {
    schedule,
    now: () => now,
    advance: (ms: number): void => {
      const end = now + ms;
      for (;;) {
        const due = pending
          .filter((timer) => !timer.cancelled && timer.at <= end)
          .sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        due.cancelled = true;
        now = due.at;
        due.run();
      }
      now = end;
    },
    live: () => pending.filter((timer) => !timer.cancelled).length,
  };
}

/** A host on a manual clock, its frame always "on screen" unless the test says otherwise, and the time when it appeared. */
function rig(options: Partial<PopupHostOptions> = {}) {
  const time = timers();
  const notifications = createNotificationChannel({ schedule: time.schedule });
  const history = options.history ?? createChordHistory();
  const host = createPopupHost({
    now: time.now,
    schedule: time.schedule,
    notifications,
    history,
    placement: 'overlay',
    ...options,
  });
  let painted = true;
  host.bindVisibility(() => painted);
  /** The frame was measured and flushed now: the popup has appeared. */
  const show = (): void => host.shown(host.getSnapshot());
  return {
    host,
    time,
    notifications,
    history,
    show,
    hide: (): void => {
      painted = false;
    },
    /** Open, appear, and wait out the settle, so a key may answer. */
    openSettled: (s: PopupSpec = spec(), handlers?: PopupHandlers): void => {
      expect(host.openForUser(s, handlers).opened).toBe(true);
      show();
      time.advance(600);
    },
  };
}

describe('opening (ADR-0148 §2)', () => {
  it('opens only when the host’s gate says it may, and a refused open says so in ONE notification and opens nothing', () => {
    const { host, notifications } = rig();
    host.bindOpenGate(() => 'turn-running');
    expect(host.openForUser(spec())).toEqual({ opened: false, reason: 'turn-running' });
    expect(host.getSnapshot().open).toBe(false);
    expect(notifications.getSnapshot().current?.text).toBe(
      refusedOpenText('/test', 'turn-running'),
    );
    expect(notifications.getSnapshot().queued).toBe(0);
  });

  it('refuses a second popup while one is open (a child is the popup’s own to open)', () => {
    const { host } = rig();
    expect(host.openForUser(spec()).opened).toBe(true);
    expect(host.openForUser(spec({ id: 'other' }))).toEqual({
      opened: false,
      reason: 'popup-open',
    });
    expect(host.getSnapshot().depth).toBe(1);
  });

  it('nothing but the person’s command opens one: a sheet, a failure, a resize and a notification never do', () => {
    const { host, notifications } = rig();
    host.sheetArrived();
    host.fail(new Error('x'));
    host.resized(60, 20);
    notifications.notify('anything');
    expect(host.getSnapshot().open).toBe(false);
  });
});

describe('the opening guard, on every popup the person opens (ADR-0148 §3)', () => {
  it('drops a key before the first measured frame, counts it as typing, and lets Esc through', () => {
    const { host, history, time } = rig();
    const enter = vi.fn();
    host.openForUser(spec(), { enter });
    time.advance(5000);
    host.input('', ENTER);
    host.input('', DOWN);
    expect(enter).not.toHaveBeenCalled();
    expect(currentStep(host.getSnapshot().frame ?? fail()).state.selected).toBe(0);
    expect(history.lastForeignKeyAt).toBe(5000);
    host.input('', ESC);
    expect(host.getSnapshot().open).toBe(false);
  });

  it('a bare Enter chain right after it opens changes nothing: no Enter selects for half a second', () => {
    const { host, show, time } = rig();
    const enter = vi.fn();
    host.openForUser(spec(), { enter });
    show();
    for (let ms = 0; ms < 500; ms += 50) {
      time.advance(50);
      if (time.now() < 500) host.input('', ENTER);
    }
    expect(enter).not.toHaveBeenCalled();
    time.advance(1);
    host.input('', ENTER);
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it('the arrows move at once after it appeared; a frame that is no longer on screen takes no key but the leaving ones', () => {
    const { host, show, time, hide } = rig();
    host.openForUser(spec());
    show();
    time.advance(1);
    host.input('', DOWN);
    expect(currentStep(host.getSnapshot().frame ?? fail()).state.selected).toBe(1);
    hide();
    time.advance(1);
    host.input('', { upArrow: true });
    expect(currentStep(host.getSnapshot().frame ?? fail()).state.selected).toBe(1);
    host.input('c', { ctrl: true });
    expect(host.getSnapshot().open).toBe(false);
  });
});

describe('one key history per host (ADR-0148 §2)', () => {
  const REQUEST: ToolApprovalRequest = {
    toolId: 'write_file',
    action: 'fs_write',
    preview: { path: 'notes.md' },
  };
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['performance'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a key typed into a popup is seen by the typeahead guard of a card that opens next', async () => {
    const history = createChordHistory();
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND, {
      history,
      approvalGuard: { settleMs: 0, quietMs: 0, typeaheadMs: APPROVAL_TYPEAHEAD_MS, lockoutMs: 0 },
    });
    // The popup and the store read the SAME clock and the SAME history.
    const host = createPopupHost({ placement: 'overlay', history, now: () => performance.now() });
    host.bindVisibility(() => true);
    host.openForUser(spec());
    host.shown(host.getSnapshot());
    vi.advanceTimersByTime(100);
    host.input('x', {});
    host.input('', ESC);
    // A card arrives at once: its Ctrl+Y inside the typeahead window is refused because of what was typed into the popup.
    const pending = store.requestApproval(REQUEST, true);
    store.bindReviewVisibility(() => true);
    const review = store.getSnapshot().review;
    if (review === undefined) throw new Error('no card');
    store.acknowledgeReviewFrame(review, undefined);
    vi.advanceTimersByTime(100);
    store.handleReviewInput('y', { ctrl: true });
    expect(store.getSnapshot().approval, 'still pending: typing a moment ago').toBeDefined();
    vi.advanceTimersByTime(APPROVAL_TYPEAHEAD_MS);
    store.handleReviewInput('y', { ctrl: true });
    expect(store.getSnapshot().approval).toBeUndefined();
    await pending;
  });

  it('without the shared history the same key is invisible to the card (the control: the sharing is what does it)', async () => {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND, {
      approvalGuard: { settleMs: 0, quietMs: 0, typeaheadMs: APPROVAL_TYPEAHEAD_MS, lockoutMs: 0 },
    });
    const host = createPopupHost({ placement: 'overlay', now: () => performance.now() });
    host.bindVisibility(() => true);
    host.openForUser(spec());
    host.shown(host.getSnapshot());
    vi.advanceTimersByTime(100);
    host.input('x', {});
    host.input('', ESC);
    const pending = store.requestApproval(REQUEST, true);
    store.bindReviewVisibility(() => true);
    const review = store.getSnapshot().review;
    if (review === undefined) throw new Error('no card');
    store.acknowledgeReviewFrame(review, undefined);
    vi.advanceTimersByTime(100);
    store.handleReviewInput('y', { ctrl: true });
    expect(store.getSnapshot().approval).toBeUndefined();
    await pending;
  });

  it('a key that closes or answers a popup is a resolution: a card that opens next is locked against it', () => {
    const { host, history, openSettled, time } = rig();
    openSettled();
    const at = time.now();
    host.input('', ENTER);
    expect(history.lastResolvedAt).toBe(at);
  });
});

describe('what closes a popup unanswered', () => {
  it('a sheet that arrives: every popup closes, its work is aborted, its command is told, one notification says so', () => {
    const { host, notifications, openSettled } = rig();
    const closed = vi.fn();
    let signal: AbortSignal | undefined;
    openSettled(spec(), {
      control: (context) => {
        signal = context.signal;
      },
      closed,
    });
    host.input('r', {});
    host.sheetArrived();
    expect(host.getSnapshot().open).toBe(false);
    expect(signal?.aborted).toBe(true);
    expect(closed).toHaveBeenCalledWith('sheet');
    expect(notifications.getSnapshot().current?.text).toBe(
      '/test closed: a question needs your answer',
    );
  });

  it('a popup that throws (the error boundary, or a handler): it closes, and the host does not throw', () => {
    const { host, notifications, openSettled } = rig();
    const closed = vi.fn();
    openSettled(spec(), {
      enter: () => {
        throw new Error('boom');
      },
      closed,
    });
    expect(() => host.input('', ENTER)).not.toThrow();
    expect(host.getSnapshot().open).toBe(false);
    expect(closed).toHaveBeenCalledWith('error');
    expect(notifications.getSnapshot().current?.text).toBe('/test closed: it could not be shown');
  });

  it('a resize below the floor closes a step that holds a chord or a secret, and leaves any other step to its notice', () => {
    const chord = rig();
    chord.openSettled(spec({ steps: [{ ...LIST, holds: 'chord' }] }));
    chord.host.resized(100, 30);
    expect(chord.host.getSnapshot().open).toBe(true);
    chord.host.resized(79, 24);
    expect(chord.host.getSnapshot().open).toBe(false);
    expect(chord.notifications.getSnapshot().current?.text).toContain('nothing was answered');
    const plain = rig();
    plain.openSettled();
    plain.host.resized(60, 20);
    expect(plain.host.getSnapshot().open).toBe(true);
  });
});

describe('late results (ADR-0148 §2)', () => {
  it('a result for a popup that is closed or replaced lands nowhere', () => {
    const { host, openSettled } = rig();
    let first: PopupContext | undefined;
    openSettled(spec(), {
      control: (context) => {
        first = context;
      },
    });
    host.input('r', {});
    host.input('', ESC);
    host.openForUser(
      spec({ id: 'second', steps: [{ ...LIST, content: { kind: 'loading', what: 'Waiting' } }] }),
    );
    const before = host.getSnapshot();
    expect(first?.setContent(0, { kind: 'empty', what: 'late', next: 'nothing' })).toBe(false);
    expect(first?.goToStep(0)).toBe(false);
    expect(host.getSnapshot()).toBe(before);
    expect(currentStep(host.getSnapshot().frame ?? fail()).state.content.kind).toBe('loading');
  });

  it('a result for the popup that is open lands in its step', () => {
    const { host, openSettled } = rig();
    let context: PopupContext | undefined;
    // The context is taken from a control on a step that can answer (a loading step answers nothing: its keys do not act, ADR-0148 §5), and
    // the step is then put in its loading state, as a command that starts a load does.
    openSettled(spec(), {
      control: (c) => {
        context = c;
      },
    });
    host.input('r', {});
    expect(context?.setContent(0, { kind: 'loading', what: 'x' })).toBe(true);
    expect(
      context?.setContent(0, { kind: 'empty', what: 'Nothing here.', next: 'Try again.' }),
    ).toBe(true);
    expect(currentStep(host.getSnapshot().frame ?? fail()).state.content.kind).toBe('empty');
  });
});

describe('a result that brings the letters its step answers to (MVP-11 step 4b)', () => {
  const BARE: PopupStep = { name: 'Report', content: { kind: 'report', lines: ['one'] } };

  it('lands them with the content, so the letter reaches the command and the legend names it, and a late result lands none', () => {
    const { host, time } = rig();
    const controls: string[] = [];
    let context: PopupContext | undefined;
    const opened = host.openForUser(spec({ steps: [BARE] }), {
      control: (_context, key) => {
        controls.push(key);
      },
    });
    expect(opened.opened).toBe(true);
    if (opened.opened) context = opened.context;
    host.shown(host.getSnapshot());
    time.advance(600);
    // Before the content brings it, the letter is nothing.
    host.input('r', {});
    expect(controls).toEqual([]);
    expect(
      context?.setContent(0, { kind: 'report', lines: ['two'] }, [{ key: 'r', verb: 'again' }]),
    ).toBe(true);
    host.input('r', {});
    expect(controls).toEqual(['r']);
    expect(currentStep(host.getSnapshot().frame ?? fail()).spec.controls).toEqual([
      { key: 'r', verb: 'again' },
    ]);
    // `[]` takes it away again.
    context?.setContent(0, { kind: 'report', lines: ['three'] }, []);
    host.input('r', {});
    expect(controls).toEqual(['r']);
    // The popup closes; the same context lands nothing, controls included.
    host.input('', ESC);
    expect(context?.setContent(0, BARE.content, [{ key: 'r', verb: 'again' }])).toBe(false);
  });
});

describe('a stack of depth two (ADR-0148 §5)', () => {
  function withChild() {
    const r = rig();
    let opener: PopupContext | undefined;
    const openerClosed = vi.fn();
    r.openSettled(spec({ id: 'opener', title: '/doctor' }), {
      control: (context) => {
        opener = context;
      },
      closed: openerClosed,
    });
    r.host.input('', DOWN);
    r.host.input('r', {});
    const childEnter = vi.fn();
    const childClosed = vi.fn();
    const child: { context?: PopupContext } = {};
    const result = opener?.openChild(spec({ id: 'child', title: '/providers' }), {
      enter: childEnter,
      control: (context) => {
        child.context = context;
      },
      closed: childClosed,
    });
    return { ...r, opener, openerClosed, childEnter, childClosed, child, result };
  }

  it('a child is a new frame with its own run and its own opening guard (settle time)', () => {
    const { host, result, childEnter, show, time } = withChild();
    expect(result?.opened).toBe(true);
    expect(host.getSnapshot().depth).toBe(2);
    expect(host.getSnapshot().frame?.spec.id).toBe('child');
    show();
    time.advance(100);
    host.input('', ENTER);
    expect(childEnter, 'the child’s own settle').not.toHaveBeenCalled();
    time.advance(500);
    host.input('', ENTER);
    expect(childEnter).toHaveBeenCalledTimes(1);
  });

  it('Esc on the child returns to its opener with the opener’s state intact; the child’s work is aborted', () => {
    const { host, childClosed, openerClosed } = withChild();
    host.input('', ESC);
    expect(childClosed).toHaveBeenCalledWith('escape');
    expect(openerClosed).not.toHaveBeenCalled();
    expect(host.getSnapshot().depth).toBe(1);
    expect(host.getSnapshot().frame?.spec.id).toBe('opener');
    expect(currentStep(host.getSnapshot().frame ?? fail()).state.selected).toBe(1);
  });

  it('Ctrl+C closes the whole stack', () => {
    const { host, childClosed, openerClosed } = withChild();
    host.input('c', { ctrl: true });
    expect(host.getSnapshot().open).toBe(false);
    expect(childClosed).toHaveBeenCalledWith('interrupt');
    expect(openerClosed).toHaveBeenCalledWith('interrupt');
  });

  it('the depth is two: a third is refused and says so, and an opener under its child cannot open another', () => {
    const { host, notifications, show, time, child, opener } = withChild();
    show();
    time.advance(600);
    host.input('r', {});
    const grandchild = child.context?.openChild(spec({ id: 'third', title: '/third' }));
    expect(grandchild).toEqual({ opened: false, reason: 'depth' });
    expect(notifications.getSnapshot().current?.text).toBe(refusedOpenText('/third', 'depth'));
    expect(opener?.openChild(spec({ id: 'sibling' }))).toEqual({
      opened: false,
      reason: 'popup-open',
    });
    expect(host.getSnapshot().depth).toBe(2);
    expect(host.getSnapshot().frame?.spec.id).toBe('child');
  });
});

describe('the loading clock is a display value, not a field of the snapshot (ADR-0147 §2)', () => {
  const LOADING: PopupStep = { name: 'Check', content: { kind: 'loading', what: 'Checking' } };

  it('a thousand ticks leave the snapshot the same reference, and the clock wakes at most once a second', () => {
    const { host, time, show } = rig();
    host.openForUser(spec({ steps: [LOADING] }));
    show();
    const snapshot = host.getSnapshot();
    let heard = 0;
    host.clock.subscribe(() => {
      heard += 1;
    });
    for (let tick = 0; tick < 1000; tick += 1) time.advance(80);
    expect(host.getSnapshot()).toBe(snapshot);
    // 80 s of loading: a text that changes once a second from 5 s on, never at the frame rate
    expect(heard).toBeGreaterThan(70);
    expect(heard).toBeLessThanOrEqual(80);
    expect(host.clock.read()).toBe('80 s');
  });

  it('says nothing for the first five seconds', () => {
    const { host, time } = rig();
    host.openForUser(spec({ steps: [LOADING] }));
    time.advance(4999);
    expect(host.clock.read()).toBeUndefined();
    time.advance(1001);
    expect(host.clock.read()).toBe('6 s');
  });

  it('runs no timer inline (nothing repaints on a timer there) and none once the popup closes', () => {
    const inline = rig({ placement: 'replace' });
    inline.host.openForUser(spec({ steps: [LOADING] }));
    expect(inline.time.live()).toBe(0);
    const overlay = rig();
    overlay.host.openForUser(spec({ steps: [LOADING] }));
    expect(overlay.time.live()).toBe(1);
    overlay.host.input('', ESC);
    expect(overlay.time.live()).toBe(0);
  });
});

describe('a paste', () => {
  it('goes into a filter line, as one sanitised line, and nowhere on a step without one', () => {
    const { host, openSettled } = rig();
    openSettled(spec({ steps: [{ ...LIST, filter: true }] }));
    host.paste('tw\u001b[31mo\nx');
    expect(currentStep(host.getSnapshot().frame ?? fail()).state.filter).toBe('two x');
    const plain = rig();
    plain.openSettled();
    expect(plain.host.paste('abc')).toBe(true);
    expect(currentStep(plain.host.getSnapshot().frame ?? fail()).state.filter).toBe('');
  });
});

describe('dispose', () => {
  it('closes what is open, tells its command, and takes no key afterwards', () => {
    const { host, openSettled } = rig();
    const closed = vi.fn();
    openSettled(spec(), { closed });
    host.dispose();
    expect(closed).toHaveBeenCalledWith('dispose');
    expect(host.input('', ENTER)).toBe(false);
    expect(host.openForUser(spec())).toEqual({ opened: false, reason: 'closed' });
  });
});

function fail(): never {
  throw new Error('expected an open popup');
}

// ---- MVP-11 step 4, review round 1 -----------------------------------------------------------------------------------------------

/** A confirmation line answered by `Ctrl+Y`, reached from a list (its `back`), with a report long enough to scroll on a one-row page. */
const LINE_STEP: PopupStep = {
  name: 'Confirm',
  content: {
    kind: 'report',
    lines: ['Sends one request to:', '  https://a.example', 'Nothing else.'],
  },
  back: 0,
  holds: 'chord',
  chord: { verb: 'send' },
};
const lineSpec = (over: Partial<PopupSpec> = {}): PopupSpec =>
  spec({ steps: [{ ...LIST, controls: [{ key: 'd', verb: 'arm' }] }, LINE_STEP], ...over });
const CTRL_Y = { ctrl: true } as const;

describe('which keys are resolutions on the host’s key history (ADR-0148 §2)', () => {
  it('Esc that closes and Ctrl+C that closes the stack are; a control letter is not (it resolves nothing)', () => {
    for (const [input, key, resolves] of [
      ['', ESC, true],
      ['c', { ctrl: true }, true],
      ['r', {}, false],
    ] as const) {
      const r = rig();
      r.openSettled(spec(), { control: () => undefined });
      const before = r.history.lastResolvedAt;
      const at = r.time.now();
      r.host.input(input, key);
      expect(r.history.lastResolvedAt, `${input} ${JSON.stringify(key)}`).toBe(
        resolves ? at : before,
      );
    }
  });

  it('a paste is a foreign key on it', () => {
    const r = rig();
    r.openSettled();
    const at = r.time.now();
    r.host.paste('abc');
    expect(r.history.lastForeignKeyAt).toBe(at);
  });

  it('an answered Ctrl+Y is a resolution on the SHARED history (the line’s guard writes the host’s, not one of its own)', () => {
    const r = rig();
    const chord = vi.fn();
    r.openSettled(lineSpec({ initialStep: 1 }), { chord });
    r.show();
    r.time.advance(900);
    const at = r.time.now();
    r.host.input('y', CTRL_Y);
    expect(chord).toHaveBeenCalledOnce();
    expect(r.history.lastResolvedAt).toBe(at);
  });
});

describe('a scroll of a confirmation line is not a step change (ADR-0148 §3)', () => {
  it('fires no stepChanged, keeps the line armed, and a later Ctrl+Y still answers', () => {
    const r = rig();
    const chord = vi.fn();
    const stepChanged = vi.fn();
    r.openSettled(lineSpec({ initialStep: 1 }), { chord, stepChanged });
    r.host.bindPageRows(() => 1);
    r.show();
    r.time.advance(100);
    const before = r.host.getSnapshot();
    r.host.input('', DOWN);
    expect(r.host.getSnapshot()).not.toBe(before);
    expect(currentStep(r.host.getSnapshot().frame ?? fail()).state.offset).toBe(1);
    expect(stepChanged).not.toHaveBeenCalled();
    r.show();
    r.time.advance(800);
    r.host.input('y', CTRL_Y);
    expect(chord).toHaveBeenCalledOnce();
  });

  it('does not re-arm the line: a Ctrl+Y counted on it before the scroll still refuses the answer as typed', () => {
    const r = rig();
    const chord = vi.fn();
    const chordRefused = vi.fn();
    let context: PopupContext | undefined;
    const opened = r.host.openForUser(
      lineSpec({
        initialStep: 1,
        steps: [
          LIST,
          {
            ...LINE_STEP,
            content: { kind: 'empty', what: 'Nothing to confirm.', next: 'Esc goes back.' },
          },
        ],
      }),
      { chord, chordRefused },
    );
    if (opened.opened) context = opened.context;
    r.show();
    r.time.advance(600);
    // On a line with nothing to confirm a Ctrl+Y answers nothing and the line stays: it is counted as a key on the line.
    r.host.input('y', CTRL_Y);
    expect(currentStep(r.host.getSnapshot().frame ?? fail()).state.content.kind).toBe('empty');
    expect(r.host.getSnapshot().frame?.stepIndex).toBe(1);
    // The line now has something to confirm (a command's late result), and is scrolled.
    context?.setContent(1, LINE_STEP.content);
    r.host.bindPageRows(() => 1);
    r.show();
    r.time.advance(100);
    r.host.input('', DOWN);
    r.show();
    r.time.advance(2400);
    r.host.input('y', CTRL_Y);
    expect(chord).not.toHaveBeenCalled();
    expect(chordRefused).toHaveBeenCalledWith(expect.anything(), 'typed');
  });
});

describe('a stack of depth two closes as one (ADR-0148 §2, §5; cannot arise in the product before unit 6)', () => {
  function stacked() {
    const r = rig();
    const closed: string[] = [];
    const opened = r.host.openForUser(spec({ title: '/parent' }), {
      closed: (why) => closed.push(`parent:${why}`),
    });
    if (!opened.opened) throw new Error('open');
    const child = opened.context.openChild(spec({ id: 'child', title: '/child' }), {
      closed: (why) => closed.push(`child:${why}`),
    });
    expect(child.opened).toBe(true);
    return { ...r, closed, opener: opened.context };
  }

  it('a sheet arriving closes the child, then its opener, and names the opener', () => {
    const r = stacked();
    r.host.sheetArrived();
    expect(r.host.getSnapshot().open).toBe(false);
    expect(r.closed).toEqual(['child:sheet', 'parent:sheet']);
    expect(r.notifications.getSnapshot().current?.text).toBe(
      '/parent closed: a question needs your answer',
    );
  });

  it('a popup that throws closes the whole stack, not only the child', () => {
    const r = stacked();
    r.host.fail(new Error('x'));
    expect(r.host.getSnapshot().open).toBe(false);
    expect(r.closed).toEqual(['child:error', 'parent:error']);
  });

  it('the opener closing itself (its own context) takes its child with it', () => {
    const r = stacked();
    r.opener.close();
    expect(r.host.getSnapshot().open).toBe(false);
    expect(r.closed).toEqual(['child:command', 'parent:command']);
  });
});

describe('the opening and the frame acknowledgement', () => {
  it('a shown() for a snapshot that was replaced starts nothing: the new popup is not on screen yet', () => {
    const r = rig();
    const enter = vi.fn();
    r.host.openForUser(spec());
    const stale = r.host.getSnapshot();
    r.host.closeAll('command');
    r.host.openForUser(spec({ id: 'second' }), { enter });
    r.host.shown(stale);
    r.time.advance(600);
    r.host.input('', DOWN);
    r.host.input('', ENTER);
    expect(currentStep(r.host.getSnapshot().frame ?? fail()).state.selected).toBe(0);
    expect(enter).not.toHaveBeenCalled();
  });

  it('a result for a step that does not exist lands nowhere', () => {
    const r = rig();
    const opened = r.host.openForUser(spec());
    if (!opened.opened) throw new Error('open');
    const before = r.host.getSnapshot();
    expect(opened.context.setContent(1, { kind: 'loading', what: 'x' })).toBe(false);
    expect(opened.context.setContent(-1, { kind: 'loading', what: 'x' })).toBe(false);
    expect(opened.context.goToStep(1)).toBe(false);
    expect(opened.context.goToStep(-1)).toBe(false);
    expect(r.host.getSnapshot()).toBe(before);
    // The last step that exists does take one.
    expect(opened.context.setContent(0, { kind: 'loading', what: 'x' })).toBe(true);
  });

  it('a second open says why, in one notification', () => {
    const r = rig();
    r.host.openForUser(spec({ title: '/one' }));
    r.host.openForUser(spec({ id: 'two', title: '/two' }));
    expect(r.notifications.getSnapshot().current?.text).toBe(
      '/two cannot open now: another popup is open',
    );
  });

  it('the loading clock wakes its listeners only when its text changed (nothing for the first five seconds)', () => {
    const r = rig();
    r.host.openForUser(spec({ steps: [{ name: 'L', content: { kind: 'loading', what: 'w' } }] }));
    let wakes = 0;
    r.host.clock.subscribe(() => {
      wakes += 1;
    });
    r.time.advance(4000);
    expect(wakes).toBe(0);
    r.time.advance(2000);
    expect(wakes).toBe(2);
  });
});

describe('a paste into a filter (ADR-0148 §3)', () => {
  it('is one line of at most 200 characters (the limit, pinned by its number)', () => {
    expect(PASTE_LIMIT).toBe(200);
    const r = rig();
    r.openSettled(spec({ steps: [{ ...LIST, filter: true }] }));
    r.host.paste(`a\n\tb${'x'.repeat(300)}`);
    const filter = currentStep(r.host.getSnapshot().frame ?? fail()).state.filter;
    expect(filter).toHaveLength(200);
    expect(filter.startsWith('a b')).toBe(true);
  });

  it('is dropped while the frame is not on screen', () => {
    const r = rig();
    r.openSettled(spec({ steps: [{ ...LIST, filter: true }] }));
    r.hide();
    r.host.paste('abc');
    expect(currentStep(r.host.getSnapshot().frame ?? fail()).state.filter).toBe('');
  });
});

describe('dispose tears the host down first (MVP-11 step 4 review)', () => {
  it('a close hook that opens a popup during the teardown is refused, and nothing is left open or ticking', () => {
    const r = rig();
    const reopened: unknown[] = [];
    r.openSettled(spec({ steps: [{ name: 'L', content: { kind: 'loading', what: 'w' } }] }), {
      closed: () => {
        reopened.push(r.host.openForUser(spec({ id: 'again' })));
      },
    });
    r.host.dispose();
    expect(reopened).toEqual([{ opened: false, reason: 'closed' }]);
    expect(r.host.getSnapshot().open).toBe(false);
    expect(r.time.live()).toBe(0);
  });
});

describe('the host’s notification, drawn in the open popup’s legend row (MVP-11 step 4 review)', () => {
  it('is part of the snapshot: a notification that comes is a new frame, and one that goes is another', () => {
    const r = rig();
    r.openSettled();
    const plain = r.host.getSnapshot();
    expect(plain.notice).toBeUndefined();
    r.notifications.notify('Test report: sent 12 characters to the terminal clipboard.');
    const noticed = r.host.getSnapshot();
    expect(noticed).not.toBe(plain);
    expect(noticed.notice).toBe('Test report: sent 12 characters to the terminal clipboard.');
    expect(noticed.frame).toBe(plain.frame);
    r.time.advance(NOTIFICATION_MS);
    expect(r.host.getSnapshot().notice).toBeUndefined();
    expect(r.host.getSnapshot()).not.toBe(noticed);
  });

  it('every field of an open snapshot is identity; the list is closed (a new field needs a decision)', () => {
    const r = rig();
    r.openSettled(spec(), {
      control: (context) => {
        context.openChild(spec({ id: 'child', title: '/child' }));
      },
    });
    const keys = Object.keys(r.host.getSnapshot()).sort();
    expect(keys).toEqual(['depth', 'frame', 'notice', 'open', 'placement']);
    // `frame`: a move; `notice`: a notification; `depth` (and `frame`): a child; `open`: closing. `placement` is the host's, fixed for its life.
    const first = r.host.getSnapshot();
    r.host.input('', DOWN);
    const moved = r.host.getSnapshot();
    expect(moved).not.toBe(first);
    expect(moved.frame).not.toBe(first.frame);
    r.notifications.notify('a notice');
    const noticed = r.host.getSnapshot();
    expect(noticed).not.toBe(moved);
    r.host.input('r', {});
    expect(r.host.getSnapshot().depth).toBe(2);
    expect(r.host.getSnapshot()).not.toBe(noticed);
    r.host.closeAll('command');
    expect(r.host.getSnapshot().open).toBe(false);
  });

  it('a line still being prepared lets a notification through; once it offers its answer, the notification leaves the frame (held)', () => {
    const r = rig();
    const chord = vi.fn();
    let context: PopupContext | undefined;
    const opened = r.host.openForUser(
      lineSpec({
        initialStep: 1,
        steps: [LIST, { ...LINE_STEP, content: { kind: 'loading', what: 'Reading' } }],
      }),
      { chord },
    );
    if (opened.opened) context = opened.context;
    r.show();
    r.time.advance(600);
    // While the line is being prepared the channel is not held: a notification shows in the legend row.
    r.notifications.notify('something happened');
    expect(r.host.getSnapshot().notice).toBe('something happened');
    // The line lands: it offers an answer, so the channel is held and the notification leaves the frame at the same moment.
    context?.setContent(1, LINE_STEP.content);
    expect(r.host.getSnapshot().notice).toBeUndefined();
    expect(r.notifications.getSnapshot()).toMatchObject({ held: true, queued: 1 });
  });

  it('is held while the step offers a chord answer or holds a secret, and below the floor; let through otherwise', () => {
    const r = rig();
    r.openSettled(spec({ steps: [{ ...LIST, holds: 'secret' }] }));
    r.notifications.notify('held back');
    expect(r.notifications.getSnapshot().held).toBe(true);
    expect(r.host.getSnapshot().notice).toBeUndefined();
    r.host.closeAll('command');
    expect(r.notifications.getSnapshot().current?.text).toBe('held back');
    const below = rig();
    below.openSettled();
    below.host.resized(79, 24);
    below.notifications.notify('not drawn');
    expect(below.notifications.getSnapshot().held).toBe(true);
    below.host.resized(80, 24);
    expect(below.host.getSnapshot().notice).toBe('not drawn');
  });
});

describe('what the host says fits one row of the popup at the floor (MVP-11 step 4 review)', () => {
  const REFUSALS = [
    'turn-running',
    'card-open',
    'sheet-open',
    'armed',
    'starting',
    'overlay-open',
    'popup-open',
    'depth',
    'closed',
  ] as const;
  const TITLES = [
    '/doctor',
    '/cost',
    '/agent',
    '/workflows',
    '/help',
    '/permissions',
    'Test report',
  ];

  it('every refusal and every closing text of every popup title, at most POPUP_NOTICE_MAX_COLUMNS (66) columns', () => {
    expect(POPUP_NOTICE_MAX_COLUMNS).toBe(66);
    for (const title of TITLES) {
      for (const reason of REFUSALS) {
        const text = refusedOpenText(title, reason);
        expect(displayWidth(text), text).toBeLessThanOrEqual(POPUP_NOTICE_MAX_COLUMNS);
        expect(text.startsWith(title), text).toBe(true);
      }
      for (const reason of ['sheet', 'error', 'resize'] as const) {
        const text = closedUnansweredText(title, reason);
        expect(displayWidth(text), text).toBeLessThanOrEqual(POPUP_NOTICE_MAX_COLUMNS);
        expect(text.startsWith(title), text).toBe(true);
      }
    }
  });

  it('a title too long for the row is cut first, with the ellipsis; the words that say why stay whole', () => {
    const title = `/${'x'.repeat(100)}`;
    const text = closedUnansweredText(title, 'resize');
    expect(displayWidth(text)).toBe(POPUP_NOTICE_MAX_COLUMNS);
    expect(text.endsWith('… closed: terminal too small, nothing was answered')).toBe(true);
    const refused = refusedOpenText(title, 'card-open');
    expect(displayWidth(refused)).toBe(POPUP_NOTICE_MAX_COLUMNS);
    expect(refused.endsWith('… cannot open now: a card is waiting for your answer')).toBe(true);
  });
});
