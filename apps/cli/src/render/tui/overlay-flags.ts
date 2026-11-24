/**
 * The one record of what can own the keyboard, and every gate that is derived from it ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2). PURE: no `ink`, `react` or `node:` import, so each gate is pinned alone (`overlay-flags.test.ts`) and the Home controller, the Home
 * host and the stand-alone chat host all ask the same functions.
 *
 * WHY ONE RECORD. "An overlay owns the keyboard" used to be written out by hand in a dozen places (the Home's screen slot, the paste flags,
 * the wheel gate, the interrupt context, the strip's refresh pause, the chat's `paletteOpen`, the custody predicates, ...), and a new overlay
 * that missed one let a key, a paste or a wheel report reach the prompt or an approval. Now an overlay is a field of {@link OverlayFlags}
 * and a row of the table below, and the compiler refuses a field with no row, a row with no field, and a host that does not fill it.
 *
 * WHAT EVERY FLAG MEANS. A flag is set while the thing it names owns every key (`overlayOwnsKeyboard`); a thing that does not own the
 * keyboard has no business here. What differs is which OTHER gates it closes, and the table says so one flag at a time. Today the gates
 * are NOT all the same set, on purpose or by history (a screen replaces the landing, a card is answered by its own host, a native prompt
 * takes the screen), and this module PRESERVES each one instead of unifying them: the disagreements are the rows of the table, each
 * pinned by `overlay-flags.test.ts`. Changing a cell is a behaviour change and belongs to its own increment.
 *
 * Which flag is set by whom:
 * - the six submodes (`palette` .. `chatSheet`) and the four cards (`approval` .. `checkpoint`) are set by both hosts;
 * - `screen`, `exitGuard` and `nativeActionBusy` exist only on the Home (the stand-alone chat holds them `false`);
 * - `nativePrompt` is the native prompt channel's, which only a HOST sees: the Home controller holds it `false`, `home-app.tsx` and
 *   `chat-ink.tsx` set it from the channel's snapshot.
 */

import type { PasteEditableFlags } from './chat-input.js';
import type { InterruptContext } from './interrupt-keymap.js';

/** One boolean per thing that owns the keyboard. A new one is a field here, a row of {@link GATES}, and a line in each host's builder. */
export interface OverlayFlags {
  /** The `/` command palette (Home and chat). */
  readonly palette: boolean;
  /** `Ctrl+R` reverse search (a chat). */
  readonly search: boolean;
  /** `@`-mention completion (a chat). */
  readonly mention: boolean;
  /** The `/models` picker (the bare Home's next-session default, or a chat's reseat). */
  readonly modelPicker: boolean;
  /** The `/effort` tier overlay (a chat). */
  readonly effortPicker: boolean;
  /** The chat's docked sheet: `/permissions` or `/agent`. */
  readonly chatSheet: boolean;
  /** A screen is in front of the landing: the run view, a gate card, the tab host or the help sheet (the Home only). */
  readonly screen: boolean;
  /** The exit-guard card (the Home only). */
  readonly exitGuard: boolean;
  /** A native prompt card or form holds the screen (the prompt channel's `active`). */
  readonly nativePrompt: boolean;
  /** A native action is in flight and every key is dropped (the Home only). */
  readonly nativeActionBusy: boolean;
  /** A per-tool approval is pending (the chat store's). */
  readonly approval: boolean;
  /** An approval's review, or the details view, is open (the chat store's). */
  readonly review: boolean;
  /** An `ask_user` question card is open (the chat store's). */
  readonly question: boolean;
  /** A continue-checkpoint card is open (the chat store's). */
  readonly checkpoint: boolean;
}

/** Nothing owns the keyboard: the base a host builds on, and what a test sets one flag over. */
export const NO_OVERLAYS: OverlayFlags = {
  palette: false,
  search: false,
  mention: false,
  modelPicker: false,
  effortPicker: false,
  chatSheet: false,
  screen: false,
  exitGuard: false,
  nativePrompt: false,
  nativeActionBusy: false,
  approval: false,
  review: false,
  question: false,
  checkpoint: false,
};

/**
 * The gates a flag can close besides owning the keyboard. Each names the site that asks, so a flag's row reads as "what this thing stops".
 *
 * - `screenSlot` — the Home's screen slot refuses to open a screen (`slotAdmits`).
 * - `scrollKeys` — `PgUp`/`PgDn`/`Ctrl+Home`/`Ctrl+End` do not scroll the in-Home chat's transcript (`altChat`).
 * - `pointer` — a wheel or click report is consumed and not routed to the transcript (the Home's `consumeMouseReport`, the chat's wheel gate).
 * - `mouseCapture` — the host does not capture the mouse for the chat, and drops a copy-on-select's feedback.
 * - `interrupt` — a first `Ctrl+C` closes the overlay instead of arming an exit (the `overlay` interrupt context).
 * - `stripPause` — the Home's strip does not refresh on its idle tick.
 * - `activePoll` — the tab host's Active tab does not poll.
 * - `promptHidden` — the chat region draws no idle prompt and footer (`ChatView`'s `paletteOpen`).
 * - `landingPromptHidden` — the landing draws no prompt (`HomeView`'s `paletteOpen`).
 * - `pageNotice` — `PgUp`/`PgDn` do not page the landing's notice.
 * - `occupiesRows` — the flag's own body takes the screen's rows: the landing and the chat are not drawn (or are shrunk) under it.
 * - `revokesCustody` — the approval's custody (the measured-frame evidence of the Home, a gate card and a review) is not held.
 */
type Gate =
  | 'screenSlot'
  | 'scrollKeys'
  | 'pointer'
  | 'mouseCapture'
  | 'interrupt'
  | 'stripPause'
  | 'activePoll'
  | 'promptHidden'
  | 'landingPromptHidden'
  | 'pageNotice'
  | 'occupiesRows'
  | 'revokesCustody';

/** What the six submodes share. `effortPicker`'s `interrupt` is conditional: see {@link interruptContextFrom}. */
const SUBMODE: readonly Gate[] = [
  'screenSlot',
  'scrollKeys',
  'pointer',
  'interrupt',
  'stripPause',
  'promptHidden',
];

/** What the two submodes that can open on the bare landing add. */
const ON_THE_LANDING: readonly Gate[] = ['landingPromptHidden', 'pageNotice'];

/**
 * The table: for each flag, the gates it closes (besides owning the keyboard, which every flag does). A flag with no row, or a row with no
 * flag, does not compile. The cards close the pointer and nothing else here because their own host answers every key and `pasteFlagsFrom`
 * carries the paste half; the cells that look odd are the history this module preserves and the report of the extraction lists.
 */
const GATES: Readonly<Record<keyof OverlayFlags, readonly Gate[]>> = {
  palette: [...SUBMODE, ...ON_THE_LANDING],
  search: SUBMODE,
  mention: SUBMODE,
  modelPicker: [...SUBMODE, ...ON_THE_LANDING],
  effortPicker: SUBMODE,
  chatSheet: SUBMODE,
  // A screen replaces the slot rather than being refused by it (`openHelp` checks it on its own), and it is never open in a chat.
  screen: ['stripPause', 'pageNotice'],
  // The slot checks the card on its own today; the table says the same thing once.
  exitGuard: ['screenSlot', 'stripPause', 'activePoll', 'pageNotice'],
  nativePrompt: ['scrollKeys', 'pointer', 'mouseCapture', 'occupiesRows', 'revokesCustody'],
  // The slot's callers check the busy flag themselves (three of five), so it is not a slot gate here.
  nativeActionBusy: ['scrollKeys', 'pointer', 'mouseCapture', 'stripPause', 'activePoll'],
  approval: [],
  review: ['pointer'],
  question: ['pointer'],
  checkpoint: ['pointer'],
};

function isOverlayKind(key: string): key is keyof OverlayFlags {
  return Object.hasOwn(GATES, key);
}

/** Every flag, read from the table so the list cannot drift from it. */
const KINDS: readonly (keyof OverlayFlags)[] = Object.keys(GATES).filter(isOverlayKind);

function closes(flags: OverlayFlags, gate: Gate): boolean {
  return KINDS.some((kind) => flags[kind] && GATES[kind].includes(gate));
}

/** Whether anything owns the keyboard: every flag does, and one added later is covered with no edit here. No site asks for the whole set today. */
export function overlayOwnsKeyboard(flags: OverlayFlags): boolean {
  return KINDS.some((kind) => flags[kind]);
}

/** Whether the Home's screen slot refuses a screen: a submode is open, or the exit-guard card is. */
export function screenSlotBlocked(flags: OverlayFlags): boolean {
  return closes(flags, 'screenSlot');
}

/** The overlay half of the shared paste gate ({@link PasteEditableFlags}); the caller adds the work flags (`running`, `shellBusy`, `submitBusy`). */
export type OverlayPasteFlags = Pick<
  PasteEditableFlags,
  | 'paletteOpen'
  | 'searchOpen'
  | 'mentionOpen'
  | 'modelPickerOpen'
  | 'effortPickerOpen'
  | 'chatSheetOpen'
  | 'approvalPending'
>;

/**
 * The overlay half of the paste gate. A paste is never typed into the composer while a submode is open or an approval is pending
 * (`approval` or its `review`). The rest are decided BEFORE this gate by their host: a screen, the exit guard, a native prompt and a busy
 * native action drop the paste or hand it to their own card, and an open `ask_user` question takes it into its own field.
 */
export function pasteFlagsFrom(flags: OverlayFlags): OverlayPasteFlags {
  return {
    paletteOpen: flags.palette,
    searchOpen: flags.search,
    mentionOpen: flags.mention,
    modelPickerOpen: flags.modelPicker,
    effortPickerOpen: flags.effortPicker,
    chatSheetOpen: flags.chatSheet,
    approvalPending: flags.approval || flags.review,
  };
}

/** Whether the in-Home chat's transcript is NOT scrolled by a key: a submode, a native prompt or a busy native action is in front (the cards answer first). */
export function scrollKeysBlocked(flags: OverlayFlags): boolean {
  return closes(flags, 'scrollKeys');
}

/** Whether a wheel or click report is consumed without moving the transcript: the same as {@link scrollKeysBlocked}, and any open card. */
export function pointerBlocked(flags: OverlayFlags): boolean {
  return closes(flags, 'pointer');
}

/**
 * Whether the host may capture the mouse for a chat (and report a copy). Only a native prompt or a busy native action stops it: an open
 * submode does not, because toggling the terminal's mouse reporting for a transient state would be churn, and a report there is consumed
 * and ignored anyway ({@link pointerBlocked}).
 */
export function mouseCapturedFrom(flags: OverlayFlags): boolean {
  return !closes(flags, 'mouseCapture');
}

/**
 * The interrupt context an open overlay gives, or `undefined` when none does. `chatLive` is whether a chat is on screen: the `/effort`
 * overlay is chat-scoped, and one left open with no chat (never expected) is not an overlay the keymap closes.
 */
export function interruptContextFrom(
  flags: OverlayFlags,
  chatLive: boolean,
): Extract<InterruptContext, { readonly kind: 'overlay' }> | undefined {
  const seen = chatLive ? flags : { ...flags, effortPicker: false };
  return closes(seen, 'interrupt') ? { kind: 'overlay' } : undefined;
}

/** Whether the strip's idle refresh is paused by an overlay (the caller adds the mode and the terminal size, `strip-pause.ts`). */
export function stripPausedByOverlay(flags: OverlayFlags): boolean {
  return closes(flags, 'stripPause');
}

/** Whether the tab host's Active tab does not poll: the exit question is up, or a native action holds the keyboard (the caller adds the size). */
export function activePollPausedByOverlay(flags: OverlayFlags): boolean {
  return closes(flags, 'activePoll');
}

/** Whether the chat region draws no idle prompt: a submode owns the bottom of the view. */
export function promptHidden(flags: OverlayFlags): boolean {
  return closes(flags, 'promptHidden');
}

/** Whether the landing draws no prompt: the palette or the model picker, the two submodes that open on it (the exit card hides it on its own). */
export function landingPromptHidden(flags: OverlayFlags): boolean {
  return closes(flags, 'landingPromptHidden');
}

/** Whether `PgUp`/`PgDn` do not page the landing's notice: a screen, the exit card, the palette or the model picker is in front. */
export function noticePagingBlocked(flags: OverlayFlags): boolean {
  return closes(flags, 'pageNotice');
}

/** Whether a flag's own body takes the rows of the screen, so the landing and the chat are not drawn (or are shrunk) under it. */
export function occupiesRows(flags: OverlayFlags): boolean {
  return closes(flags, 'occupiesRows');
}

/** Whether the host holds the keyboard custody an approval's measured frame needs: not while a native prompt covers the screen. */
export function holdsCustody(flags: OverlayFlags): boolean {
  return !closes(flags, 'revokesCustody');
}

/** The four cards, which a store snapshot sets. */
export type CardFlags = Pick<OverlayFlags, 'approval' | 'review' | 'question' | 'checkpoint'>;

/** The cards a chat store's snapshot holds (`undefined` with no chat): each is the presence of its field. */
export function cardFlagsFrom(
  snapshot:
    | {
        readonly approval: unknown;
        readonly review: unknown;
        readonly question: unknown;
        readonly checkpoint: unknown;
      }
    | undefined,
): CardFlags {
  return {
    approval: snapshot?.approval !== undefined,
    review: snapshot?.review !== undefined,
    question: snapshot?.question !== undefined,
    checkpoint: snapshot?.checkpoint !== undefined,
  };
}
