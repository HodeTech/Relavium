/**
 * Why a `Ctrl+Y` did not count, in words ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2): the four phrases are written once, and the popups that own a confirmation line (the doctor's deep check, the cost release) build their
 * sentences around that one table, so no guard is worded two ways.
 */
import { describe, expect, it } from 'vitest';

import { displayWidth } from '../render/tui/viewport.js';
import { CHORD_REFUSAL_PHRASE } from './chord-refusal.js';
import { releaseRefusedText } from './cost-popup.js';
import { chordRefusedText } from './doctor-session.js';
import { POPUP_NOTICE_MAX_COLUMNS } from './geometry.js';
import type { ChordRefusal } from './popup-host.js';

const REASONS = [
  'unseen',
  'early',
  'expired',
  'typed',
  'cut',
] as const satisfies readonly ChordRefusal[];

describe('the phrases', () => {
  it('are these words for the five guards of the host: a key that came before its frame was shown and one that came inside the dwell are both "pressed too soon"', () => {
    expect(CHORD_REFUSAL_PHRASE).toEqual({
      unseen: 'pressed too soon',
      early: 'pressed too soon',
      expired: 'time ran out',
      typed: 'a key was typed',
      cut: 'the line was cut',
    });
  });
});

describe('the sentences built around them', () => {
  it.each([
    ['unseen', 'pressed too soon'],
    ['early', 'pressed too soon'],
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
