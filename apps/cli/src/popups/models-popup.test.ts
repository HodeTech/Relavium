/**
 * The `/models` popup's pure builders ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §1,
 * §3, §6; [ADR-0064](../../../../docs/decisions/0064-live-model-catalog.md) §6; [ADR-0059](../../../../docs/decisions/0059-cli-mid-session-model-reseat.md)):
 * the rows of the catalog (the picker's content, kept: the price, the window, the provider, the model in force, the dated pin on its alias,
 * a model that cannot be used dim with why), the line above them, the states of the first step, the second step's form (the tiers, where it
 * applies, the line that says where the conversation goes), the spec and its legends, the words a choice announces (each at most 54
 * columns), and the one scrub on every string a catalog, a provider or a model wrote.
 *
 * The formatters moved here with the picker's retirement (`render/tui/model-picker.ts`): their cases are the picker's, kept.
 */
import { describe, expect, it } from 'vitest';

import { withGlyphForm } from '../render/tui/glyphs.js';
import { legend as legendText } from '../render/tui/legend.js';
import { displayWidth } from '../render/tui/viewport.js';
import { formFits, popupBody, type PopupContent, type PopupForm } from './frame-model.js';
import {
  POPUP_FLOOR,
  POPUP_NOTICE_MAX_COLUMNS,
  popupGeometry,
  popupInnerWidth,
} from './geometry.js';
import {
  alreadyDefaultAnnouncement,
  alreadyOnAnnouncement,
  catalogHeading,
  choiceOf,
  currentProviderOf,
  dataLeavesWarning,
  defaultModelAnnouncement,
  formatContextWindow,
  formatModelPrice,
  markedCurrent,
  MODELS_LOADING,
  MODELS_READ_FAILED,
  MODELS_REFRESH_ROW,
  MODELS_SETTINGS_FAILED,
  modelRows,
  modelsListContent,
  modelsSpec,
  partialFailureBanner,
  scopeForm,
  scopeOfValues,
  type ScopeFacts,
} from './models-popup.js';
import { BUDGET, CATALOG, GRADED, model, NO_TIER, OPENAI } from './models.test-support.js';
import { openFrame, popupLegend, withContent } from './popup-reducer.js';
import { scrubPopupText } from './popup-text.js';
import type { DefaultModelSaveResult } from './settings-port.js';

const NAME = (id: string): string =>
  ({ anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Gemini' })[id] ?? id;
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);

const listOf = (content: PopupContent) => {
  if (content.kind !== 'list') throw new Error(`a list, not ${content.kind}`);
  return content;
};

describe('the formatters the picker had (moved, their cases kept)', () => {
  it('formats the price, or the "cost cap will not apply" hint when unknown', () => {
    expect(formatModelPrice(model('x', 'anthropic', { input: 3, output: 15 }))).toBe(
      '$3 / $15 per M',
    );
    const unpriced = {
      ...model('y', 'anthropic'),
      priceKnown: false,
      pricingSource: 'none' as const,
    };
    expect(formatModelPrice(unpriced)).toBe('no price — cost cap will not apply');
    const noPricing = {
      modelId: 'z',
      provider: 'anthropic',
      displayName: 'z',
      pricingSource: 'catalog',
      priceKnown: true,
      available: true,
      deprecated: false,
    } as const;
    expect(formatModelPrice(noPricing)).toBe('no price — cost cap will not apply');
  });

  it('keeps every digit of a fractional price (the old two-digit label showed $0.075 as $0.08)', () => {
    expect(formatModelPrice(model('z', 'openai', { input: 0.15, output: 1.25 }))).toBe(
      '$0.15 / $1.25 per M',
    );
    expect(formatModelPrice(model('z', 'openai', { input: 0.075, output: 0.435 }))).toBe(
      '$0.075 / $0.435 per M',
    );
  });

  it('rounds a context window once, so that no two spellings of nearly one size disagree, and an unknown one reads as nothing', () => {
    expect(formatContextWindow(200_000)).toBe('200K ctx');
    expect(formatContextWindow(1_500_000)).toBe('1.5M ctx');
    expect(formatContextWindow(999)).toBe('999 ctx');
    expect(formatContextWindow(1000)).toBe('1K ctx');
    expect(formatContextWindow(1499)).toBe('1K ctx');
    expect(formatContextWindow(1500)).toBe('2K ctx');
    expect(formatContextWindow(999_499)).toBe('999K ctx');
    expect(formatContextWindow(1_050_000)).toBe('1.1M ctx');
    expect(formatContextWindow(10_000_000)).toBe('10M ctx');
    for (const tokens of [999_500, 1_000_000, 1_048_576, 1_001_000])
      expect(formatContextWindow(tokens), String(tokens)).toBe('1M ctx');
    for (const bad of [undefined, 0, Number.NaN, Number.POSITIVE_INFINITY, -5])
      expect(formatContextWindow(bad), String(bad)).toBe('');
  });

  it('says which providers a refresh could not reach, by the names a person reads, and nothing when none failed', () => {
    expect(partialFailureBanner([], NAME)).toBeUndefined();
    expect(partialFailureBanner(['openai'], NAME)).toBe(
      "couldn't refresh OpenAI — showing last-known models",
    );
    expect(partialFailureBanner(['openai', 'gemini'], NAME)).toBe(
      "couldn't refresh OpenAI, Gemini — showing last-known models",
    );
  });
});

describe('the rows of the first step', () => {
  it('a model is its id, then the model in force (first, never cut), its window, its price, its provider and a deprecated flag', () => {
    const rows = modelRows(
      [
        model(GRADED, 'anthropic'),
        // A window that is not known reads as nothing (`formatContextWindow`): the row leaves it out.
        model('old-x', 'anthropic', { deprecated: true, window: 0 }),
      ],
      GRADED,
      NAME,
    );
    expect(rows.map((row) => [row.id, row.label, row.detail])).toEqual([
      [GRADED, GRADED, 'current · 200K ctx · $3 / $15 per M · Anthropic'],
      ['old-x', 'old-x', '$3 / $15 per M · Anthropic · deprecated'],
      // After the models this person can use, the row that refreshes the list (the host answers `Enter` on it; a letter is the filter's).
      [MODELS_REFRESH_ROW, 'Refresh the list', 'ask every connected provider again'],
    ]);
    expect(rows.every((row) => row.enabled !== false)).toBe(true);
  });

  it('a model this person cannot use comes after a heading that names the remedy, dim with why, and cannot be chosen (dimmed, never hidden)', () => {
    const rows = modelRows(
      [
        model('gemini-2.5-pro', 'gemini', { available: false, unavailableReason: 'no-key' }),
        model(OPENAI, 'openai'),
        model('gpt-x', 'openai', { available: false, unavailableReason: 'not-on-key' }),
      ],
      undefined,
      NAME,
    );
    expect(rows.map((row) => row.id)).toEqual([
      OPENAI,
      MODELS_REFRESH_ROW,
      'unavailable-section',
      'gemini-2.5-pro',
      'gpt-x',
    ]);
    expect(rows[2]).toMatchObject({
      label: 'Unavailable: /providers on the Home connects a key',
      section: true,
      enabled: false,
    });
    expect(rows[3]).toMatchObject({ enabled: false, reason: 'no key for Gemini' });
    expect(rows[4]).toMatchObject({ enabled: false, reason: 'OpenAI · unavailable on your key' });
    // The facts stay on a dim row for the filter (a provider's name finds its models), and only the reason is drawn.
    expect(rows[3]?.detail).toContain('Gemini');
  });

  it('marks the model in force where it is, a dim one too', () => {
    const rows = modelRows(
      [model('gemini-2.5-pro', 'gemini', { available: false, unavailableReason: 'no-key' })],
      'gemini-2.5-pro',
      NAME,
    );
    expect(rows.at(-1)?.reason).toBe('current · no key for Gemini');
  });

  it('a dated pin whose row the catalog collapsed onto its rolling alias is marked on the alias; an id that is not listed marks nothing', () => {
    const entries = [model('claude-sonnet-4-5', 'anthropic')];
    expect(markedCurrent(entries, 'claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
    expect(markedCurrent(entries, 'claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
    expect(markedCurrent(entries, 'gpt-5')).toBeUndefined();
    expect(markedCurrent(entries, undefined)).toBeUndefined();
    expect(modelRows(entries, 'claude-sonnet-4-5-20250929', NAME)[0]?.detail).toMatch(
      /^current · /u,
    );
  });

  it('the provider of the model in force is the host’s when it knows it, else its row’s, else unknown', () => {
    expect(currentProviderOf(CATALOG, OPENAI, 'anthropic')).toBe('anthropic');
    expect(currentProviderOf(CATALOG, OPENAI, undefined)).toBe('openai');
    expect(currentProviderOf(CATALOG, 'not-listed', undefined)).toBeUndefined();
  });
});

describe('the line above the rows (the refresh never blocks, and says so: ADR-0064 §5c)', () => {
  const view = { entries: CATALOG, refreshedAt: NOW - 3 * 60_000 };
  it('says how many models of how many providers and how fresh, a refresh in flight, or the providers it could not reach', () => {
    expect(catalogHeading(view, { kind: 'idle' }, NOW, NAME)).toEqual({
      status: 'completed',
      statusWord: 'completed',
      text: '5 models · 3 providers · updated 3m ago',
    });
    expect(catalogHeading(view, { kind: 'refreshing' }, NOW, NAME)).toEqual({
      status: 'running',
      statusWord: 'running',
      text: '5 models · 3 providers · refreshing…',
    });
    expect(catalogHeading(view, { kind: 'failed', providers: ['openai'] }, NOW, NAME)).toEqual({
      status: 'warning',
      statusWord: 'warning',
      text: "couldn't refresh OpenAI — showing last-known models",
    });
    // A failed refresh that names no provider is the list as it is.
    expect(catalogHeading(view, { kind: 'failed', providers: [] }, NOW, NAME).status).toBe(
      'completed',
    );
    expect(
      catalogHeading(
        { entries: [model(GRADED, 'anthropic')], refreshedAt: undefined },
        { kind: 'idle' },
        NOW,
        NAME,
      ),
    ).toEqual({
      status: 'pending',
      statusWord: 'pending',
      text: '1 model · 1 provider · never refreshed',
    });
  });

  it('an empty catalog is the loading state while a refresh fills it, and the empty state after: what to do, in the TUI', () => {
    const empty = { entries: [], refreshedAt: undefined };
    expect(modelsListContent(empty, undefined, { kind: 'refreshing' }, NOW, NAME)).toBe(
      MODELS_LOADING,
    );
    const after = modelsListContent(empty, undefined, { kind: 'idle' }, NOW, NAME);
    expect(after).toMatchObject({ kind: 'empty', what: 'No models yet.' });
    if (after.kind !== 'empty') throw new Error('empty');
    expect(after.next).toContain('/providers on the Home');
    expect(after.next).toContain('open /models again');
    expect(after.next).not.toMatch(/relavium /u);
    expect(MODELS_READ_FAILED).toMatchObject({ kind: 'error' });
    expect(MODELS_SETTINGS_FAILED).toMatchObject({ kind: 'error' });
  });
});

/** The facts of the second step: the chat bound to the graded Anthropic model at `medium`, a writer wired. */
const facts = (over: Partial<ScopeFacts> & Pick<ScopeFacts, 'entry'>): ScopeFacts => ({
  scope: 'chat',
  current: GRADED,
  currentProvider: 'anthropic',
  currentEffort: 'medium',
  canSaveDefault: true,
  providerName: NAME,
  ...over,
});
const entry = (id: string) => {
  const found = CATALOG.find((candidate) => candidate.modelId === id);
  if (found === undefined) throw new Error(id);
  return found;
};

describe('the second step in a chat (popup-models-step2-80x24.png)', () => {
  it('another provider’s model: its summary, its tiers opened on the tier in force, and where it applies, `This chat` stating where the conversation goes', () => {
    const form = scopeForm(facts({ entry: entry(OPENAI) }));
    expect(form.summary).toBe('gpt-5  400K ctx · $1.25 / $10 per M · OpenAI');
    expect(form.tabs).toMatchObject({
      label: 'Reasoning effort',
      verb: 'effort',
      initial: 'medium',
    });
    expect(form.tabs?.options.map((option) => option.id)).toEqual(['low', 'medium', 'high']);
    expect(form.radio).toMatchObject({ label: 'Apply to', verb: 'scope', initial: 'chat' });
    expect(form.radio?.options.map((option) => [option.id, option.label, option.detail])).toEqual([
      ['chat', 'This chat', 'switches the model now; the conversation stays'],
      ['new', 'New chats', 'saves it as your default; this chat stays'],
    ]);
    expect(form.radio?.options[0]?.warning).toBe(
      'This chat moves from Anthropic to OpenAI. Your messages and short tool receipts are sent to OpenAI.',
    );
    // `New chats` moves nothing of this chat: no line, and the form has none of its own.
    expect(form.radio?.options[1]?.warning).toBeUndefined();
    expect(form.warning).toBeUndefined();
  });

  it('a model of the same provider says nothing leaves; the model in force says what `This chat` does with it', () => {
    expect(scopeForm(facts({ entry: entry(BUDGET) })).radio?.options[0]?.warning).toBeUndefined();
    const same = scopeForm(facts({ entry: entry(GRADED) }));
    expect(same.radio?.options[0]).toMatchObject({
      detail: 'applies the effort now; the conversation stays',
      warning: undefined,
    });
    const noTier = scopeForm(
      facts({ entry: entry(NO_TIER), current: NO_TIER, currentProvider: 'openai' }),
    );
    expect(noTier.tabs).toBeUndefined();
    expect(noTier.radio?.options[0]?.detail).toBe('keeps this model; nothing changes');
  });

  it('a budget model’s tiers read off and on, opened on the one that represents the tier in force', () => {
    const form = scopeForm(facts({ entry: entry(BUDGET), currentEffort: 'high' }));
    expect(form.tabs?.options.map((option) => [option.id, option.label])).toEqual([
      ['off', 'off'],
      ['medium', 'on'],
    ]);
    expect(form.tabs?.initial).toBe('medium');
    // No tier in force opens on the neutral `medium`, projected (never on `off` by accident).
    expect(scopeForm(facts({ entry: entry(BUDGET), currentEffort: undefined })).tabs?.initial).toBe(
      'medium',
    );
  });

  it('the provider in force unknown: the line still says where the conversation goes', () => {
    expect(
      scopeForm(facts({ entry: entry(OPENAI), currentProvider: undefined })).radio?.options[0]
        ?.warning,
    ).toBe('This chat moves to OpenAI. Your messages and short tool receipts are sent to OpenAI.');
  });

  it('a chat that cannot save a default has no radio: `Enter` applies to this chat, and the line is the form’s own', () => {
    const form = scopeForm(facts({ entry: entry(OPENAI), canSaveDefault: false }));
    expect(form.radio).toBeUndefined();
    expect(form.warning).toBe(
      'This chat moves from Anthropic to OpenAI. Your messages and short tool receipts are sent to OpenAI.',
    );
  });
});

describe('the second step on the bare Home (no live chat: the choice is the default of new chats)', () => {
  it('has no radio, and says where new chats go when the provider changes', () => {
    const form = scopeForm(facts({ entry: entry(OPENAI), scope: 'home' }));
    expect(form.radio).toBeUndefined();
    expect(form.tabs?.options.map((option) => option.id)).toEqual(['low', 'medium', 'high']);
    expect(form.warning).toBe(
      'New chats move from Anthropic to OpenAI. Your messages in them are sent to OpenAI.',
    );
    expect(scopeForm(facts({ entry: entry(BUDGET), scope: 'home' })).warning).toBeUndefined();
    expect(dataLeavesWarning('new-chats', undefined, 'openai', NAME)).toBe(
      'New chats start on OpenAI. Your messages in them are sent to OpenAI.',
    );
  });
});

describe('the spec, its legends and its answers', () => {
  const list = modelsListContent(
    { entries: CATALOG, refreshedAt: undefined },
    GRADED,
    { kind: 'idle' },
    NOW,
    NAME,
  );

  it('two steps, `Model` and `Effort & scope`: the list typed into, opened on the model in force, `Enter next`; the form `Enter apply`', () => {
    const spec = modelsSpec('chat', 'chat', list, GRADED);
    expect(spec).toMatchObject({ id: 'models', title: '/models', origin: 'chat' });
    expect(spec.steps.map((step) => step.name)).toEqual(['Model', 'Effort & scope']);
    expect(spec.steps[0]).toMatchObject({ enter: 'next', filter: true, initialRow: GRADED });
    expect(spec.steps[1]).toMatchObject({ enter: 'apply' });
    expect(modelsSpec('home', 'home', list, GRADED).steps[1]).toMatchObject({
      enter: 'set default',
    });
  });

  it('the first step’s legend names select, next and the way back; the second names the form’s keys and steps back', () => {
    const frame = openFrame(modelsSpec('chat', 'chat', list, GRADED), 1);
    const first = withGlyphForm(false, () => popupLegend(frame));
    expect(first.items).toEqual([
      { keys: '↑/↓', verb: 'select' },
      { keys: 'Enter', verb: 'next' },
    ]);
    expect(first.exit).toMatchObject({ class: 'close', keys: 'Esc' });
    const form = scopeForm(facts({ entry: entry(OPENAI) }));
    const second = { ...withContent(frame, 1, form), stepIndex: 1 };
    const legend = withGlyphForm(false, () => popupLegend(second));
    expect(legend.items).toEqual([
      { keys: '←/→', verb: 'effort' },
      // Not the frame's `apply to`: with it the row is 67 columns and `[Ctrl+C] close` is dropped at the floor (see below).
      { keys: '↑/↓', verb: 'scope' },
      { keys: 'Enter', verb: 'apply' },
      { keys: 'Ctrl+C', verb: 'close' },
    ]);
    expect(legend.exit).toMatchObject({ class: 'step', keys: 'Esc', verb: 'back' });
    // The whole row, every key of it, fits the inner width of a popup at the floor (66) in both glyph forms: nothing is dropped from it.
    for (const plain of [false, true])
      withGlyphForm(plain, () => {
        const row = popupLegend(second);
        expect(displayWidth(legendText(row.items, row.exit))).toBeLessThanOrEqual(
          popupInnerWidth(POPUP_FLOOR.columns, 'standard'),
        );
      });
  });

  it('the choice is the model and the tier its tabs offered; where it applies is the radio’s, or the default on the Home', () => {
    expect(choiceOf(entry(OPENAI), { tab: 'high', radio: 'chat' })).toEqual({
      modelId: OPENAI,
      provider: 'openai',
      reasoningEffort: 'high',
    });
    // A tier the model does not take is no tier (a form for another model left it): never sent.
    expect(choiceOf(entry(OPENAI), { tab: 'max' })).toEqual({
      modelId: OPENAI,
      provider: 'openai',
    });
    expect(choiceOf(entry(NO_TIER), {})).toEqual({ modelId: NO_TIER, provider: 'openai' });
    expect(scopeOfValues('chat', { radio: 'chat' })).toBe('this-chat');
    expect(scopeOfValues('chat', { radio: 'new' })).toBe('new-chats');
    expect(scopeOfValues('chat', {})).toBe('this-chat');
    expect(scopeOfValues('home', { radio: 'chat' })).toBe('new-chats');
  });
});

describe('the inline page holds the tallest second step whole (ADR-0148 §4: a form is never windowed)', () => {
  it.each([
    ['a chat, another provider, tiers', facts({ entry: entry(OPENAI) })],
    ['the bare Home, another provider, tiers', facts({ entry: entry(OPENAI), scope: 'home' })],
    [
      'a chat, providers with long names',
      facts({
        entry: model('a-model', 'openai'),
        providerName: (id) => `${id} with a much longer display name`,
      }),
    ],
  ])('%s: wholly on a ten-row page of 66 columns, so `Enter` applies', (_name, scope) => {
    const form = scopeForm(scope);
    // The inline page is ten rows (`INLINE_LIST_MAX_ROWS`), the floor's row 66 columns.
    expect(formFits(form, 10, 66)).toBe(true);
    const geometry = popupGeometry({
      columns: 80,
      rows: 24,
      kind: 'standard',
      placement: 'replace',
      rail: true,
      bodyRows: 10,
    });
    if (!geometry.fits) throw new Error('fits');
    const body = withGlyphForm(true, () =>
      popupBody(form, { selected: 0, offset: 0, tab: 0 }, geometry),
    );
    expect(body.lines.some((line) => line.text.includes('more'))).toBe(false);
  });
});

describe('what a choice announces (the host’s channel, at most 54 columns)', () => {
  const SAVED: DefaultModelSaveResult = {
    kind: 'saved',
    durability: 'confirmed',
    effect: 'applies',
  };
  const ALL: readonly DefaultModelSaveResult[] = [
    SAVED,
    { ...SAVED, durability: 'unconfirmed' },
    { ...SAVED, effect: 'overridden' },
    { ...SAVED, effect: 'unknown' },
    { kind: 'refused', reason: 'symlink' },
    { kind: 'refused', reason: 'failed' },
    { kind: 'refused', reason: 'cancelled' },
  ];

  it('names the default and where it applies, or why it does not apply here, or why it was not saved', () => {
    expect(defaultModelAnnouncement(OPENAI, SAVED)).toBe(
      'Default model: gpt-5 · applies to new chats',
    );
    expect(ALL.map((result) => defaultModelAnnouncement(OPENAI, result))).toEqual([
      'Default model: gpt-5 · applies to new chats',
      'Default model saved; durability unconfirmed',
      'Saved as default; a project or workspace overrides it',
      'Saved as default; the config could not be read back',
      'Default not saved: the config is a symbolic link',
      'The default model could not be saved',
      'Default model unchanged',
    ]);
    // The host is closing: nothing is said.
    expect(
      defaultModelAnnouncement(OPENAI, { kind: 'refused', reason: 'closing' }),
    ).toBeUndefined();
  });

  it('a long id falls back to the shorter sentence, then is cut with the ellipsis; never past 54 columns', () => {
    expect(defaultModelAnnouncement('claude-sonnet-4-5-20250929', SAVED)).toBe(
      'Default for new chats: claude-sonnet-4-5-20250929',
    );
    const long = 'm'.repeat(80);
    for (const result of ALL) {
      const said = defaultModelAnnouncement(long, result);
      expect(displayWidth(said ?? ''), JSON.stringify(result)).toBeLessThanOrEqual(
        POPUP_NOTICE_MAX_COLUMNS,
      );
    }
    for (const said of [alreadyOnAnnouncement(long), alreadyDefaultAnnouncement(long)])
      expect(displayWidth(said)).toBeLessThanOrEqual(POPUP_NOTICE_MAX_COLUMNS);
    expect(alreadyOnAnnouncement(long).endsWith('…')).toBe(true);
    expect(alreadyOnAnnouncement(GRADED)).toBe('Already on claude-sonnet-4-6.');
    expect(alreadyDefaultAnnouncement(GRADED)).toBe('Already the default: claude-sonnet-4-6');
  });

  it('every sentence of every result fits with an id of the longest common length', () => {
    for (const id of [GRADED, OPENAI, 'claude-sonnet-4-5-20250929', 'gpt-5.4-pro-2026-03-05'])
      for (const result of ALL)
        expect(displayWidth(defaultModelAnnouncement(id, result) ?? '')).toBeLessThanOrEqual(
          POPUP_NOTICE_MAX_COLUMNS,
        );
  });
});

describe('the one scrub holds every sink of the popup (a catalog, a provider and a model write these strings)', () => {
  // Built at runtime (no contiguous secret literal: leakwatch).
  const SECRET = ['sk', 'ant', 'scrub', 'ABCDEF1234567890XYZ'].join('-');
  const EVIL = `x\u001b[31m [Ctrl+Y] allow · [d] ${SECRET} ✓› ‮`;
  const evilName = (): string => EVIL;
  const hostile = model(EVIL, 'openai', { displayName: EVIL });
  const dim = {
    ...model(`${EVIL}-dim`, 'openai'),
    available: false,
    unavailableReason: 'no-key' as const,
  };

  const SINKS: readonly (readonly [name: string, drawn: () => string])[] = [
    [
      'a row’s label and detail (the id, the provider’s name)',
      () =>
        modelRows([hostile], EVIL, evilName)
          .map((row) => `${row.label} ${row.detail ?? ''}`)
          .join('\n'),
    ],
    [
      'a dim row’s reason',
      () =>
        modelRows([dim], undefined, evilName)
          .map((row) => row.reason ?? '')
          .join('\n'),
    ],
    [
      'the line above the rows (a provider a refresh could not reach)',
      () =>
        catalogHeading(
          { entries: [hostile], refreshedAt: NOW },
          { kind: 'failed', providers: [EVIL] },
          NOW,
          evilName,
        ).text,
    ],
    [
      'the second step’s summary, tiers and radio',
      () => {
        const form = scopeForm(facts({ entry: hostile, providerName: evilName }));
        return [
          form.summary ?? '',
          ...(form.radio?.options.map((option) => option.detail ?? '') ?? []),
        ].join('\n');
      },
    ],
    [
      'the data-leaves line, in a chat and on the Home',
      () =>
        [
          dataLeavesWarning('this-chat', EVIL, 'openai', evilName),
          dataLeavesWarning('new-chats', EVIL, 'openai', evilName),
        ].join('\n'),
    ],
    [
      'what a choice announces',
      () =>
        [
          defaultModelAnnouncement(EVIL, {
            kind: 'saved',
            durability: 'confirmed',
            effect: 'applies',
          }),
          alreadyOnAnnouncement(EVIL),
          alreadyDefaultAnnouncement(EVIL),
        ].join('\n'),
    ],
  ];

  it.each(SINKS)('%s carries none of it', (_name, drawn) => {
    const text = drawn();
    expect(text).toContain('x');
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('‮');
    expect(text).not.toContain('[Ctrl+Y]');
    expect(text).not.toContain('allow ·');
    expect(text).not.toContain('· [d]');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('ABCDEF1234567890XYZ');
    expect(text).not.toContain('›');
  });

  it('is the one function the sinks call: a row’s label is exactly the scrubbed id', () => {
    expect(modelRows([hostile], undefined, NAME)[0]?.label).toBe(scrubPopupText(EVIL));
  });

  it('what is drawn of a hostile row stays within its row and carries no escape (the frame’s own sanitiser after the scrub)', () => {
    const geometry = popupGeometry({
      columns: 80,
      rows: 24,
      kind: 'standard',
      placement: 'overlay',
      rail: true,
    });
    if (!geometry.fits) throw new Error('fits');
    const content = modelsListContent(
      { entries: [hostile, dim], refreshedAt: NOW },
      EVIL,
      { kind: 'idle' },
      NOW,
      evilName,
    );
    const body = withGlyphForm(true, () =>
      popupBody(listOf(content), { selected: 0, offset: 0, filter: '' }, geometry),
    );
    for (const line of body.lines) {
      expect(displayWidth(line.text)).toBeLessThanOrEqual(geometry.innerWidth);
      expect(line.text).not.toContain('\u001b');
    }
    const form: PopupForm = scopeForm(
      facts({ entry: hostile, providerName: evilName, currentProvider: EVIL }),
    );
    for (const line of withGlyphForm(true, () =>
      popupBody(form, { selected: 0, offset: 0 }, geometry),
    ).lines)
      expect(line.text).not.toContain('\u001b');
  });
});
