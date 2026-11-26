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
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import { pasteIsEditable, type PasteEditableFlags } from './chat-input.js';
import { createChatStore } from './chat-store.js';
import { createHomeController, homeOverlayFlags, type HomeChatSession } from './home-controller.js';
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
import { INITIAL_REVERSE_SEARCH } from './input-history.js';
import { openPalette } from './palette-reducer.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';
import { stripRefreshPaused } from './strip-pause.js';
import type { HomeSnapshot } from '../../home/home-store.js';

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

/** What the three submodes share: the palette adds the landing's two gates (it is the one that opens on the landing). */
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
 * The cells that disagree with their neighbours, and why they are kept (the nine disagreements are the table in `overlay-flags.ts`):
 * - `screen` pauses the strip and the notice paging, but is not a slot gate (a screen REPLACES the slot) and is never open in a chat.
 * - `exitGuard` is a slot gate, a strip gate and an Active-poll gate, but not a scroll, pointer or interrupt one (it is routed first).
 * - `nativePrompt` closes the pointer, the scroll keys, the mouse capture and the custody, and does NOT pause the strip
 *   (`nativeActionBusy`, which is set with it, does). Its rows are `replacesBody`'s (ADR-0148 §2): a prompt drawn as a popup in the overlay
 *   keeps the body drawn behind it, so owning the keys and taking the rows are two flags.
 * - `popup` closes what a submode closes except the prompt (the body, its prompt and its hint stay drawn behind a popup), and also the Active
 *   poll and the notice paging, and REVOKES the custody (a card under a popup answers nothing); it keeps the mouse captured.
 * - `replacesBody` takes the rows and nothing else: it is never set alone.
 * - `nativeActionBusy` is not a slot gate (three of the slot's five callers check it themselves).
 * - The four cards close the pointer (`approval` does not: it is always paired with `review`) and nothing else here: their own host
 *   answers every key, and `approval` and `review` close the paste through `pasteFlagsFrom` (`approvalPending`).
 */
const EXPECTED = {
  palette: { ...SUBMODE, landingPromptHidden: true, noticePaging: true },
  search: SUBMODE,
  mention: SUBMODE,
  screen: { ...OPEN, stripPause: true, noticePaging: true },
  exitGuard: { ...OPEN, screenSlot: true, stripPause: true, activePoll: true, noticePaging: true },
  nativePrompt: {
    ...OPEN,
    scrollKeys: true,
    pointer: true,
    mouseReleased: true,
    custodyRevoked: true,
  },
  popup: {
    ...OPEN,
    screenSlot: true,
    scrollKeys: true,
    pointer: true,
    interrupt: true,
    stripPause: true,
    activePoll: true,
    noticePaging: true,
    custodyRevoked: true,
  },
  replacesBody: { ...OPEN, occupiesRows: true },
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
    interrupt: interruptContextFrom(flags)?.kind === 'overlay',
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

/**
 * The flags `pasteFlagsFrom` does NOT read, each with the reason: the paste is decided before the overlay gate by its host, so a new flag has
 * to say either that it is read there or that it is decided before. A flag in neither place fails the test below instead of silently letting a
 * paste into the composer.
 */
const DECIDED_BEFORE_PASTE: Readonly<Partial<Record<keyof OverlayFlags, string>>> = {
  screen:
    'a screen owns every key, and no paste reaches the prompt behind it (the Home drops it before the gate)',
  exitGuard: 'the exit-guard card answers a paste as a key it ignores, before the gate',
  nativePrompt: 'the native prompt channel takes the paste into its own field, before the gate',
  popup:
    'an open popup takes the paste into its own text field or drops it, before the gate (typed text goes only into a text field)',
  replacesBody:
    'never set alone: a native prompt or a popup owns the keys whenever it is set, and decides the paste before the gate',
  nativeActionBusy:
    'every key and paste is dropped while a native action is in flight, before the gate',
  question: 'an open `ask_user` question takes the paste into its own field, before the gate',
  checkpoint: 'a continue-checkpoint card drops a paste: it answers by key only, before the gate',
};

describe('every flag is read by the paste gate or decided before it (a new overlay cannot forget it)', () => {
  const kinds = Object.keys(NO_OVERLAYS) as (keyof OverlayFlags)[];
  const readByPaste = (kind: keyof OverlayFlags): boolean => {
    const base = Object.values(pasteFlagsFrom(NO_OVERLAYS));
    const set = Object.values(pasteFlagsFrom({ ...NO_OVERLAYS, [kind]: true }));
    return set.some((value, index) => value !== base[index]);
  };

  it.each(kinds)('%s', (kind) => {
    const read = readByPaste(kind);
    const reason = DECIDED_BEFORE_PASTE[kind];
    expect(
      read !== (reason !== undefined),
      read
        ? `${kind} is read by pasteFlagsFrom, so it is not in DECIDED_BEFORE_PASTE`
        : `${kind} is not read by pasteFlagsFrom: say in DECIDED_BEFORE_PASTE why a paste is decided before it`,
    ).toBe(true);
    if (reason !== undefined) expect(reason.length).toBeGreaterThan(10);
  });

  it('lists no flag the record does not have', () => {
    for (const kind of Object.keys(DECIDED_BEFORE_PASTE)) expect(kinds).toContain(kind);
  });
});

describe('the paste half of the record feeds the shared paste gate', () => {
  it('names each overlay field of the gate from exactly one flag, and the approval from either of its two', () => {
    expect(pasteFlagsFrom(NO_OVERLAYS)).toEqual({
      paletteOpen: false,
      searchOpen: false,
      mentionOpen: false,
      approvalPending: false,
    });
    expect(pasteFlagsFrom({ ...NO_OVERLAYS, palette: true })).toMatchObject({ paletteOpen: true });
    expect(pasteFlagsFrom({ ...NO_OVERLAYS, search: true })).toMatchObject({ searchOpen: true });
    expect(pasteFlagsFrom({ ...NO_OVERLAYS, mention: true })).toMatchObject({ mentionOpen: true });
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
      ['approvalPending', 'mentionOpen', 'paletteOpen', 'searchOpen'].sort(),
    );
  });
});

describe('the interrupt context of an overlay', () => {
  it('is the overlay kind for each submode, and nothing else gives it one', () => {
    for (const kind of ['palette', 'search', 'mention'] as const)
      expect(interruptContextFrom(only(kind))).toEqual({ kind: 'overlay' });
    expect(interruptContextFrom(NO_OVERLAYS)).toBeUndefined();
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
  failedRuns: [],
  recentSessions: [],
  recentRuns: [],
  recentAgents: [],
  unreadableRuns: [],
  totals: { attention: 0, sessions: 0, runs: 0 },
  isEmpty: true,
};

describe("the Home's own record is built from its state in one place", () => {
  const controller = createHomeController({
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
    ['palette', { palette: openPalette([], 'down') }],
    ['search', { search: INITIAL_REVERSE_SEARCH }],
    ['mention', { mention: { dir: '', filter: '', candidates: [], selected: 0, loading: false } }],
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

/**
 * "A list was missed", for the custody predicates (ADR-0148 §2): every place a host decides whether a card, the landing or a popup holds the
 * approval's custody is written here, one row per site, with what it must read. A site that reads the record revokes custody under every flag
 * that closes `revokesCustody` (a native prompt, a popup); the popup's own custody is the one that must NOT read the record (the popup flag
 * would revoke the popup's own frame) and must read the native prompt instead (a native card over a popup takes the keys). A new custody site
 * fails the count until it is written here with what it reads.
 */
const CUSTODY_SITES: Readonly<Record<string, readonly ('record' | 'relay' | 'popup-own')[]>> = {
  // the chat region's three cards relay the host's `reviewCustody`; the landing's frame (the exit guard, the strip's Enter); a gate or budget
  // card; the popup's own; the `reviewCustody` the host hands the chat region (review, question, checkpoint)
  'render/tui/home-app.tsx': ['relay', 'relay', 'relay', 'record', 'record', 'popup-own', 'record'],
  // the approval card, the question card, the checkpoint card; the popup's own
  'render/tui/chat-ink.tsx': ['popup-own', 'record', 'record', 'record'],
};

/** The initializer text of every `hasCustody` / `reviewCustody` property or JSX attribute in `file`, in source order. */
function custodySites(file: string): string[] {
  const text = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const named = (name: ts.Node): boolean =>
    ts.isIdentifier(name) && (name.text === 'hasCustody' || name.text === 'reviewCustody');
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && named(node.name)) found.push(node.initializer.getText(sf));
    if (ts.isJsxAttribute(node) && named(node.name) && node.initializer !== undefined)
      found.push(node.initializer.getText(sf));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe('every custody predicate of the hosts derives from the record (a list was missed: custody)', () => {
  it.each(Object.entries(CUSTODY_SITES))('%s', (file, expected) => {
    const sites = custodySites(file);
    expect(sites.length, `the custody sites of ${file}: write a new one into CUSTODY_SITES`).toBe(
      expected.length,
    );
    sites.forEach((site, index) => {
      if (expected[index] === 'relay')
        expect(site, `${file} site ${String(index + 1)} relays the host's own custody`).toBe(
          '{props.reviewCustody}',
        );
      else if (expected[index] === 'record')
        expect(
          /holdsCustody\(liveOverlays\(\)\)|acceptsInput\(\)/u.test(site),
          `${file} site ${String(index + 1)} must read the record: ${site}`,
        ).toBe(true);
      else {
        expect(site, `${file} site ${String(index + 1)} is the popup's own custody`).not.toMatch(
          /holdsCustody|acceptsInput/u,
        );
        expect(
          site,
          `${file} site ${String(index + 1)}: a native prompt over a popup takes its custody`,
        ).toMatch(/nativePrompt|modePrompt/u);
      }
    });
  });

  it('the stand-alone chat’s `acceptsInput`, which its card sites read, is the record’s custody', () => {
    const text = readFileSync(new URL('./chat-ink.tsx', import.meta.url), 'utf8');
    expect(text).toMatch(
      /const acceptsInput = \(\): boolean =>\s+props\.inputEnabled\?\.\(\) !== false && holdsCustody\(liveOverlays\(\)\);/u,
    );
  });

  it('revokes custody under a popup, a native prompt, and nothing a submode or a card sets', () => {
    for (const kind of Object.keys(NO_OVERLAYS)) {
      const revoked = !holdsCustody(only(kind));
      expect(revoked, kind).toBe(kind === 'popup' || kind === 'nativePrompt');
    }
  });
});

/**
 * "A list was missed", for the pause facts: the strip's refresh and the Active tab's poll are paused by the record the controller builds, and
 * that record has the popup in it (from its `popupOpen` port), so a popup gates the five-second synchronous database poll behind it.
 */
describe('every pause fact derives from the record (a list was missed: pauses)', () => {
  const controllerText = readFileSync(new URL('./home-controller.ts', import.meta.url), 'utf8');

  it('the controller’s record adds the popup from its port, and every pause reads that record', () => {
    expect(controllerText).toMatch(
      /const overlayFlags = \(\): OverlayFlags => \(\{\s+\.\.\.homeOverlayFlags\(state\),\s+popup: deps\.popupOpen\?\.\(\) === true,\s+\}\);/u,
    );
    expect(controllerText).toMatch(
      /stripRefreshPaused\(\{ mode: state\.mode, \.\.\.overlayFlags\(\), terminal \}\)/u,
    );
    expect(controllerText).toMatch(/activePollPausedByOverlay\(overlayFlags\(\)\)/u);
  });

  it.each(Object.keys(NO_OVERLAYS))(
    'the strip pause facts carry %s (the whole record is required)',
    (kind) => {
      const facts = { mode: 'home' as const, ...only(kind), terminal: LANDING };
      expect(Object.keys(facts)).toContain(kind);
      expect(stripRefreshPaused(facts)).toBe(stripPausedByOverlay(only(kind)));
    },
  );

  it('a popup the controller is told of closes its screen slot (the controller’s gates see it)', () => {
    let open = true;
    const controller = createHomeController({
      startChat: () => Promise.reject(new Error('not started in this test')),
      homeStore: { read: () => EMPTY },
      onExit: vi.fn(),
      onError: vi.fn(),
      popupOpen: () => open,
    });
    controller.openScreen('help');
    expect(controller.getSnapshot().screen, 'refused under a popup').toBeUndefined();
    open = false;
    controller.openScreen('help');
    expect(controller.getSnapshot().screen?.kind).toBe('help');
  });
});
