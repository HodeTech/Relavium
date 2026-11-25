/**
 * Two requirements of a form's settle ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §3;
 * MVP-11 step 5; `popup-host.ts`, "A form settles on its own frame") that `popup-form-settle.test.ts` leaves open, found by the step-5 round-1
 * mutation sweep: a form whose frame the slot never acknowledged has no settle to wait out and applies nothing, however long it waits; and a
 * notification drawn in the legend row of a form is not a new frame of it, so it does not start the settle again. Both run through the real host
 * on a manual clock at the real opening-guard timings.
 */
import type { ChatMode } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { createChordHistory } from '../render/tui/chord-guard.js';
import { APPROVAL_LOCKOUT_MS } from '../render/tui/tool-review-model.js';
import { manualClock } from './doctor.test-support.js';
import { SCOPE_STEP } from './mode-popup.js';
import { createNotificationChannel } from './notifications.js';
import { POPUP_SELECT_SETTLE_MS } from './opening-guard.js';
import { createPopupHost } from './popup-host.js';
import type { PopupKey } from './popup-reducer.js';
import type { ModeSettingsPort } from './settings-port.js';
import { openSettingsPopup } from './settings-session.js';

const ENTER: PopupKey = { return: true };

/** `/mode` over a fake member in force `current`, on a host at the real timings; the test is the slot (`ack` says a frame was drawn and flushed). */
function rig(current: ChatMode) {
  const clock = manualClock();
  const notifications = createNotificationChannel({ schedule: clock.schedule });
  const host = createPopupHost({
    now: clock.now,
    schedule: clock.schedule,
    notifications,
    history: createChordHistory(),
    placement: 'overlay',
  });
  host.bindVisibility(() => true);
  host.bindOpenGate(() => undefined);
  host.bindPageRows(() => 17);
  host.bindInnerWidth(() => 66);
  const applied: ChatMode[] = [];
  const member: ModeSettingsPort = {
    current: () => current,
    apply: (mode) => {
      applied.push(mode);
      return true;
    },
    saveStartupDefault: () => Promise.resolve({ kind: 'unchanged' }),
  };
  const opened = openSettingsPopup({
    host,
    port: { surface: 'standalone-chat', announce: () => {}, mode: member },
    command: 'mode',
    origin: 'chat',
  });
  expect(opened.opened).toBe(true);
  const ack = (): void => host.shown(host.getSnapshot());
  // Step 1 seen and its settle passed: its `Enter` answers from here.
  ack();
  clock.advance(POPUP_SELECT_SETTLE_MS);
  return {
    applied,
    clock,
    notifications,
    ack,
    press: (key: PopupKey): boolean => host.input('', key),
    step: (): number | undefined => host.getSnapshot().frame?.stepIndex,
    open: (): boolean => host.getSnapshot().open,
  };
}

describe('a form whose frame was never acknowledged on screen', () => {
  // `auto` is the guarded form (it widens authority), `ask` the plain one: the rule holds for both, so it is not the lockout that holds the first.
  it.each(['ask', 'auto'] as const)(
    'a form in force %s applies nothing on `Enter`, however long it waits, and applies once it has been seen and has settled',
    (current) => {
      const r = rig(current);
      r.press(ENTER); // step 1 → step 2; the slot never acknowledges step 2's frame
      expect(r.step()).toBe(SCOPE_STEP);
      r.clock.advance(APPROVAL_LOCKOUT_MS + POPUP_SELECT_SETTLE_MS);
      r.press(ENTER); // far past the settle, the quiet gap and the lockout: but no frame of the form was ever drawn
      expect(r.applied).toEqual([]);
      expect(r.open()).toBe(true);
      // The same press once the frame was acknowledged and its settle passed: it applies, so the wait above was the only thing missing.
      r.ack();
      r.clock.advance(APPROVAL_LOCKOUT_MS);
      r.press(ENTER);
      expect(r.applied).toEqual([current]);
    },
  );
});

describe('a notification is not a new frame of a form', () => {
  it('one acknowledged 300 ms into the settle does not restart it: an `Enter` 500 ms after the frame was first seen applies', () => {
    const r = rig('ask');
    r.press(ENTER); // step 1 → step 2
    r.ack(); // the form seen: its settle runs from here
    r.clock.advance(300);
    r.notifications.notify('a notification');
    r.ack(); // the same form, now drawn with a notice in its legend row
    r.clock.advance(POPUP_SELECT_SETTLE_MS - 300);
    r.press(ENTER); // 500 ms after the form was first seen, 200 ms after the notice was
    expect(r.applied).toEqual(['ask']);
  });
});
