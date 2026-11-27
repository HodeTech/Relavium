import { describe, expect, it } from 'vitest';

import { withGlyphForm } from './glyphs.js';
import {
  sheetRule,
  thinRuleText,
  WAIT_CLOCK_COLUMNS,
  waitClockText,
  waitSinceText,
} from './sheet-frame.js';
import { displayWidth } from './viewport.js';

/**
 * The sheet's heavy rule and its wait clock (ADR-0147 §1 and §2): the clock's words, quantised to the unit they show; the room the rule keeps
 * for the widest clock, so a tick never changes the rule's width or the label it shows; and the plain forms, which keep the heavy rule apart
 * from the thin one without colour.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('waitClockText — the alternate screen’s clock, quantised to the unit it shows', () => {
  it('shows seconds for the first minute, then minutes, then hours and minutes, then days and hours', () => {
    expect(waitClockText(0)).toBe('waiting 0:00');
    expect(waitClockText(41 * SECOND)).toBe('waiting 0:41');
    expect(waitClockText(59 * SECOND + 999)).toBe('waiting 0:59');
    expect(waitClockText(MINUTE)).toBe('waiting 1m');
    expect(waitClockText(2 * MINUTE + 59 * SECOND)).toBe('waiting 2m');
    expect(waitClockText(59 * MINUTE + 59 * SECOND)).toBe('waiting 59m');
    expect(waitClockText(HOUR + 7 * MINUTE)).toBe('waiting 1h 07m');
    expect(waitClockText(23 * HOUR + 59 * MINUTE + 59 * SECOND)).toBe('waiting 23h 59m');
    expect(waitClockText(DAY + 3 * HOUR)).toBe('waiting 1d 03h');
    expect(waitClockText(99 * DAY + 23 * HOUR)).toBe('waiting 99d 23h');
    expect(waitClockText(100 * DAY)).toBe('waiting 99d+');
  });

  it('a clock stepped back or a value that is not a time reads as no wait at all', () => {
    expect(waitClockText(-5 * SECOND)).toBe('waiting 0:00');
    expect(waitClockText(Number.NaN)).toBe('waiting 0:00');
    expect(waitClockText(Number.POSITIVE_INFINITY)).toBe('waiting 0:00');
  });

  it('changes its text only at the boundary of the unit it shows (after the first minute: once a minute)', () => {
    // Every second of an hour from the first minute on: the text changes exactly once a minute.
    let changes = 0;
    let last = waitClockText(MINUTE);
    for (let ms = MINUTE + SECOND; ms <= 61 * MINUTE; ms += SECOND) {
      const next = waitClockText(ms);
      if (next !== last) changes += 1;
      last = next;
    }
    expect(changes).toBe(60);
  });

  it('is never wider than the room the rule keeps for it, in either form, at any time', () => {
    const samples = [
      0,
      9 * SECOND,
      59 * SECOND,
      59 * MINUTE,
      23 * HOUR + 59 * MINUTE,
      99 * DAY + 23 * HOUR,
      1e15,
    ];
    for (const ms of samples)
      expect(displayWidth(waitClockText(ms))).toBeLessThanOrEqual(WAIT_CLOCK_COLUMNS);
    for (let hour = 0; hour < 24; hour += 1)
      expect(displayWidth(waitSinceText(new Date(2026, 10, 27, hour, 59).getTime()))).toBe(
        WAIT_CLOCK_COLUMNS,
      );
  });
});

describe('waitSinceText — the inline renderer’s static clock', () => {
  it('names the local time the wait began, in HH:MM, and nothing that ticks', () => {
    const since = new Date(2026, 10, 27, 9, 5, 41).getTime();
    expect(waitSinceText(since)).toBe('waiting since 09:05');
    // The same text a minute, an hour later: it is the origin, not an elapsed time.
    expect(waitSinceText(since)).toBe(waitSinceText(since));
  });

  it('an origin that is not a time draws the bare word', () => {
    expect(waitSinceText(Number.NaN)).toBe('waiting');
  });
});

describe('sheetRule — the heavy rule with the label and the clock', () => {
  const LABEL = 'Approval needed';

  it('draws `━━ <label> ━━…━━ <clock> ━━`, exactly the width, the clock flush right', () => {
    const rule = sheetRule(LABEL, 'waiting 0:41', 79);
    expect(rule.kind).toBe('rule');
    expect(rule.text.startsWith('━━ Approval needed ━')).toBe(true);
    expect(rule.text.endsWith('━ waiting 0:41 ━━')).toBe(true);
    expect(displayWidth(rule.text)).toBe(79);
    // The label is the strong stretch.
    expect(rule.spans).toEqual([{ from: 3, to: 3 + LABEL.length, role: 'strong' }]);
  });

  it('a tick never changes the rule’s width or the label it shows, at every width from 40 to 200 columns', () => {
    const clocks = [
      '',
      waitClockText(0),
      waitClockText(41 * SECOND),
      waitClockText(2 * MINUTE),
      waitClockText(HOUR + 7 * MINUTE),
      waitClockText(23 * HOUR + 59 * MINUTE),
      waitClockText(1e15),
      waitSinceText(new Date(2026, 10, 27, 23, 59).getTime()),
    ];
    const long = 'Question from the agent · not an approval and a label much longer than the row';
    for (const label of [LABEL, 'Question from the agent · not an approval', long]) {
      for (let width = 40; width <= 200; width += 1) {
        const rules = clocks.map((clock) => sheetRule(label, clock, width));
        const shownLabels = new Set(rules.map((rule) => rule.text.slice(3, rule.spans?.[0]?.to)));
        expect(shownLabels.size, `${label} at ${String(width)}`).toBe(1);
        for (const rule of rules)
          expect(displayWidth(rule.text), `${label} at ${String(width)}`).toBe(width);
      }
    }
  });

  it('keeps the agent’s question label word for word at 80 columns (ADR-0132; ADR-0147 §1)', () => {
    const rule = sheetRule(
      'Question from the agent · not an approval',
      waitClockText(8 * SECOND),
      79,
    );
    expect(rule.text).toContain('Question from the agent · not an approval');
  });

  it('without colour the heavy rule is `=` and the thin rule `-`, so the two stay apart (ADR-0147 §1)', () => {
    const plain = withGlyphForm(true, () => sheetRule(LABEL, 'waiting 0:41', 79));
    const thin = withGlyphForm(true, () => thinRuleText(79));
    expect(plain.text.startsWith('== Approval needed =')).toBe(true);
    expect(plain.text.endsWith('= waiting 0:41 ==')).toBe(true);
    expect(plain.text).not.toContain('-');
    expect(thin).toBe('-'.repeat(79));
    // In the Unicode form too, the two rules are different glyphs.
    expect(sheetRule(LABEL, '', 79).text).not.toContain('─');
    expect(thinRuleText(3)).toBe('───');
  });
});
