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

const REASONS = ['unseen', 'early', 'expired', 'typed'] as const satisfies readonly ChordRefusal[];

describe('the phrases', () => {
  it('are these four, one for each guard of the host', () => {
    expect(CHORD_REFUSAL_PHRASE).toEqual({
      unseen: 'not yet shown',
      early: 'pressed too soon',
      expired: 'time ran out',
      typed: 'a key was typed',
    });
  });
});

describe('the sentences built around them', () => {
  it.each(REASONS)('%s: the doctor and the cost release both say the same phrase', (reason) => {
    const phrase = CHORD_REFUSAL_PHRASE[reason];
    expect(chordRefusedText(reason)).toBe(
      `Not confirmed: ${phrase}. Nothing was sent; [d] asks again.`,
    );
    expect(releaseRefusedText(reason)).toBe(`Not released: ${phrase}.`);
  });

  it.each(REASONS)('%s: each fits the legend row of a popup at the smallest terminal', (reason) => {
    expect(displayWidth(chordRefusedText(reason))).toBeLessThanOrEqual(POPUP_NOTICE_MAX_COLUMNS);
    expect(displayWidth(releaseRefusedText(reason))).toBeLessThanOrEqual(POPUP_NOTICE_MAX_COLUMNS);
  });
});
