/**
 * Why a `Ctrl+Y` did not count, in words ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2): the four phrases are written once, and the popups that own a confirmation line (the doctor's deep check, the cost release) build their
 * sentences around that one table, so no guard is worded two ways.
 */
import { describe, expect, it } from 'vitest';

import { APPROVAL_LOCKOUT_MS } from '../render/tui/tool-review-model.js';
import { displayWidth } from '../render/tui/viewport.js';
import { CHORD_REFUSAL_PHRASE } from './chord-refusal.js';
import { releaseRefusedText } from './cost-popup.js';
import { CTRL } from './doctor.test-support.js';
import { chordRefusedText } from './doctor-session.js';
import { POPUP_NOTICE_MAX_COLUMNS } from './geometry.js';
import type { ChordRefusal } from './popup-host.js';
import { fakeCost, reportRig, settleWork } from './report.test-support.js';

const REASONS = [
  'unseen',
  'early',
  'expired',
  'typed',
  'cut',
] as const satisfies readonly ChordRefusal[];

describe('the phrases', () => {
  it('are these words for the five guards of the host: a key that came before its frame was shown and one that came inside the dwell are both told `too soon`, with no time (CO-2)', () => {
    expect(CHORD_REFUSAL_PHRASE).toEqual({
      unseen: 'too soon',
      early: 'too soon',
      expired: 'time ran out',
      typed: 'a key was typed',
      cut: 'the line was cut',
    });
  });
});

describe('the sentences built around them', () => {
  it.each([
    ['unseen', 'too soon'],
    ['early', 'too soon'],
    ['expired', 'time ran out'],
    ['typed', 'a key was typed'],
    ['cut', 'the line was cut'],
  ] as const)(
    '%s: the doctor and the cost release both say the same phrase, by literal',
    (reason, phrase) => {
      expect(chordRefusedText(reason)).toBe(`Nothing was sent: ${phrase}. [d] asks again.`);
      expect(releaseRefusedText(reason)).toBe(`Nothing released: ${phrase}. [r] asks again.`);
    },
  );

  it.each(REASONS)(
    '%s: each fits the room a notification has in the legend row of a popup at the smallest terminal',
    (reason) => {
      expect(displayWidth(chordRefusedText(reason))).toBeLessThanOrEqual(POPUP_NOTICE_MAX_COLUMNS);
      expect(displayWidth(releaseRefusedText(reason))).toBeLessThanOrEqual(
        POPUP_NOTICE_MAX_COLUMNS,
      );
    },
  );
});

describe('the sentence names no wait, because no one wait is what the host enforces (CO-2)', () => {
  it('names no time at all: no digit in either phrase a key that came too soon is told', () => {
    expect(CHORD_REFUSAL_PHRASE.early).not.toMatch(/\d/u);
    expect(CHORD_REFUSAL_PHRASE.unseen).not.toMatch(/\d/u);
  });

  /**
   * Open `/cost`, arm its line, answer it too soon (refused: `too soon`), ask again `askAgain` ms after that refusal and answer `after` ms after
   * it. Returns how many releases happened.
   */
  async function releasesAfterWaiting(after: number, askAgain = 100): Promise<number> {
    const r = reportRig();
    const fake = fakeCost({ held: 450 });
    r.open({ cost: fake.port }, { kind: 'cost', release: false });
    r.show();
    await settleWork();
    r.clock.advance(600);
    r.press('r');
    await settleWork();
    r.show();
    r.clock.advance(100); // inside the dwell
    r.press('y', CTRL);
    expect(r.notifications.getSnapshot().current?.text).toBe(
      'Nothing released: too soon. [r] asks again.',
    );
    const refusedAt = r.clock.now();
    r.clock.advance(askAgain);
    r.press('r');
    await settleWork();
    r.show();
    r.clock.advance(refusedAt + after - r.clock.now());
    r.press('y', CTRL);
    return fake.release.mock.calls.length;
  }

  it('asked again at once, the wait is the lockout the refused key restarted: 1999 ms after it is refused again, 2000 ms after it releases', async () => {
    expect(APPROVAL_LOCKOUT_MS).toBe(2000);
    expect(await releasesAfterWaiting(APPROVAL_LOCKOUT_MS - 1)).toBe(0);
    expect(await releasesAfterWaiting(APPROVAL_LOCKOUT_MS)).toBe(1);
  });

  it('asked again only once the lockout is over, the wait is the new line’s dwell: an answer 2.4 s after the refusal is refused, so "wait 2 s" would be untrue', async () => {
    expect(await releasesAfterWaiting(APPROVAL_LOCKOUT_MS + 400, APPROVAL_LOCKOUT_MS)).toBe(0);
    expect(await releasesAfterWaiting(APPROVAL_LOCKOUT_MS + 800, APPROVAL_LOCKOUT_MS)).toBe(1);
  });
});
