/**
 * A form settles on its own frame ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §3;
 * MVP-11 step 5, F1; `popup-host.ts`, "A form settles on its own frame"). The opening guard runs once per popup, so a form reached by a step
 * would otherwise take an `Enter` the moment it is drawn: `/mode`'s `↓↓↓ Enter Enter` typed fast would widen the session to `auto` before the
 * effect step 2 states had been on screen. The host holds a form's `Enter` until the opening guard's settle (500 ms) has passed since THAT
 * frame was acknowledged whole: a too-early `Enter` is dropped without a word and is no resolution; the first step's `Enter`, the navigation
 * keys and `Esc` act as before; a new frame of the form starts the settle again, and a re-acknowledgement of the same frame does not. Every
 * case runs at the real opening-guard timings (no `settleMs` override), and through the host, so it holds for `/mode` and `/models` alike.
 *
 * A form's `Enter` has a second clock: the approval's lockout after the answer that reached it (`APPROVAL_LOCKOUT_MS`, 2 s), which is what stops a
 * held `Enter`'s FIRST repeat (it comes after the terminal's initial repeat delay, longer than the settle and the quiet gap) from applying what
 * the press before it only opened. Where a case is about the settle, the slot is slow or the person has read the form for the lockout first, so
 * the settle alone decides; `F2` holds the lockout itself, across the initial delays real keyboards have.
 */
import type { ChatMode } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { createChordHistory } from '../render/tui/chord-guard.js';
import { APPROVAL_LOCKOUT_MS, APPROVAL_QUIET_MS } from '../render/tui/tool-review-model.js';
import { manualClock } from './doctor.test-support.js';
import { modeScopeForm, SCOPE_STEP } from './mode-popup.js';
import { fakeModels, modelsRig, OPENAI } from './models.test-support.js';
import { createNotificationChannel } from './notifications.js';
import { POPUP_SELECT_SETTLE_MS } from './opening-guard.js';
import { createPopupHost } from './popup-host.js';
import type { PopupFormValues, PopupKey, PopupSpec } from './popup-reducer.js';
import type { ModeSettingsPort } from './settings-port.js';
import { openSettingsPopup } from './settings-session.js';

const ENTER: PopupKey = { return: true };
const DOWN: PopupKey = { downArrow: true };
const UP: PopupKey = { upArrow: true };
const ESC: PopupKey = { escape: true };
const RIGHT: PopupKey = { rightArrow: true };

/** The frame of a host a moment after it was drawn: a slot acknowledges it about one frame (16 ms) later. */
const FRAME_MS = 16;

/**
 * A popup host at the REAL timings (its settle is the opening guard's default), on a manual clock, with its key history exposed. The test is
 * the slot: `ack` says the frame drawn now was measured and flushed.
 */
function rig() {
  const clock = manualClock();
  const history = createChordHistory();
  const notifications = createNotificationChannel({ schedule: clock.schedule });
  const host = createPopupHost({
    now: clock.now,
    schedule: clock.schedule,
    notifications,
    history,
    placement: 'overlay',
  });
  let page = 17;
  host.bindVisibility(() => true);
  host.bindOpenGate(() => undefined);
  host.bindPageRows(() => page);
  host.bindInnerWidth(() => 66);
  return {
    host,
    clock,
    history,
    notifications,
    ack: (): void => host.shown(host.getSnapshot()),
    press: (key: PopupKey): boolean => host.input('', key),
    step: (): number | undefined => host.getSnapshot().frame?.stepIndex,
    open: (): boolean => host.getSnapshot().open,
    setPage: (rows: number): void => {
      page = rows;
    },
  };
}

/** `/mode` opened over a fake member, in force `auto` (its last row): every apply and hand-off recorded. */
function modeOver(r: ReturnType<typeof rig>) {
  const applied: ChatMode[] = [];
  const saved: ChatMode[] = [];
  const member: ModeSettingsPort = {
    // In force `auto`: its `Enter` on step 1 reaches the `auto` form, the one that widens authority and is guarded (`PopupForm.guarded`).
    current: () => 'auto',
    apply: (mode) => {
      applied.push(mode);
      return true;
    },
    saveStartupDefault: (mode) => {
      saved.push(mode);
      return Promise.resolve({ kind: 'unchanged' });
    },
  };
  const opened = openSettingsPopup({
    host: r.host,
    port: { surface: 'standalone-chat', announce: () => {}, mode: member },
    command: 'mode',
    origin: 'chat',
  });
  expect(opened.opened).toBe(true);
  return { applied, saved };
}

/** `/mode` open and its first frame seen at t = 0, the opening guard's settle passed: step 1 answers from here. */
function settledMode() {
  const r = rig();
  const mode = modeOver(r);
  r.ack();
  r.clock.advance(POPUP_SELECT_SETTLE_MS);
  return { r, mode };
}

describe('`↓↓↓ Enter Enter` on `/mode` at the real timings', () => {
  it('typed in one go: step 1’s `Enter` advances at once, and the chain never applies step 2 (its frame not yet seen, then its settle and the quiet gap)', () => {
    const { r, mode } = settledMode();
    r.press(DOWN);
    r.press(DOWN);
    r.press(DOWN); // ask → auto
    r.press(ENTER);
    expect(r.step()).toBe(SCOPE_STEP); // the first step's `Enter` is not held back
    const resolvedByStep1 = r.history.lastResolvedAt;
    r.press(ENTER); // in the same read: step 2 is drawn but not acknowledged yet
    r.clock.advance(FRAME_MS);
    r.ack();
    r.press(ENTER); // the chain's next `Enter`, the moment step 2 appeared
    expect(mode.applied).toEqual([]);
    expect(r.open()).toBe(true);
    // Dropped as the opening guard drops a key, with no word; inside the lockout it restarts it (the chain's `Enter` is the last answer now).
    expect(r.notifications.getSnapshot().current).toBeUndefined();
    expect(r.history.lastResolvedAt).toBeGreaterThan(resolvedByStep1);
    expect(r.history.lastResolvedAt).toBe(r.clock.now());
  });

  // One press after step 2's frame was seen, at an offset from that acknowledgement. The slot is slow here on purpose (it acknowledges the
  // frame the lockout after the last answer), so the press is clear of the quiet gap and the lockout and the form's settle alone decides.
  it.each([
    [0, false],
    [POPUP_SELECT_SETTLE_MS - 1, false],
    [POPUP_SELECT_SETTLE_MS, true],
  ] as const)(
    'step 2’s `Enter` at +%i ms after its frame was seen applies: %s (no word and no resolution when it does not)',
    (offset, applies) => {
      const { r, mode } = settledMode();
      r.press(DOWN);
      r.press(DOWN);
      r.press(DOWN); // ask → auto
      r.press(ENTER);
      r.press(ENTER); // the chain's second `Enter`, before step 2 was seen
      const resolvedByStep1 = r.history.lastResolvedAt;
      r.clock.advance(APPROVAL_LOCKOUT_MS);
      r.ack();
      r.clock.advance(offset);
      r.press(ENTER);
      expect(mode.applied).toEqual(applies ? ['auto'] : []);
      expect(r.open()).toBe(!applies);
      expect(r.history.lastResolvedAt).toBe(applies ? r.clock.now() : resolvedByStep1);
      if (!applies) expect(r.notifications.getSnapshot().current).toBeUndefined();
    },
  );

  it('the settle counts from step 2’s own frame, not from the popup’s opening (which was long before)', () => {
    const { r, mode } = settledMode();
    r.clock.advance(10_000);
    r.press(ENTER); // the mode in force, on to step 2
    r.clock.advance(APPROVAL_LOCKOUT_MS); // a slow frame: the press below is clear of the lockout, the settle alone decides
    r.ack();
    r.clock.advance(1);
    r.press(ENTER);
    expect(mode.applied).toEqual([]);
    r.clock.advance(POPUP_SELECT_SETTLE_MS);
    r.press(ENTER);
    expect(mode.applied).toEqual(['auto']);
  });
});

describe('presses a quiet gap or more apart through step 1 into step 2', () => {
  // Slower than the quiet gap, a key's repeat is a press like any other for the gap (F5 holds the faster ones), so what holds it is the
  // lockout: an `Enter` refused inside it restarts it, so presses closer together than the lockout never apply, however many; the first press
  // a lockout after the one before it (and the settle of step 2's acknowledged frame after it was seen) applies, once.
  it.each([300, 400, 500, 750, 1000, 1999, 2000, 2500])(
    'pressed every %i ms: none applies while each is inside the lockout of the one before; one a lockout later does',
    (interval) => {
      const { r, mode } = settledMode();
      r.press(ENTER); // the press: step 1 → step 2
      expect(r.step()).toBe(SCOPE_STEP);
      const pressedAt = r.clock.now();
      const shownAt = pressedAt + FRAME_MS;
      let acked = false;
      let appliedAt: number | undefined;
      for (let at = pressedAt + interval; at <= pressedAt + 6000; at += interval) {
        if (!acked && at >= shownAt) {
          r.clock.advance(shownAt - r.clock.now());
          r.ack();
          acked = true;
        }
        r.clock.advance(at - r.clock.now());
        if (!r.open()) break;
        r.press(ENTER);
        if (mode.applied.length > 0 && appliedAt === undefined) appliedAt = at;
      }
      if (interval < APPROVAL_LOCKOUT_MS) {
        expect(appliedAt).toBeUndefined();
        expect(mode.applied).toEqual([]);
        expect(r.open()).toBe(true);
        // Let go: a press a lockout after the last one applies.
        r.clock.advance(APPROVAL_LOCKOUT_MS);
        r.press(ENTER);
        expect(mode.applied).toEqual(['auto']);
        return;
      }
      // A repeat every lockout or more is a press a lockout after the one before it: the first (after the settle) applies.
      const ready = Math.max(shownAt + POPUP_SELECT_SETTLE_MS, pressedAt + APPROVAL_LOCKOUT_MS);
      expect(appliedAt).toBe(Math.ceil((ready - pressedAt) / interval) * interval + pressedAt);
      expect(mode.applied).toEqual(['auto']);
    },
  );
});

describe('F5: a held key never applies a form (the quiet gap)', () => {
  // The key's repeat as a terminal sends it (a plain press), and as one that reports key events sends it (`eventType: 'repeat'`).
  const repeats: readonly (readonly [string, PopupKey])[] = [
    ['plain', ENTER],
    ['repeat', { return: true, eventType: 'repeat' }],
  ];

  it.each([30, 100, 250].flatMap((ms) => repeats.map(([kind, key]) => [ms, kind, key] as const)))(
    'a held `Enter` repeating every %i ms (%s) never applies step 2, even 5 s after its frame was seen',
    (interval, kind, repeat) => {
      const { r, mode } = settledMode();
      r.press(ENTER); // the press: step 1 → step 2
      expect(r.step()).toBe(SCOPE_STEP);
      const resolvedByStep1 = r.history.lastResolvedAt;
      const pressedAt = r.clock.now();
      const shownAt = pressedAt + FRAME_MS;
      let acked = false;
      for (let at = pressedAt + interval; at <= shownAt + 5000; at += interval) {
        if (!acked && at >= shownAt) {
          r.clock.advance(shownAt - r.clock.now());
          r.ack();
          acked = true;
        }
        r.clock.advance(at - r.clock.now());
        r.press(repeat);
      }
      expect(r.clock.now() - shownAt).toBeGreaterThanOrEqual(5000 - interval);
      expect(mode.applied).toEqual([]);
      expect(mode.saved).toEqual([]);
      expect(r.step()).toBe(SCOPE_STEP);
      // Said nothing; the held key's repeats were dropped as a key too soon is, and each restarted the lockout (the key held is the last answer).
      expect(r.notifications.getSnapshot().current).toBeUndefined();
      // (A repeat the terminal LABELS is no key at all to the popup: it never reaches the form, so it restarts nothing and needs nothing.)
      if (kind === 'plain') expect(r.history.lastResolvedAt).toBeGreaterThan(resolvedByStep1);
      else expect(r.history.lastResolvedAt).toBe(resolvedByStep1);
      // Let go, read for the lockout, press again: that press applies.
      r.clock.advance(APPROVAL_LOCKOUT_MS);
      r.press(ENTER);
      expect(mode.applied).toEqual(['auto']);
    },
  );

  it('a patient press applies: step 1’s `Enter`, the effect read, then `Enter`', () => {
    const { r, mode } = settledMode();
    r.press(ENTER);
    r.clock.advance(FRAME_MS);
    r.ack();
    r.clock.advance(2000);
    r.press(ENTER);
    expect(mode.applied).toEqual(['auto']);
  });

  it('a held `↓` and then `Enter` follows the same rule: refused within the gap of the last repeat, applied a quiet gap after it', () => {
    const { r, mode } = settledMode();
    r.press(ENTER);
    r.ack();
    r.clock.advance(APPROVAL_LOCKOUT_MS); // the form read, as a person reads it, before the arrow
    r.press(DOWN); // the first press of a held `↓`: new chats, a new frame of the form
    r.ack();
    for (let held = 0; held < 900; held += 30) {
      r.clock.advance(30);
      r.press(DOWN); // its repeats (at the last option now: nothing moves, no new frame)
    }
    r.clock.advance(30);
    r.press(ENTER); // 30 ms after the last repeat, the form's own frame long settled
    expect(r.open()).toBe(true);
    r.clock.advance(APPROVAL_QUIET_MS);
    r.press(ENTER); // a quiet gap after the key before it
    expect(r.open()).toBe(false); // new chats: closed and handed off
    expect(mode.applied).toEqual([]);
  });

  it.each([
    [APPROVAL_QUIET_MS - 1, false],
    [APPROVAL_QUIET_MS, true],
  ] as const)(
    'the boundary: an `Enter` %i ms after the key before it applies: %s',
    (gap, applies) => {
      const { r, mode } = settledMode();
      r.press(ENTER);
      r.ack();
      r.clock.advance(APPROVAL_LOCKOUT_MS); // settled and past the lockout; the key before the `Enter` below decides
      r.host.input('x', {}); // a key of any kind: a letter a form has no use for
      r.clock.advance(gap);
      r.press(ENTER);
      expect(mode.applied).toEqual(applies ? ['auto'] : []);
    },
  );

  it('a key of any kind counts: the composer’s key, on the host’s one history, inside the gap refuses the form’s `Enter`', () => {
    const { r, mode } = settledMode();
    r.press(ENTER);
    r.ack();
    r.clock.advance(APPROVAL_LOCKOUT_MS);
    // A key some other surface of the host stamped on the shared history (a card's, the composer's) just before.
    r.history.previousKeyAt = r.clock.now() - 10;
    r.press(ENTER);
    expect(mode.applied).toEqual([]);
  });
});

describe('F2: a held `Enter` never applies a form, whatever the terminal’s initial repeat delay (security round 1)', () => {
  // A held key does not repeat at once: the terminal waits its initial delay, then repeats at its rate. The delays real keyboards have: macOS
  // 225 ms to 1.8 s on its slider, Windows 250 ms to 1 s, X11 660 ms, KDE 600 ms. The first repeat is the dangerous key: it is as late as
  // a person's second press, so the quiet gap and the settle let it through; the lockout after the `Enter` that reached the form does not.
  const delays = [225, 375, 500, 520, 600, 660, 750, 1000, 1500, 1800] as const;
  const rates = [30, 40] as const;
  // As a terminal sends the repeat: a plain press (no key events), or one labelled `repeat` (key events reported).
  const kinds: readonly (readonly [string, PopupKey])[] = [
    ['plain', ENTER],
    ['repeat', { return: true, eventType: 'repeat' }],
  ];

  it.each(
    delays.flatMap((d) =>
      rates.flatMap((rate) => kinds.map(([kind, key]) => [d, rate, kind, key] as const)),
    ),
  )(
    'initial delay %i ms, rate %i ms (%s): the press opens step 2 and the repeats, however long, apply nothing',
    (delay, rate, _kind, repeat) => {
      const { r, mode } = settledMode();
      r.press(ENTER); // the press that reached step 2, which stays down
      expect(r.step()).toBe(SCOPE_STEP);
      const pressedAt = r.clock.now();
      r.clock.advance(FRAME_MS);
      r.ack();
      for (let at = pressedAt + delay; at <= pressedAt + delay + 4000; at += rate) {
        r.clock.advance(at - r.clock.now());
        r.press(repeat);
      }
      expect(mode.applied).toEqual([]);
      expect(mode.saved).toEqual([]);
      expect(r.open()).toBe(true);
      expect(r.step()).toBe(SCOPE_STEP);
      // Let go, and a deliberate press after the form was read applies, once.
      r.clock.advance(APPROVAL_LOCKOUT_MS);
      r.press(ENTER);
      expect(mode.applied).toEqual(['auto']);
    },
  );

  // A slow repeat RATE is an accessibility setting (Windows' slowest is about 400 ms, several macOS positions are 450 ms to 1.8 s, X11 and KDE
  // allow more): every repeat is slower than the quiet gap, so the gap catches none and the lockout alone holds the key. It holds because a
  // refused `Enter` inside it restarts it.
  const slowRates = [300, 400, 450, 900, 1800] as const;
  const slowDelays = [250, 375, 500, 600, 1000, 1800] as const;
  it.each(slowDelays.flatMap((d) => slowRates.map((rate) => [d, rate] as const)))(
    'initial delay %i ms, a repeat every %i ms: held for six seconds applies nothing, and a press a lockout after letting go applies once',
    (delay, rate) => {
      const { r, mode } = settledMode();
      r.press(ENTER); // the press that reached step 2, which stays down
      const pressedAt = r.clock.now();
      r.clock.advance(FRAME_MS);
      r.ack();
      for (let at = pressedAt + delay; at <= pressedAt + delay + 6000; at += rate) {
        r.clock.advance(at - r.clock.now());
        r.press(ENTER);
      }
      expect(mode.applied).toEqual([]);
      expect(r.open()).toBe(true);
      r.clock.advance(APPROVAL_LOCKOUT_MS);
      r.press(ENTER);
      expect(mode.applied).toEqual(['auto']);
    },
  );

  it('a press that is early restarts the wait: the person is told by nothing, and a press a lockout after it applies', () => {
    const { r, mode } = settledMode();
    r.press(ENTER); // step 1 → step 2
    r.clock.advance(FRAME_MS);
    r.ack();
    r.clock.advance(1200);
    r.press(ENTER); // too early: dropped, and the lockout runs from here now
    r.clock.advance(1500);
    r.press(ENTER); // 2.7 s after the form opened, 1.5 s after the early press: still inside
    expect(mode.applied).toEqual([]);
    r.clock.advance(APPROVAL_LOCKOUT_MS);
    r.press(ENTER);
    expect(mode.applied).toEqual(['auto']);
  });

  it('the delays are not special: the first repeat after any initial delay below the lockout is dropped, and the lockout is the cause', () => {
    // The delays that clear the settle (500 ms from the frame) and the quiet gap (300 ms) are the ones the lockout exists for.
    for (const delay of [520, 660, 1000, 1800, APPROVAL_LOCKOUT_MS - 1]) {
      const { r, mode } = settledMode();
      r.press(ENTER);
      r.clock.advance(FRAME_MS);
      r.ack();
      r.clock.advance(delay - FRAME_MS);
      r.press(ENTER); // the first repeat
      expect(mode.applied, `${delay} ms`).toEqual([]);
      // The refused repeat is inside the lockout and restarts it: the lockout now runs from it.
      expect(r.history.lastResolvedAt, `${delay} ms: the lockout restarted`).toBe(r.clock.now());
    }
    // At the lockout itself, with nothing held between, it is a deliberate press and applies.
    const { r, mode } = settledMode();
    r.press(ENTER);
    r.clock.advance(FRAME_MS);
    r.ack();
    r.clock.advance(APPROVAL_LOCKOUT_MS - FRAME_MS);
    r.press(ENTER);
    expect(mode.applied).toEqual(['auto']);
  });

  it.each([
    ['Shift+Enter', { return: true, shift: true }],
    ['Meta+Enter (`Esc` then `Enter` in one read)', { return: true, meta: true }],
    ['Ctrl+Enter', { return: true, ctrl: true }],
  ] as const)(
    '%s, long after the form was read, applies nothing; the plain `Enter` then does',
    (_name, key) => {
      const { r, mode } = settledMode();
      r.press(ENTER);
      r.clock.advance(FRAME_MS);
      r.ack();
      r.clock.advance(APPROVAL_LOCKOUT_MS * 2);
      r.press(key);
      expect(mode.applied).toEqual([]);
      expect(r.open()).toBe(true);
      r.clock.advance(APPROVAL_QUIET_MS);
      r.press(ENTER);
      expect(mode.applied).toEqual(['auto']);
    },
  );

  it('`/models` step 2 holds the same way: the first repeat after a 660 ms initial delay switches nothing', () => {
    const fake = fakeModels();
    const m = modelsRig(fake.member);
    m.open();
    m.settle();
    // Another provider's model: its form sends the conversation elsewhere, so it is guarded.
    for (let guard = 0; guard < 20 && m.step()?.highlighted !== OPENAI; guard += 1)
      m.press('', DOWN);
    expect(m.step()?.highlighted).toBe(OPENAI);
    m.press('', ENTER); // on to its form (a press that stays down)
    m.clock.advance(FRAME_MS);
    m.host.shown(m.host.getSnapshot());
    m.clock.advance(660 - FRAME_MS);
    for (let held = 0; held < 4000; held += 30) {
      m.press('', ENTER);
      m.clock.advance(30);
    }
    expect(m.host.getSnapshot().open).toBe(true);
    expect(m.announced).toEqual([]);
    expect(fake.switched).toEqual([]);
    expect(fake.tiers).toEqual([]);
  });
});

describe('a form that only narrows has the settle and the quiet gap, no lockout (PopupForm.guarded)', () => {
  /** `/mode` in force `plan`: its form for `plan` states no effect that approves anything and applies a narrowing. */
  function narrowing() {
    const r = rig();
    const applied: ChatMode[] = [];
    const member: ModeSettingsPort = {
      current: () => 'plan',
      apply: (mode) => {
        applied.push(mode);
        return true;
      },
      saveStartupDefault: () => Promise.resolve({ kind: 'unchanged' }),
    };
    const opened = openSettingsPopup({
      host: r.host,
      port: { surface: 'standalone-chat', announce: () => {}, mode: member },
      command: 'mode',
      origin: 'chat',
    });
    expect(opened.opened).toBe(true);
    r.ack();
    r.clock.advance(POPUP_SELECT_SETTLE_MS);
    return { r, applied };
  }

  it('applies as soon as it has settled and a quiet gap has passed: a person who read `plan` is not made to wait two seconds', () => {
    const { r, applied } = narrowing();
    r.press(ENTER); // step 1 → the form for `plan`
    expect(r.step()).toBe(SCOPE_STEP);
    r.clock.advance(FRAME_MS);
    r.ack();
    r.clock.advance(POPUP_SELECT_SETTLE_MS); // 516 ms after the `Enter` that reached it: inside what a guarded form waits
    r.press(ENTER);
    expect(applied).toEqual(['plan']);
  });

  it('still drops an `Enter` inside its settle or its quiet gap, and a modified or repeated one', () => {
    const { r, applied } = narrowing();
    r.press(ENTER);
    r.clock.advance(FRAME_MS);
    r.ack();
    r.clock.advance(POPUP_SELECT_SETTLE_MS - 1);
    r.press(ENTER); // inside the settle
    r.clock.advance(APPROVAL_QUIET_MS - 1);
    r.press(ENTER); // inside the quiet gap of the key before it
    r.press({ return: true, meta: true });
    r.press({ return: true, eventType: 'repeat' });
    expect(applied).toEqual([]);
    expect(r.open()).toBe(true);
  });

  it('a form for `auto` is guarded and one for `accept-edits` too; `plan` and `ask` are not; `/models` is guarded when the provider changes', () => {
    expect(modeScopeForm('auto').guarded).toBe(true);
    expect(modeScopeForm('accept-edits').guarded).toBe(true);
    expect(modeScopeForm('ask').guarded).toBeUndefined();
    expect(modeScopeForm('plan').guarded).toBeUndefined();
  });
});

describe('the keys that are not a form’s answer act as before', () => {
  it('`↑/↓` move the radio and `Esc` steps back at once, inside step 2’s settle', () => {
    const { r, mode } = settledMode();
    r.press(ENTER);
    r.ack();
    r.clock.advance(1);
    r.press(DOWN);
    expect(r.host.getSnapshot().frame?.steps[SCOPE_STEP]?.selected).toBe(1);
    r.press(UP);
    expect(r.host.getSnapshot().frame?.steps[SCOPE_STEP]?.selected).toBe(0);
    r.press(ESC);
    expect(r.step()).toBe(0);
    expect(mode.applied).toEqual([]);
  });

  it('`←/→` move a form’s tabs at once, inside its settle (`/models` step 2)', () => {
    const fake = fakeModels();
    const m = modelsRig(fake.member);
    m.open();
    m.settle();
    m.press('', ENTER); // the model in force, on to its form
    m.host.shown(m.host.getSnapshot());
    m.clock.advance(1);
    m.press('', RIGHT);
    const frame = m.host.getSnapshot().frame;
    expect(frame?.steps[1]?.tab).toBeGreaterThan(0);
    expect(fake.tiers).toEqual([]);
  });
});

describe('what starts the settle again, and what does not', () => {
  it('a new frame of the form (a radio choice moved) starts it again from that frame', () => {
    const { r, mode } = settledMode();
    r.press(ENTER);
    r.ack();
    r.clock.advance(APPROVAL_LOCKOUT_MS); // the form read first
    r.press(DOWN); // new chats: a new frame of the form
    r.ack();
    r.clock.advance(POPUP_SELECT_SETTLE_MS - 1); // 499 ms after this frame (the `↓`'s), long after the first
    r.press(ENTER);
    expect(r.open()).toBe(true);
    r.clock.advance(APPROVAL_QUIET_MS); // a second press a quiet gap after the first (one inside it is a held key's repeat)
    r.press(ENTER);
    expect(r.open()).toBe(false);
    expect(mode.applied).toEqual([]); // new chats hands off; nothing applied here
  });

  it('the same frame acknowledged again (a resize that leaves the form whole) does not', () => {
    const { r, mode } = settledMode();
    r.press(ENTER);
    r.ack();
    r.clock.advance(APPROVAL_LOCKOUT_MS - 200);
    r.host.resized(100, 30);
    r.ack();
    r.clock.advance(300); // inside the settle of the re-acknowledged frame, past the lockout and the settle of the first
    r.press(ENTER);
    expect(mode.applied).toEqual(['auto']);
  });

  it('a terminal below the floor (no frame drawn at all) starts it again when the form is drawn again', () => {
    const { r, mode } = settledMode();
    r.press(ENTER);
    r.ack();
    r.clock.advance(APPROVAL_LOCKOUT_MS);
    r.host.resized(60, 20); // below the floor: a notice in place of the frame
    r.host.resized(80, 24);
    r.ack();
    r.clock.advance(1);
    r.press(ENTER);
    expect(mode.applied).toEqual([]);
    r.clock.advance(POPUP_SELECT_SETTLE_MS - 1);
    r.press(ENTER);
    expect(mode.applied).toEqual(['auto']);
  });

  it('a form acknowledged cut (its page too short) starts it again once it is acknowledged whole', () => {
    const { r, mode } = settledMode();
    r.press(ENTER);
    r.ack();
    r.clock.advance(APPROVAL_LOCKOUT_MS);
    r.setPage(3);
    r.ack(); // the same frame, acknowledged cut
    r.setPage(17);
    r.ack(); // whole again
    r.clock.advance(1);
    r.press(ENTER);
    expect(mode.applied).toEqual([]);
    r.clock.advance(POPUP_SELECT_SETTLE_MS - 1);
    r.press(ENTER);
    expect(mode.applied).toEqual(['auto']);
  });

  it('the form drawn again after a child popup over it closed starts it again', () => {
    const r = rig();
    const applied: PopupFormValues[] = [];
    const form: PopupSpec = {
      id: 'form',
      title: '/form',
      origin: 'chat',
      steps: [
        {
          name: 'Form',
          enter: 'apply',
          controls: [{ key: 'x', verb: 'more' }],
          content: {
            kind: 'form',
            radio: {
              label: 'Apply to',
              verb: 'apply to',
              options: [
                { id: 'a', label: 'A' },
                { id: 'b', label: 'B' },
              ],
            },
          },
        },
      ],
    };
    const child: PopupSpec = {
      id: 'child',
      title: '/child',
      origin: 'chat',
      steps: [{ name: 'More', content: { kind: 'report', lines: ['more'] } }],
    };
    r.host.openForUser(form, {
      apply: (_context, values) => applied.push(values),
      control: (context) => {
        context.openChild(child);
      },
    });
    r.ack();
    r.clock.advance(600);
    r.host.input('x', {}); // the child opens over the form
    r.ack();
    r.clock.advance(600);
    r.press(ESC); // back to the form: its frame is drawn again
    r.clock.advance(APPROVAL_LOCKOUT_MS); // a slow slot: the `Esc` that left the child (an answer) is clear of the lockout
    r.ack();
    r.clock.advance(1);
    r.press(ENTER);
    expect(applied).toEqual([]);
    r.clock.advance(POPUP_SELECT_SETTLE_MS - 1);
    r.press(ENTER);
    expect(applied).toEqual([{ radio: 'a' }]);
  });
});

describe('every form, through the host', () => {
  it('`/models` step 2 holds its `Enter` the same way: nothing at +0 or +499 ms after its frame was seen, applied by a press after its settle', () => {
    const fake = fakeModels();
    const m = modelsRig(fake.member);
    m.open();
    m.settle();
    m.press('', ENTER); // the model in force, on to its form
    expect(m.host.getSnapshot().frame?.stepIndex).toBe(1);
    m.clock.advance(APPROVAL_LOCKOUT_MS); // a slow frame: the presses below are clear of the lockout, the settle decides
    m.host.shown(m.host.getSnapshot());
    m.press('', ENTER); // +0
    m.clock.advance(POPUP_SELECT_SETTLE_MS - 1);
    m.press('', ENTER); // +499
    expect(m.host.getSnapshot().open).toBe(true);
    expect(m.announced).toEqual([]);
    m.clock.advance(APPROVAL_QUIET_MS);
    m.press('', ENTER); // +799, a quiet gap after the press before it
    expect(m.host.getSnapshot().open).toBe(false);
    expect(m.announced).toEqual(['Already at reasoning effort medium.']);
  });

  it('`/models` step 2: a held `Enter` (every 30 ms) never applies it, even 5 s after its frame was seen', () => {
    const fake = fakeModels();
    const m = modelsRig(fake.member);
    m.open();
    m.settle();
    m.press('', ENTER);
    m.host.shown(m.host.getSnapshot());
    for (let held = 0; held < 5000; held += 30) {
      m.clock.advance(30);
      m.press('', ENTER);
    }
    expect(m.host.getSnapshot().open).toBe(true);
    expect(m.announced).toEqual([]);
    expect(fake.tiers).toEqual([]);
    expect(fake.switched).toEqual([]);
  });
});
