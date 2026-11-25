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
import { createNotificationChannel, type Schedule } from './notifications.js';
import {
  createPopupHost,
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
