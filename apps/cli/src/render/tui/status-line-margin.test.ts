/**
 * The left margin of the status line is the CALLER's ([ADR-0146](../../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md)
 * §2, MVP-11 step 7a): the Home draws its line inside the Home's margin (6 columns below 100, 8 from 100), and a chat before it has a grid draws
 * it at column 0, so the budget is `columns − leftMargin` and the Home's margin is only what a caller who names none gets. The wording and the
 * order of loss are `status-line.test.ts`'s; this file is the margin.
 */
import { describe, expect, it } from 'vitest';

import { type ChatStatusInput, type HomeStatusInput, statusLine } from './status-line.js';
import { displayWidth } from './viewport.js';

const CHAT: ChatStatusInput = {
  surface: 'chat',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  mode: 'ask',
  effort: 'high',
  turns: 42,
  cost: { full: '$0.1235', short: '$0.1235', qualified: false },
  contextPercent: 18,
};

const HOME: HomeStatusInput = {
  surface: 'home',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  mode: 'ask',
  directory: '~/work/clients/acme/web-frontend',
};

/** The whole chat line, written independently of the margin: far more columns than it needs. */
const FULL_CHAT = statusLine(CHAT, 400, 0).text;
const FULL_WIDTH = displayWidth(FULL_CHAT);

describe('the status line budget is the columns less the left margin the caller names', () => {
  it('has the whole width at a margin of 0: a line as wide as the terminal is not cut', () => {
    expect(FULL_WIDTH).toBeGreaterThan(80);
    expect(FULL_WIDTH).toBeLessThan(100);
    expect(statusLine(CHAT, FULL_WIDTH, 0)).toEqual({ text: FULL_CHAT, cut: [] });
    expect(displayWidth(statusLine(CHAT, FULL_WIDTH - 1, 0).text)).toBeLessThanOrEqual(
      FULL_WIDTH - 1,
    );
    expect(statusLine(CHAT, FULL_WIDTH - 1, 0).cut).toEqual(['turns']);
  });

  it('has the columns less n at a margin of n: the line fits at exactly width + n and not one column fewer', () => {
    for (const margin of [1, 4, 6, 11]) {
      expect(statusLine(CHAT, FULL_WIDTH + margin, margin).cut, `margin ${String(margin)}`).toEqual(
        [],
      );
      expect(
        statusLine(CHAT, FULL_WIDTH + margin - 1, margin).cut,
        `margin ${String(margin)}, one column fewer`,
      ).toEqual(['turns']);
    }
  });

  it('gives a caller who names no margin the Home’s: 6 columns below 100 and 8 from 100', () => {
    // 90 columns: the Home's margin leaves 84, so the line (90 wide) loses its turns; named 0, it fits.
    expect(statusLine(CHAT, 90).cut).toEqual(['turns']);
    expect(statusLine(CHAT, 90, 0).cut).toEqual([]);
    // 100 columns leave 92 with the margin of 8 and 94 with a margin of 6: a line of 93 columns tells the two apart.
    const wide: ChatStatusInput = { ...CHAT, model: 'claude-sonnet-4-6-extra' };
    const wideWidth = displayWidth(statusLine(wide, 400, 0).text);
    expect(wideWidth).toBe(96);
    expect(statusLine(wide, 100).cut, 'a margin of 8 at 100 columns leaves 92').toEqual(['turns']);
    expect(statusLine(wide, 100, 4).cut, 'a margin of 4 leaves 96').toEqual([]);
    expect(statusLine(wide, 99).cut, 'a margin of 6 at 99 columns leaves 93').toEqual(['turns']);
  });

  it('is the same for a margin that is not a usable number: not a number and infinite fall back to the Home’s, a negative one is none', () => {
    const named = (margin: number) => statusLine(CHAT, 90, margin);
    expect(named(Number.NaN)).toEqual(statusLine(CHAT, 90));
    expect(named(Number.POSITIVE_INFINITY)).toEqual(statusLine(CHAT, 90));
    expect(named(-5)).toEqual(statusLine(CHAT, 90, 0));
    expect(named(2.9)).toEqual(statusLine(CHAT, 90, 2));
  });

  it('applies to the Home’s line too: the same budget, whoever draws it', () => {
    const full = statusLine(HOME, 400, 0).text;
    const width = displayWidth(full);
    expect(statusLine(HOME, width, 0).cut).toEqual([]);
    expect(statusLine(HOME, width + 3, 3).cut).toEqual([]);
    expect(statusLine(HOME, width + 3 - 1, 3).cut).toEqual(['directory']);
  });

  it('gives no columns at all for a width that is not a number, whatever the margin', () => {
    expect(displayWidth(statusLine(CHAT, Number.NaN, 0).text)).toBeGreaterThan(0);
    expect(statusLine(CHAT, Number.NaN, 0).cut.length).toBeGreaterThan(0);
  });
});
