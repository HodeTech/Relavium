/**
 * The `/effort` popup ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §3, §6): one list of
 * the tiers THIS model takes (a tier the provider would refuse is not on it), the tier in force marked and opened on (projected onto the row that
 * represents it), so a bare `Enter` changes nothing; `Enter` on another tier applies it to the session through the port, closes the popup and
 * announces it on the HOST's channel (it outlives the popup), and writes nothing else; `Esc` closes and changes nothing; the answer waits for
 * the opening guard like every answer.
 */
import type { ReasoningEffort } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { withGlyphForm } from '../render/tui/glyphs.js';
import { displayWidth } from '../render/tui/viewport.js';
import { effortContent, effortInitialRow, effortSpec, EFFORT_NONE } from './effort-popup.js';
import { POPUP_NOTICE_MAX_COLUMNS } from './geometry.js';
import { popupLegend, openFrame } from './popup-reducer.js';
import { effortAnnouncement } from './settings-port.js';
import { DOWN, ENTER, ESC, fakeEffort, settingsRig, UP } from './settings.test-support.js';

const GRADED = 'claude-sonnet-4-6';
const BUDGET = 'claude-sonnet-4-5';
const DEEPSEEK = 'deepseek-v4-flash';
const ALL = ['off', 'low', 'medium', 'high', 'max'] as const;

describe('what the popup lists', () => {
  it('one row per tier the model takes, its label and hint, the tier in force marked `current`', () => {
    const content = effortContent(GRADED, ALL, 'high');
    if (content.kind !== 'list') throw new Error('a list');
    expect(content.rows.map((row) => `${row.id}: ${row.label} — ${row.detail ?? ''}`)).toEqual([
      'off: off — no reasoning — fastest, lowest cost',
      'low: low — brief reasoning',
      'medium: medium — balanced reasoning',
      'high: high — deep reasoning · current',
      'max: max — maximum reasoning — slowest, highest cost',
    ]);
  });

  it('a budget model’s `medium` reads `on`, and a tier deduped away is marked on the row that represents it', () => {
    const budget = effortContent(BUDGET, ['off', 'medium'], 'high');
    if (budget.kind !== 'list') throw new Error('a list');
    expect(budget.rows.map((row) => [row.label, row.detail])).toEqual([
      ['off', 'no reasoning — fastest, lowest cost'],
      ['on', 'reasoning on · current'],
    ]);
    // DeepSeek sends `high` for `low`: the bound `low` is marked on the `high` row.
    const deduped = effortContent(DEEPSEEK, ['off', 'high', 'max'], 'low');
    if (deduped.kind !== 'list') throw new Error('a list');
    expect(deduped.rows.find((row) => row.detail?.endsWith('· current') === true)?.id).toBe('high');
  });

  it('with no tier in force nothing is marked; with no tier at all the step says so (never expected: the routing checks first)', () => {
    const none = effortContent(GRADED, ALL, undefined);
    if (none.kind !== 'list') throw new Error('a list');
    expect(none.rows.some((row) => row.detail?.includes('current') === true)).toBe(false);
    expect(effortContent('gpt-4o', [], undefined)).toEqual({ kind: 'empty', ...EFFORT_NONE });
  });

  it('opens on the tier in force, projected; with none in force on the neutral `medium`, projected (never on `off` by accident)', () => {
    expect(effortInitialRow(GRADED, ALL, 'high')).toBe('high');
    expect(effortInitialRow(GRADED, ALL, undefined)).toBe('medium');
    expect(effortInitialRow(DEEPSEEK, ['off', 'high', 'max'], undefined)).toBe('high');
    expect(effortInitialRow(BUDGET, ['off', 'medium'], 'high')).toBe('medium');
  });

  /** The legend of the popup opened on `initialRow` with the highlight moved to `row` (the arrows, one press each). */
  function legendOn(
    model: string,
    tiers: readonly ReasoningEffort[],
    current: ReasoningEffort | undefined,
    row: string,
  ) {
    const spec = effortSpec(
      'chat',
      effortContent(model, tiers, current),
      effortInitialRow(model, tiers, current),
    );
    const opened = openFrame(spec, 1);
    const rows = tiers.map((tier) => tier as string);
    const frame = {
      ...opened,
      steps: opened.steps.map((step) => ({ ...step, selected: rows.indexOf(row) })),
    };
    return withGlyphForm(false, () => popupLegend(frame));
  }

  it('the spec: one step named Effort under `/effort`, opened on the tier in force', () => {
    const spec = effortSpec('chat', effortContent(GRADED, ALL, 'low'), 'low');
    expect(spec).toMatchObject({ id: 'effort', title: '/effort', origin: 'chat' });
    expect(spec.steps).toHaveLength(1);
    expect(spec.steps[0]).toMatchObject({ name: 'Effort', enter: 'apply', initialRow: 'low' });
  });

  it('the legend says what `Enter` does to the row it is on, as `/mode` says it: `Enter keep` on the tier in force, `Enter apply` on any other (W1 O-15)', () => {
    const inForce = legendOn(GRADED, ALL, 'low', 'low');
    expect(inForce.items).toEqual([
      { keys: '↑/↓', verb: 'select' },
      { keys: 'Enter', verb: 'keep' },
    ]);
    expect(inForce.exit).toMatchObject({ class: 'close', keys: 'Esc', verb: 'close' });
    const other = legendOn(GRADED, ALL, 'low', 'high');
    expect(other.items).toEqual([
      { keys: '↑/↓', verb: 'select' },
      { keys: 'Enter', verb: 'apply' },
    ]);
    // with no tier in force (the provider's default) nothing is "kept": every row applies, the opening `medium` included
    for (const tier of ALL)
      expect(legendOn(GRADED, ALL, undefined, tier).items[1]).toEqual({
        keys: 'Enter',
        verb: 'apply',
      });
  });

  it('the row that REPRESENTS the tier in force (a deduped or collapsed one) says `apply` where `Enter` really applies it: the popup compares the row with the tier in force', () => {
    // DeepSeek's `low` sends `high`: the marked row is `high`, but `Enter` on it applies an explicit `high` (it is not the tier in force)
    expect(legendOn(DEEPSEEK, ['off', 'high', 'max'], 'low', 'high').items[1]).toEqual({
      keys: 'Enter',
      verb: 'apply',
    });
    expect(legendOn(DEEPSEEK, ['off', 'high', 'max'], 'high', 'high').items[1]).toEqual({
      keys: 'Enter',
      verb: 'keep',
    });
  });
});

describe('the announcement (the popup’s `Enter` and a typed `/effort <tier>` alike)', () => {
  it('names the tier and when it applies, or that it was in force already', () => {
    expect(effortAnnouncement('high', false)).toBe(
      'Reasoning effort: high · applies to the next message',
    );
    expect(effortAnnouncement('on', true)).toBe('Already at reasoning effort on.');
  });

  it.each(['off', 'low', 'medium', 'high', 'max', 'on'])(
    'fits beside a popup’s way back with the label %s (≤ 54 columns)',
    (label) => {
      for (const already of [false, true])
        expect(displayWidth(effortAnnouncement(label, already))).toBeLessThanOrEqual(
          POPUP_NOTICE_MAX_COLUMNS,
        );
    },
  );
});

describe('answering the popup', () => {
  it('opens on the tier in force; `Enter` on another applies it, closes, and announces it on the host’s channel (it outlives the popup)', () => {
    const r = settingsRig();
    const effort = fakeEffort(GRADED, ALL, 'low');
    expect(r.open({ effort: effort.member }, 'effort').opened).toBe(true);
    expect(r.rows().highlighted).toBe('low');
    r.settle();
    r.press('', DOWN);
    r.press('', DOWN);
    r.press('', ENTER);
    expect(effort.applied).toEqual(['high']);
    expect(r.host.getSnapshot().open).toBe(false);
    expect(r.announced).toEqual(['Reasoning effort: high · applies to the next message']);
    // The host's own word, not the popup's: the channel still shows it now the popup is closed.
    expect(r.notifications.getSnapshot().current?.text).toBe(
      'Reasoning effort: high · applies to the next message',
    );
  });

  it('a bare `Enter` on the tier in force applies nothing and says it was in force already', () => {
    const r = settingsRig();
    const effort = fakeEffort(BUDGET, ['off', 'medium'], 'medium');
    r.open({ effort: effort.member }, 'effort');
    r.settle();
    r.press('', ENTER);
    expect(effort.applied).toEqual([]);
    expect(r.host.getSnapshot().open).toBe(false);
    expect(r.announced).toEqual(['Already at reasoning effort on.']);
  });

  it('`Esc` closes and changes nothing, announces nothing', () => {
    const r = settingsRig();
    const effort = fakeEffort(GRADED, ALL, 'low');
    r.open({ effort: effort.member }, 'effort');
    r.settle();
    r.press('', UP);
    r.press('', ESC);
    expect(r.host.getSnapshot().open).toBe(false);
    expect(effort.applied).toEqual([]);
    expect(r.announced).toEqual([]);
  });

  it('an `Enter` before the popup was seen, or inside its settle, applies nothing (the opening guard)', () => {
    const r = settingsRig();
    const effort = fakeEffort(GRADED, ALL, 'low');
    r.open({ effort: effort.member }, 'effort');
    r.press('', DOWN);
    r.press('', ENTER); // not seen yet
    r.host.shown(r.host.getSnapshot());
    r.clock.advance(100);
    r.press('', DOWN);
    r.press('', ENTER); // inside the settle
    expect(effort.applied).toEqual([]);
    expect(r.host.getSnapshot().open).toBe(true);
    r.clock.advance(500);
    r.press('', ENTER);
    // The `↓` that came before the frame was seen was dropped too (a key nobody could see the popup take); the one after it moved.
    expect(effort.applied).toEqual(['medium']);
  });

  it('the tier in force is read when the answer comes, not when the popup opened', () => {
    const r = settingsRig();
    const effort = fakeEffort(GRADED, ALL, 'low');
    r.open({ effort: effort.member }, 'effort');
    r.settle();
    effort.member.apply('medium'); // the tier moved (a typed `/effort medium` before the popup was answered, say)
    effort.applied.length = 0;
    r.press('', DOWN); // low → medium
    r.press('', ENTER);
    expect(effort.applied).toEqual([]);
    expect(r.announced).toEqual(['Already at reasoning effort medium.']);
  });

  it('writes nothing but the announcement: every word it says is one line of at most 54 columns', () => {
    const r = settingsRig();
    const effort = fakeEffort(GRADED, ALL, undefined);
    r.open({ effort: effort.member }, 'effort');
    r.settle();
    r.press('', ENTER);
    expect(r.announced).toHaveLength(1);
    for (const text of r.announced) {
      expect(text.includes('\n')).toBe(false);
      expect(displayWidth(text)).toBeLessThanOrEqual(POPUP_NOTICE_MAX_COLUMNS);
    }
  });
});
