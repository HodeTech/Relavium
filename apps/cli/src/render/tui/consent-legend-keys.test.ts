import { describe, expect, it } from 'vitest';

import type { ToolPreview } from '@relavium/core';

import type { CommandCardFacts } from '../../chat/command-facts.js';
import type { ChatKey } from './chat-input.js';
import { LEGEND_SEPARATOR, type LegendRender } from './legend.js';
import { rowSegments } from './legend-row.js';
import { editedFilePreview } from './fixtures/edit-diff.js';
import {
  acknowledgeToolReview,
  initialToolReview,
  isAlwaysConfirmKey,
  reduceToolReviewKey,
  toolReviewPage,
  type ReviewKeyAction,
  type ToolReviewState,
} from './tool-review-model.js';
import { cardKeyLegend, type CardKeyInput } from './tool-review-card.js';
import { createReviewDocument } from './tool-review-projection.js';
import {
  DETAILS_CLOSE_LEGEND,
  FULL_CONFIRM_ANY_LEGEND,
  FULL_CONFIRM_ENTER_LEGEND,
  callListView,
  fullAnswerLegend,
  fullNavRows,
  fullSearchLegend,
} from './tool-review-screen.js';

/**
 * Every key a consent surface's legend names does what the legend says it does
 * ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §3). The legends are built from items, so the keys
 * are read back out of the built rows (the stretches the builder gave a role) and each is pressed on the reducer the surface's handler
 * runs; a key the legend names that this table does not know fails the test, so a hint cannot say a key does something the handler does
 * not, and a new key cannot be added to a legend without a handler to press it on.
 */

const CTRL = { ctrl: true } as const;

/** The keys a row names, in order: each stretch the builder drew in a key's role, a list (`Esc / [Ctrl+C]`) split into its keys. */
function keysOf(row: LegendRender): string[] {
  return rowSegments(row)
    .filter((segment) => segment.role !== 'dim')
    .flatMap((segment) => segment.text.split(' / '));
}

const IDLE_FACTS: CommandCardFacts = {
  standing: 'not-pre-approved',
  runsCode: false,
  protectedPath: false,
  cwd: '/work/project',
  offers: { session: true, remember: true },
};

/** A review whose frame has been acknowledged: Allow is unlocked and the page is the one the handler reads. */
function review(
  preview: ToolPreview,
  patch: Partial<ToolReviewState> = {},
  kind: 'approval' | 'details' = 'approval',
  facts?: CommandCardFacts,
) {
  const base = {
    ...initialToolReview(kind, 'call', createReviewDocument(preview), facts),
    ...patch,
  };
  const drawn = toolReviewPage(base, 80, 24);
  return { state: drawn === undefined ? base : acknowledgeToolReview(base, drawn), page: drawn };
}

type Reviewed = ReturnType<typeof review>;

function press(
  at: Reviewed,
  input: string,
  key: ChatKey,
  options: { cacheable?: boolean; rememberOffered?: boolean; callCount?: number } = {},
): ReviewKeyAction {
  return reduceToolReviewKey(
    at.state,
    input,
    key,
    true,
    at.page,
    options.cacheable ?? true,
    options.callCount ?? 0,
    options.rememberOffered ?? false,
  );
}

/** The state a `state` action carries, so an effect can say what changed. */
function nextState(action: ReviewKeyAction): ToolReviewState {
  if (action.kind !== 'state') throw new Error(`expected a state change, got ${action.kind}`);
  return action.state;
}

const SMALL = editedFilePreview(8, { 4: 'four' });
const TALL = editedFilePreview(100, { 5: 'five', 90: 'EVIL' });
/** A value the display floor masks (`Bearer sk-proj-…`), added as one line of a new file. */
const SECRET_LINE = 'Bearer sk-proj-abcdefghijklmnopqrstuvwxyz';
const MASKED: ToolPreview = {
  kind: 'operation',
  target: 'notes.md',
  fields: [],
  diff: {
    before: null,
    after: `${SECRET_LINE}\n`,
    beforeEndings: 'empty',
    afterEndings: 'lf',
    stats: {
      addedLines: 1,
      removedLines: 0,
      beforeBytes: 0,
      afterBytes: SECRET_LINE.length + 1,
    },
    lines: [
      {
        kind: 'added',
        text: SECRET_LINE,
        ending: 'lf',
        after: { line: 1, start: 0, end: SECRET_LINE.length + 1 },
      },
    ],
  },
};

/**
 * What each ITEM of a legend must do when its key is pressed, keyed by the item as the legend writes it (`[Ctrl+N] Deny`), not by the key
 * alone: a legend that swaps two verbs (`[Ctrl+N] Allow`) names an item this table does not have, so it fails, where a table keyed by the key
 * label would have passed it. The items are those of a file write the person has inspected (`file writes`) and of a command.
 */
const CARD_EFFECTS: Readonly<Record<string, (at: Reviewed) => void>> = {
  '[Ctrl+Y] Allow': (at) =>
    expect(press(at, 'y', CTRL)).toEqual({ kind: 'approve', scope: 'once' }),
  '[Ctrl+Y] Allow once': (at) =>
    expect(press(at, 'y', CTRL)).toEqual({ kind: 'approve', scope: 'once' }),
  '[Ctrl+G] Allow all file writes this session': (at) =>
    expect(press(at, 'g', CTRL)).toEqual({ kind: 'approve', scope: 'always' }),
  '[Ctrl+G] Allow this session': (at) =>
    expect(press(at, 'g', CTRL)).toEqual({ kind: 'approve', scope: 'always' }),
  '[Ctrl+O] Allow + remember': (at) =>
    expect(press(at, 'o', CTRL, { rememberOffered: true })).toEqual({
      kind: 'approve',
      scope: 'remember',
    }),
  '[Ctrl+N] Deny': (at) => expect(press(at, 'n', CTRL)).toEqual({ kind: 'deny' }),
  '[Ctrl+R] Deny + reason': (at) => expect(nextState(press(at, 'r', CTRL)).denial).toBe(''),
  '[v] full diff': (at) => expect(nextState(press(at, 'v', {})).screen).toBe('full'),
  '[v] full view': (at) => expect(nextState(press(at, 'v', {})).screen).toBe('full'),
  'Esc stops the turn': (at) => expect(press(at, '', { escape: true })).toEqual({ kind: 'abort' }),
};

/**
 * Each item of `row` that names a key is pressed on `at` and does what `effects` says of that item; an item the table has no effect for
 * fails, and so does a verb that was swapped. Returns the items, so a test says which it expected.
 */
function everyKeyDoesWhatItSays(
  row: LegendRender,
  at: Reviewed,
  effects: Readonly<Record<string, (at: Reviewed) => void>>,
): readonly string[] {
  const keys = keysOf(row);
  const items = row.text
    .split(LEGEND_SEPARATOR)
    .filter((item) => keys.some((key) => item.startsWith(key)));
  for (const item of items) {
    const effect = effects[item];
    if (effect === undefined)
      throw new Error(`the legend says "${item}", which has no checked effect`);
    effect(at);
  }
  return items;
}

describe('the approval card: every key its legend names does what it says (ADR-0145 §3)', () => {
  const input: CardKeyInput = { inspected: true, cacheable: true, scope: 'file writes' };

  it('names Ctrl+Y, Ctrl+G, Ctrl+N, Ctrl+R, v and Esc, and each does what its word says', () => {
    const [grants, refusals] = cardKeyLegend(input);
    const at = review(SMALL);
    expect(everyKeyDoesWhatItSays(grants, at, CARD_EFFECTS)).toEqual([
      '[Ctrl+Y] Allow',
      '[Ctrl+G] Allow all file writes this session',
    ]);
    expect(everyKeyDoesWhatItSays(refusals, at, CARD_EFFECTS)).toEqual([
      '[Ctrl+N] Deny',
      '[Ctrl+R] Deny + reason',
      '[v] full diff',
      'Esc stops the turn',
    ]);
  });

  it('a legend that swaps two verbs fails: `[Ctrl+N] Allow` is no item the table knows', () => {
    const at = review(SMALL);
    const swapped: LegendRender = { text: '[Ctrl+N] Allow · [Ctrl+Y] Deny', spans: [] };
    const named = (row: LegendRender): string[] => keysOf(row);
    // the swapped row, read the way the legend builder writes its spans (a key in a role, the verb dim)
    const built: LegendRender = {
      text: swapped.text,
      spans: [
        { from: 0, to: 8, role: 'strong' },
        { from: 8, to: 14, role: 'dim' },
        { from: 14, to: 17, role: 'dim' },
        { from: 17, to: 25, role: 'strong' },
        { from: 25, to: 30, role: 'dim' },
      ],
    };
    expect(named(built)).toEqual(['[Ctrl+N]', '[Ctrl+Y]']);
    expect(() => everyKeyDoesWhatItSays(built, at, CARD_EFFECTS)).toThrow(/no checked effect/u);
  });

  it('names Ctrl+O only for a command that may be remembered, and then it asks to remember it', () => {
    const [grants] = cardKeyLegend({ ...input, command: true, remember: true });
    expect(keysOf(grants)).toEqual(['[Ctrl+Y]', '[Ctrl+G]', '[Ctrl+O]']);
    const at = review(SMALL, {}, 'approval', IDLE_FACTS);
    expect(everyKeyDoesWhatItSays(grants, at, CARD_EFFECTS)).toEqual([
      '[Ctrl+Y] Allow once',
      '[Ctrl+G] Allow this session',
      '[Ctrl+O] Allow + remember',
    ]);
    expect(keysOf(cardKeyLegend({ ...input, command: true, remember: false })[0])).not.toContain(
      '[Ctrl+O]',
    );
  });

  it('names no Allow while it is locked, and Ctrl+Y then answers nothing, as the legend says', () => {
    const [locked] = cardKeyLegend({ ...input, inspected: false });
    expect(keysOf(locked)).toEqual([]);
    const lockedCard = review({ kind: 'operation', target: 'd'.repeat(200), fields: [] });
    expect(press(lockedCard, 'y', CTRL)).toEqual({ kind: 'none' });
  });

  it('says Enter confirms and every other key cancels, and Esc stops the turn, while the session grant waits', () => {
    // a command's question is answered with Enter; a tool's, with any key that is not one of the stops
    const [, second] = cardKeyLegend({ ...input, command: true, confirmAlways: true });
    expect(keysOf(second)).toEqual(['Enter', 'Esc']);
    expect(keysOf(cardKeyLegend({ ...input, confirmAlways: true })[1])).toEqual(['Esc']);
    const at = review(SMALL);
    // Enter is the one confirmation: the store owns it, and the review's own predicate says it is that key
    expect(isAlwaysConfirmKey(at.state, { return: true })).toBe(true);
    expect(isAlwaysConfirmKey(at.state, { ctrl: true, return: true })).toBe(false);
    expect(press(at, '', { escape: true })).toEqual({ kind: 'abort' });
    // any other key (a letter, a chord) is no confirmation
    expect(isAlwaysConfirmKey(at.state, {})).toBe(false);
    expect(second.text).toContain('stops the turn');
  });
});

/** What each named item must do on the full view of an approval: the card's items, and the ones of the full view's own. */
const FULL_EFFECTS: Readonly<Record<string, (at: Reviewed) => void>> = {
  ...Object.fromEntries(
    Object.entries(CARD_EFFECTS).filter(([item]) => item !== 'Esc stops the turn'),
  ),
  '[b] back to the card': (at) => expect(nextState(press(at, 'b', {})).screen).toBe('card'),
  '[Ctrl+C] stops the turn': (at) => expect(press(at, 'c', CTRL)).toEqual({ kind: 'abort' }),
  'Esc back': (at) => expect(nextState(press(at, '', { escape: true })).screen).toBe('card'),
};

describe('the full view of an approval: every key its answer rows name does what they say', () => {
  it('names Allow, Deny, back to the card, the stop key and Esc back, and each does it', () => {
    const at = review(SMALL, { screen: 'full' });
    const [grants, refusals] = fullAnswerLegend({
      inspected: true,
      cacheable: true,
      scope: 'file writes',
    });
    expect(everyKeyDoesWhatItSays(grants, at, FULL_EFFECTS)).toEqual([
      '[Ctrl+Y] Allow',
      '[Ctrl+G] Allow all file writes this session',
    ]);
    expect(everyKeyDoesWhatItSays(refusals, at, FULL_EFFECTS)).toEqual([
      '[Ctrl+N] Deny',
      '[b] back to the card',
      '[Ctrl+C] stops the turn',
      'Esc back',
    ]);
    // Esc leaves the review pending: it steps back, it does not stop the turn (so the row must not say it does)
    expect(refusals.text).toMatch(/Esc back$/u);
  });

  it('says the same of the two rows that ask a session-wide or remember question', () => {
    const at = review(SMALL, { screen: 'full' });
    for (const row of [FULL_CONFIRM_ENTER_LEGEND, FULL_CONFIRM_ANY_LEGEND]) {
      const keys = keysOf(row);
      expect(keys).toContain('[Ctrl+C]');
      expect(keys.at(-1)).toBe('Esc');
      // the items that name a key are pressed (the question's own `Enter confirm` is the store's: asserted below); the rest are words
      const items = row.text
        .split(LEGEND_SEPARATOR)
        .filter((item) => keys.some((key) => item.startsWith(key)) && !item.startsWith('Enter'));
      expect(items).toEqual(['[Ctrl+C] stops the turn', 'Esc back']);
      for (const item of items) {
        const effect = FULL_EFFECTS[item];
        if (effect === undefined) throw new Error(`no checked effect for "${item}"`);
        effect(at);
      }
    }
    expect(keysOf(FULL_CONFIRM_ENTER_LEGEND)).toContain('Enter');
    expect(isAlwaysConfirmKey(at.state, { return: true })).toBe(true);
  });

  it('names Enter, Esc and the stop key while the search box is open, and each does it', () => {
    const at = review(SMALL, { screen: 'full', searching: true, query: 'four' });
    const [find, stop] = fullSearchLegend();
    expect(keysOf(find)).toEqual(['Enter', 'Esc']);
    expect(keysOf(stop)).toEqual(['[Ctrl+C]']);
    const found = nextState(press(at, '', { return: true }));
    expect(found.searching).toBe(false);
    expect(found.message).toBe('Match found');
    expect(nextState(press(at, '', { escape: true })).searching).toBe(false);
    expect(press(at, 'c', CTRL)).toEqual({ kind: 'abort' });
  });
});

describe('the full view navigation legend: every key it names moves, searches or toggles', () => {
  const all = { hasChanges: true, hasMasks: true, canCopy: true, revealed: false, numeric: false };
  const keysOfAll = fullNavRows({ ...all, columns: 140 }).flatMap(keysOf);

  it('names exactly the keys the handler has for the full view', () => {
    expect(keysOfAll).toEqual([
      '↑/↓',
      'PgUp/PgDn',
      'Home/End',
      'Tab/Shift+Tab',
      '[/]',
      '[r]',
      '[p]',
      '[c]',
    ]);
  });

  it('moves down with ↓, a page with PgDn, to the end with End, and to the next change with Tab', () => {
    const at = review(TALL, { screen: 'full' });
    for (const [input, key] of [
      ['', { downArrow: true }],
      ['', { pageDown: true }],
      ['', { end: true }],
      ['', { tab: true }],
    ] as const) {
      const moved = nextState(press(at, input, key));
      expect(moved.cursor, JSON.stringify(key)).not.toEqual(at.state.cursor);
    }
  });

  it('moves back with ↑, PgUp, Home and Shift+Tab from further down', () => {
    const lower = review(TALL, { screen: 'full' });
    const end = nextState(press(lower, '', { end: true }));
    const at: Reviewed = { state: end, page: toolReviewPage(end, 80, 24) };
    for (const key of [
      { upArrow: true },
      { pageUp: true },
      { home: true },
      { tab: true, shift: true },
    ] as const) {
      const moved = nextState(press(at, '', key));
      expect(moved.cursor, JSON.stringify(key)).not.toEqual(end.cursor);
    }
  });

  it('opens the search box with /, reveals masked values with r, switches to code points with p, copies with c', () => {
    const at = review(TALL, { screen: 'full' });
    expect(nextState(press(at, '/', {})).searching).toBe(true);
    expect(nextState(press(at, 'p', {})).numeric).toBe(true);
    expect(press(at, 'c', {})).toEqual({ kind: 'copy' });
    const masked = review(MASKED, { screen: 'full' });
    expect(masked.state.document?.masks.length, 'the fixture carries a mask').toBeGreaterThan(0);
    expect(nextState(press(masked, 'r', {})).reveal).toBe(true);
  });

  it('names r only where something is masked, c only where a clipboard is bound, and Tab only where a change is', () => {
    const none = fullNavRows({
      ...all,
      hasChanges: false,
      hasMasks: false,
      canCopy: false,
      columns: 140,
    }).flatMap(keysOf);
    expect(none).toEqual(['↑/↓', 'PgUp/PgDn', 'Home/End', '[/]', '[p]']);
    // and r answers nothing where nothing is masked
    expect(press(review(SMALL, { screen: 'full' }), 'r', {})).toEqual({ kind: 'none' });
  });
});

describe('the details screen and the tool-call list: every key they name does what they say', () => {
  it('names b back to the list and Esc close on a call’s details, and each does it', () => {
    const at = review(SMALL, { screen: 'full' }, 'details');
    expect(keysOf(DETAILS_CLOSE_LEGEND)).toEqual(['[b]', 'Esc']);
    expect(nextState(press(at, 'b', {})).screen).toBe('list');
    expect(press(at, '', { escape: true })).toEqual({ kind: 'close' });
    expect(DETAILS_CLOSE_LEGEND.text.endsWith('Esc close')).toBe(true);
  });

  it('names ↑/↓, PgUp/PgDn, Enter, Home/End and Esc on the list, and each selects, opens or closes', () => {
    const hint = callListView({
      calls: [{ callId: 'a', toolId: 'write_file', outcome: 'success', target: 'a.md' }],
      selected: 0,
      columns: 80,
      terminalRows: 24,
    }).hint;
    expect(hint).toBe(
      ['↑/↓, PgUp/PgDn select', 'Enter open', 'Home/End oldest/newest', 'Esc close'].join(
        LEGEND_SEPARATOR,
      ),
    );
    const at = review(SMALL, { screen: 'list', selected: 1 }, 'details');
    const calls = { callCount: 3 };
    expect(nextState(press(at, '', { upArrow: true }, calls)).selected).toBe(0);
    expect(nextState(press(at, '', { downArrow: true }, calls)).selected).toBe(2);
    expect(nextState(press(at, '', { pageDown: true }, calls)).selected).toBe(2);
    expect(nextState(press(at, '', { pageUp: true }, calls)).selected).toBe(0);
    expect(nextState(press(at, '', { end: true }, calls)).selected).toBe(2);
    expect(nextState(press(at, '', { home: true }, calls)).selected).toBe(0);
    expect(press(at, '', { return: true }, calls)).toEqual({ kind: 'select' });
    expect(press(at, '', { escape: true }, calls)).toEqual({ kind: 'close' });
  });
});
