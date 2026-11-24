/**
 * The one record of what owns the keyboard ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2), pinned flag by flag. The table below is written by hand, one row per flag and one column per gate, and each row is compared with what
 * the module's own selectors answer when ONLY that flag is set, so:
 *
 * - a flag added to `OverlayFlags` without a row here does not compile (`satisfies Record<keyof OverlayFlags, Gates>`), and a row for a flag
 *   that is gone does not either: this is the "a list was missed" detector;
 * - a cell that changes in `overlay-flags.ts` fails its own row, naming the gate, and no other cell can cover for it;
 * - the disagreements between the gates (a screen pauses the strip but does not close the slot, a card closes the pointer but not the
 *   scroll keys, ...) are the cells that differ across a row, and they are PRESERVED history, so a "tidy-up" that unifies two of them is
 *   a behaviour change this file refuses.
 */
import { describe, expect, it, vi } from 'vitest';

import { pasteIsEditable, type PasteEditableFlags } from './chat-input.js';
import { createChatStore } from './chat-store.js';
import { createHomeController, homeOverlayFlags, type HomeChatSession } from './home-controller.js';
import { initialEffortPickerState } from './effort-picker.js';
import {
  activePollPausedByOverlay,
  cardFlagsFrom,
  holdsCustody,
  interruptContextFrom,
  landingPromptHidden,
  mouseCapturedFrom,
  NO_OVERLAYS,
  noticePagingBlocked,
  occupiesRows,
  overlayOwnsKeyboard,
  pasteFlagsFrom,
  pointerBlocked,
  promptHidden,
  scrollKeysBlocked,
  screenSlotBlocked,
  stripPausedByOverlay,
  type OverlayFlags,
} from './overlay-flags.js';
import { INITIAL_PALETTE_STATE } from './palette-reducer.js';
import { INITIAL_REVERSE_SEARCH } from './input-history.js';
import { permissionsChatSheet } from './chat-sheet.js';
import { initialPermissionsSheetState } from './permissions-sheet.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import { stripRefreshPaused } from './strip-pause.js';
import type { HomeSnapshot } from '../../home/home-store.js';
import type { ModelPickerState } from './model-picker.js';

/** What each gate answers for a record: `true` ⇒ the flag CLOSES the gate. `ownsKeyboard` is not a column: every flag owns it (below). */
interface Gates {
  /** The Home's screen slot refuses a screen. */
  readonly screenSlot: boolean;
  /** The shared paste gate refuses a paste (`pasteIsEditable`, work flags clear). */
  readonly pasteBlocked: boolean;
  /** `PgUp`/`PgDn`/`Ctrl+Home`/`Ctrl+End` do not scroll the in-Home chat. */
  readonly scrollKeys: boolean;
  /** A wheel or click report is consumed without moving the transcript. */
  readonly pointer: boolean;
  /** The host does not capture the mouse for the chat. */
  readonly mouseReleased: boolean;
  /** A first `Ctrl+C` closes the overlay (a chat is on screen). */
  readonly interrupt: boolean;
  /** The Home's strip does not refresh (on a landing, 80×24). */
  readonly stripPause: boolean;
  /** The tab host's Active tab does not poll. */
  readonly activePoll: boolean;
  /** The chat region draws no idle prompt. */
  readonly promptHidden: boolean;
  /** The landing draws no prompt. */
  readonly landingPromptHidden: boolean;
  /** `PgUp`/`PgDn` do not page the landing's notice. */
  readonly noticePaging: boolean;
  /** The flag's body takes the screen's rows. */
  readonly occupiesRows: boolean;
  /** The approval's keyboard custody is not held. */
  readonly custodyRevoked: boolean;
}

const OPEN: Gates = {
  screenSlot: false,
  pasteBlocked: false,
  scrollKeys: false,
  pointer: false,
  mouseReleased: false,
  interrupt: false,
  stripPause: false,
  activePoll: false,
  promptHidden: false,
  landingPromptHidden: false,
  noticePaging: false,
  occupiesRows: false,
  custodyRevoked: false,
};

/** What the six submodes share: the palette and the model picker add the landing's two gates. */
const SUBMODE: Gates = {
  ...OPEN,
  screenSlot: true,
  pasteBlocked: true,
  scrollKeys: true,
  pointer: true,
  interrupt: true,
  stripPause: true,
  promptHidden: true,
};

/**
 * THE TABLE. One row per flag; a flag with no row (or a row with no flag) does not compile.
 *
 * The cells that disagree with their neighbours, and why they are kept (each is also in the extraction's report):
 * - `screen` pauses the strip and the notice paging, but is not a slot gate (a screen REPLACES the slot) and is never open in a chat.
 * - `exitGuard` is a slot gate, a strip gate and an Active-poll gate, but not a scroll, pointer or interrupt one (it is routed first).
 * - `nativePrompt` closes the pointer, the scroll keys, the mouse capture, the rows and the custody, and does NOT pause the strip
 *   (`nativeActionBusy`, which is set with it, does).
 * - `nativeActionBusy` is not a slot gate (three of the slot's five callers check it themselves).
 * - The four cards close the pointer (`approval` does not: it is always paired with `review`) and nothing else here: their own host
 *   answers every key, and `approval` and `review` close the paste through `pasteFlagsFrom` (`approvalPending`).
 */
const EXPECTED = {
  palette: { ...SUBMODE, landingPromptHidden: true, noticePaging: true },
  search: SUBMODE,
  mention: SUBMODE,
  modelPicker: { ...SUBMODE, landingPromptHidden: true, noticePaging: true },
  effortPicker: SUBMODE,
  chatSheet: SUBMODE,
  screen: { ...OPEN, stripPause: true, noticePaging: true },
  exitGuard: { ...OPEN, screenSlot: true, stripPause: true, activePoll: true, noticePaging: true },
  nativePrompt: {
    ...OPEN,
    scrollKeys: true,
    pointer: true,
    mouseReleased: true,
    occupiesRows: true,
    custodyRevoked: true,
  },
  nativeActionBusy: {
    ...OPEN,
    scrollKeys: true,
    pointer: true,
    mouseReleased: true,
    stripPause: true,
    activePoll: true,
  },
  approval: { ...OPEN, pasteBlocked: true },
  review: { ...OPEN, pasteBlocked: true, pointer: true },
  question: { ...OPEN, pointer: true },
  checkpoint: { ...OPEN, pointer: true },
} satisfies Record<keyof OverlayFlags, Gates>;

/** No work in flight, so the paste gate sees only the overlay half. */
const WORK_CLEAR = { running: false, shellBusy: false, submitBusy: false } as const;

const LANDING = { columns: 80, rows: 24 } as const;

/** Every gate, asked of the module's selectors. */
function observed(flags: OverlayFlags): Gates {
  return {
    screenSlot: screenSlotBlocked(flags),
    pasteBlocked: !pasteIsEditable({ ...WORK_CLEAR, ...pasteFlagsFrom(flags) }),
    scrollKeys: scrollKeysBlocked(flags),
    pointer: pointerBlocked(flags),
    mouseReleased: !mouseCapturedFrom(flags),
    interrupt: interruptContextFrom(flags, true)?.kind === 'overlay',
    stripPause: stripRefreshPaused({ mode: 'home', ...flags, terminal: LANDING }),
    activePoll: activePollPausedByOverlay(flags),
    promptHidden: promptHidden(flags),
    landingPromptHidden: landingPromptHidden(flags),
    noticePaging: noticePagingBlocked(flags),
    occupiesRows: occupiesRows(flags),
    custodyRevoked: !holdsCustody(flags),
  };
}

/** The record with exactly one flag set. `kind` is a row of {@link EXPECTED}, so it is a key of the record (the first test pins that). */
function only(kind: string): OverlayFlags {
  return { ...NO_OVERLAYS, [kind]: true };
}

const ROWS = Object.entries(EXPECTED);

describe('the record and its table agree', () => {
  it('has a row for exactly the flags the record has, and no flag is set by default', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(NO_OVERLAYS).sort());
    expect(Object.values(NO_OVERLAYS).every((set) => set === false)).toBe(true);
    for (const [kind] of ROWS) expect(kind in NO_OVERLAYS).toBe(true);
  });

  it('closes no gate and owns no key with nothing open', () => {
    expect(overlayOwnsKeyboard(NO_OVERLAYS)).toBe(false);
    expect(observed(NO_OVERLAYS)).toEqual(OPEN);
  });
});

describe('each flag, set alone, closes exactly the gates of its row', () => {
  it.each(ROWS)('%s', (kind, gates) => {
    expect(observed(only(kind))).toEqual(gates);
  });

  it.each(ROWS)('%s owns the keyboard', (kind) => {
    expect(overlayOwnsKeyboard(only(kind))).toBe(true);
  });

  it('closes, with every flag set, every gate that any flag closes, and no other', () => {
    const everything: OverlayFlags = {
      ...NO_OVERLAYS,
      ...Object.fromEntries(Object.keys(NO_OVERLAYS).map((kind) => [kind, true])),
    };
    expect(Object.values(everything).every((set) => set)).toBe(true);
    const expected = { ...OPEN };
    for (const [, gates] of ROWS) {
      for (const [gate, closed] of Object.entries(gates)) {
        if (closed) Object.assign(expected, { [gate]: true });
      }
    }
    expect(observed(everything)).toEqual(expected);
  });
});

describe('the paste half of the record feeds the shared paste gate', () => {
  it('names each overlay field of the gate from exactly one flag, and the approval from either of its two', () => {
    expect(pasteFlagsFrom(NO_OVERLAYS)).toEqual({
      paletteOpen: false,
      searchOpen: false,
      mentionOpen: false,
      modelPickerOpen: false,
      effortPickerOpen: false,
      chatSheetOpen: false,
      approvalPending: false,
    });
    expect(pasteFlagsFrom({ ...NO_OVERLAYS, palette: true })).toMatchObject({ paletteOpen: true });
    expect(pasteFlagsFrom({ ...NO_OVERLAYS, search: true })).toMatchObject({ searchOpen: true });
    expect(pasteFlagsFrom({ ...NO_OVERLAYS, mention: true })).toMatchObject({ mentionOpen: true });
    expect(pasteFlagsFrom({ ...NO_OVERLAYS, modelPicker: true })).toMatchObject({
      modelPickerOpen: true,
    });
    expect(pasteFlagsFrom({ ...NO_OVERLAYS, effortPicker: true })).toMatchObject({
      effortPickerOpen: true,
    });
    expect(pasteFlagsFrom({ ...NO_OVERLAYS, chatSheet: true })).toMatchObject({
      chatSheetOpen: true,
    });
    expect(pasteFlagsFrom({ ...NO_OVERLAYS, approval: true })).toMatchObject({
      approvalPending: true,
    });
    expect(pasteFlagsFrom({ ...NO_OVERLAYS, review: true })).toMatchObject({
      approvalPending: true,
    });
  });

  it('is exactly the overlay half of `PasteEditableFlags`: the work flags stay the host’s', () => {
    const half: Omit<PasteEditableFlags, 'running' | 'shellBusy' | 'submitBusy'> =
      pasteFlagsFrom(NO_OVERLAYS);
    expect(Object.keys(half).sort()).toEqual(
      [
        'approvalPending',
        'chatSheetOpen',
        'effortPickerOpen',
        'mentionOpen',
        'modelPickerOpen',
        'paletteOpen',
        'searchOpen',
      ].sort(),
    );
  });
});

describe('the interrupt context of an overlay', () => {
  it('is the overlay kind for each submode, and nothing else gives it one', () => {
    for (const kind of ['palette', 'search', 'mention', 'modelPicker', 'chatSheet'] as const) {
      expect(interruptContextFrom(only(kind), true)).toEqual({ kind: 'overlay' });
      expect(interruptContextFrom(only(kind), false)).toEqual({ kind: 'overlay' });
    }
    expect(interruptContextFrom(NO_OVERLAYS, true)).toBeUndefined();
  });

  it('counts the chat-scoped effort overlay only while a chat is on screen (a stale one is not an overlay the keymap closes)', () => {
    expect(interruptContextFrom(only('effortPicker'), true)).toEqual({ kind: 'overlay' });
    expect(interruptContextFrom(only('effortPicker'), false)).toBeUndefined();
  });
});

describe('the strip pause through the real predicate', () => {
  it('is paused by an overlay on a landing, and a chat or a small terminal pauses it with none', () => {
    expect(stripPausedByOverlay(NO_OVERLAYS)).toBe(false);
    expect(stripRefreshPaused({ mode: 'home', ...NO_OVERLAYS, terminal: LANDING })).toBe(false);
    expect(stripRefreshPaused({ mode: 'chat', ...NO_OVERLAYS, terminal: LANDING })).toBe(true);
    expect(
      stripRefreshPaused({ mode: 'home', ...NO_OVERLAYS, terminal: { columns: 79, rows: 24 } }),
    ).toBe(true);
  });
});

describe('the cards, read from a chat store', () => {
  it('sets each card from the presence of its field, and nothing with no chat', () => {
    expect(cardFlagsFrom(undefined)).toEqual({
      approval: false,
      review: false,
      question: false,
      checkpoint: false,
    });
    const field = {
      approval: undefined,
      review: undefined,
      question: undefined,
      checkpoint: undefined,
    };
    expect(cardFlagsFrom({ ...field, approval: {} })).toMatchObject({ approval: true });
    expect(cardFlagsFrom({ ...field, review: {} })).toMatchObject({ review: true });
    expect(cardFlagsFrom({ ...field, question: {} })).toMatchObject({ question: true });
    expect(cardFlagsFrom({ ...field, checkpoint: {} })).toMatchObject({ checkpoint: true });
    for (const kind of ['approval', 'review', 'question', 'checkpoint'] as const) {
      const flags = cardFlagsFrom({ ...field, [kind]: {} });
      expect(Object.values(flags).filter(Boolean)).toHaveLength(1);
    }
  });

  it('sees a real store’s pending approval as the approval and its review, and the paste gate refuses', async () => {
    const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
    expect(cardFlagsFrom(store.getSnapshot())).toEqual({
      approval: false,
      review: false,
      question: false,
      checkpoint: false,
    });
    const pending = store.requestApproval(
      { toolId: 'write_file', action: 'fs_write', preview: { path: 'notes.md' } } as const,
      true,
    );
    const cards = cardFlagsFrom(store.getSnapshot());
    expect(cards).toMatchObject({ approval: true, review: true });
    expect(
      pasteIsEditable({ ...WORK_CLEAR, ...pasteFlagsFrom({ ...NO_OVERLAYS, ...cards }) }),
    ).toBe(false);
    store.answerApproval({ outcome: 'reject' });
    await expect(pending).resolves.toEqual({ outcome: 'reject' });
  });
});

const EMPTY: HomeSnapshot = {
  attention: { gates: [], failedRuns: [] },
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRunIds: [],
  isEmpty: true,
};

const MODEL_PICKER: ModelPickerState = {
  entries: [],
  filter: '',
  selected: 0,
  loading: false,
  currentDefault: undefined,
  refreshedAt: undefined,
  banner: undefined,
  hint: undefined,
  phase: 'model',
  effortStep: false,
  pending: undefined,
  effortTiers: [],
  effortSelected: 0,
  currentEffort: undefined,
};

describe("the Home's own record is built from its state in one place", () => {
  const controller = createHomeController({
    doctorProbes: { keychain: () => {}, config: () => {}, toolHost: {} },
    startChat: () => Promise.reject(new Error('not started in this test')),
    homeStore: { read: () => EMPTY },
    onExit: vi.fn(),
    onError: vi.fn(),
  });
  const quiet = controller.getSnapshot();

  const session = (): HomeChatSession => ({
    store: createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND),
    sessionId: 'sess-flags',
    processLine: () => Promise.resolve(),
    shouldStop: () => false,
    stopReason: () => 'exit',
    teardown: () => Promise.resolve(),
  });

  it('holds nothing on a quiet landing, and never the native prompt (that channel is the host’s)', () => {
    expect(homeOverlayFlags(quiet)).toEqual(NO_OVERLAYS);
  });

  it.each([
    ['palette', { palette: INITIAL_PALETTE_STATE }],
    ['search', { search: INITIAL_REVERSE_SEARCH }],
    ['mention', { mention: { dir: '', filter: '', candidates: [], selected: 0, loading: false } }],
    ['modelPicker', { modelPicker: MODEL_PICKER }],
    ['effortPicker', { effortPicker: initialEffortPickerState('claude-sonnet-4-5', undefined) }],
    [
      'chatSheet',
      {
        chatSheet: permissionsChatSheet(
          initialPermissionsSheetState(
            { project: { ok: true, rows: [] }, session: undefined },
            'chat',
            'ask',
            0,
          ),
        ),
      },
    ],
    ['screen', { screen: { kind: 'help' } }],
    ['exitGuard', { exitGuard: 'confirm' }],
    ['nativeActionBusy', { nativeActionBusy: true }],
  ] as const)('sets %s from its state field, and no other flag', (kind, patch) => {
    expect(homeOverlayFlags({ ...quiet, ...patch })).toEqual(only(kind));
  });

  it('reads the cards of the live chat’s store', async () => {
    const made = session();
    const chat = { ...quiet, mode: 'chat', session: made } as const;
    expect(homeOverlayFlags(chat)).toEqual(NO_OVERLAYS);
    const pending = made.store.requestApproval(
      { toolId: 'write_file', action: 'fs_write', preview: { path: 'notes.md' } } as const,
      true,
    );
    expect(homeOverlayFlags(chat)).toEqual({ ...NO_OVERLAYS, approval: true, review: true });
    made.store.answerApproval({ outcome: 'reject' });
    await pending;
    await controller.teardownActive();
  });
});
