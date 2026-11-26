import type { Key } from 'ink';
import type { Schedule } from '../../popups/notifications.js';
import { sanitizeInline } from '../sanitize.js';
import {
  chordOf,
  createChordGuard,
  createChordHistory,
  createLockDisplay,
  reduceChordKey,
  type ChordAnswer,
  type ChordHistory,
  type ChordStamp,
} from './chord-guard.js';
import { exitKey, legend, type LegendExit, type LegendItem } from './legend.js';
import {
  cancelsPrompt,
  createChordCardGuard,
  createGuardedSelect,
  createOpeningAdmission,
  firstBoundary,
  nativeOpeningKey,
  navigates,
} from './native-prompt-guards.js';
import { APPROVAL_LOCKOUT_MS, type ApprovalGuard } from './tool-review-model.js';
import {
  createNativePicker,
  type NativePickerController,
  type NativePickerOptions,
  type NativePickerSnapshot,
} from './native-picker.js';

export const NATIVE_PROMPT_CANCEL = Symbol('native prompt cancelled');
/**
 * What a prompt opened with `escape: 'back'` settles with when `Esc` steps back one step
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §5). It is not an answer: the caller
 * goes to the previous step (or leaves, when there is none), and any secret typed so far has already been cleared.
 */
export const NATIVE_PROMPT_BACK = Symbol('native prompt stepped back');
/**
 * What `Esc` does at a prompt. `cancel` (the default, and what every existing caller gets) ends the whole flow. `back` settles
 * the prompt with {@link NATIVE_PROMPT_BACK} and leaves the flow open; `Ctrl+C` still leaves the flow entirely in both modes.
 */
export type NativePromptEscape = 'cancel' | 'back';

/**
 * What the keys that leave a native card say they do ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §2),
 * read from the same `escape` the handler reads. At a prompt that ends the flow on `Esc`, `Esc` is the key that leaves; at one opened to step
 * back, `Esc` steps back and `Ctrl+C` is the key that leaves, which closes the form (`leave` is the word for "the work stays", and here it
 * does not). `effect` is what leaving means where it is more than closing: a chord card refuses (`denies`), a busy card stops what it waits
 * for (`cancels it`).
 */
export function nativeLeave(
  back: boolean,
  effect?: string,
): { readonly before: readonly LegendItem[]; readonly exit: LegendExit } {
  const leaving = (keys: string): LegendExit =>
    effect === undefined ? exitKey.close(keys) : exitKey.decide(effect, keys);
  return back
    ? { before: [{ keys: 'Esc', verb: 'back' }], exit: leaving('Ctrl+C') }
    : { before: [], exit: leaving('Esc') };
}

export const NATIVE_PROMPT_INPUT_LIMIT = 4096;
/**
 * What a masked field says after a terminal resize cleared what was typed into it ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §4): a fixed product text in the prompt's error row, so the person pastes again. Nothing of the old buffer survives the resize.
 */
export const NATIVE_PROMPT_RESIZED = 'Resized · key cleared, paste it again';
/** The numbers behind a guarded option's `Enter` (`native-prompt-guards.ts`, where the rule is explained). */
export { GUARDED_SELECT_GUARD } from './native-prompt-guards.js';
export class NativePromptVisibilityRefusedError extends Error {
  constructor() {
    super('The native prompt is not visibly available.');
    this.name = 'NativePromptVisibilityRefusedError';
  }
}
export interface NativePromptOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
  /**
   * The AFFIRMATIVE of a consent answered by `Enter` (the first-run environment key's `Use it`; ADR-0148 §3): `Enter` on it counts only when
   * the approval card's input layers pass ({@link GUARDED_SELECT_GUARD}) on the frame the person was shown; a refused `Enter` is dropped with
   * no word (and restarts the lockout when it came inside it). Every other option of the select answers on `Enter` as before.
   */
  readonly guarded?: true;
}
/**
 * A flow that is a POPUP rather than a card ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §2): the channel is one of the popup frame's two body drivers, and this optional descriptor is all it gains (it is NOT grown into the popup
 * host). It carries what the frame draws around the channel's prompt: the command's name and origin on the top edge, `step 2 of 3` and the
 * rail with its step names, and what `Esc` says. A flow that sets none keeps the card it always was. Flows set it through `framedFlow`
 * (`home/framed-flow.ts`), never by hand.
 *
 * It carries no placement: where a popup is drawn is the RENDERER's (the alternate screen overlays it, the inline renderer draws it as a block in
 * place of the body, ADR-0148 §4), and a flow, which runs the same in both, cannot know which. The field it had was stored and never read.
 */
export interface NativePopupDescriptor {
  readonly title: string;
  readonly origin: 'home' | 'chat';
  readonly stepIndex: number;
  readonly stepCount: number;
  /** The rail's step names, in order (ADR-0148 §1: `✓ Provider ╌╌ ◉ Key ╌╌ ○ Done`); absent ⇒ the nodes are drawn without names. */
  readonly stepNames?: readonly string[];
  /** What the way back says on the legend where `Esc` (or `Ctrl+C`) closes the popup (`close`, `skip for now`). */
  readonly exitLabel: string;
  /**
   * What `Enter` says on the legend of a text or a masked field of this step where it does more than continue (`check` on the key step: that
   * `Enter` sends the key to the provider); default `continue`. A PRODUCT constant a flow writes, never data: it is drawn on the legend row as
   * given (sanitised, not scrubbed), so a word a person, a project or a provider wrote must never reach it. Only the type keeps it so: there is
   * no runtime path that checks the origin of a string.
   */
  readonly enterVerb?: string;
  /**
   * What `Esc` says on the legend of this step's prompts where it steps back (`escape: 'back'`) and stepping back is more than going to the step
   * before (`skip for now` on the first step of the automatic first run, whose step back IS the skip: ADR-0146 §6); default `back`. A PRODUCT
   * constant, as {@link enterVerb} is: drawn as given (sanitised, not scrubbed), never a word a person, a project or a provider wrote.
   */
  readonly escapeVerb?: string;
  /**
   * The steps before this one the flow passed WITHOUT doing them (the `Key` step of a setup that granted an environment key or remembered a
   * keychain that is down): the rail draws each as a step not done (`○`), never `✓`; `step N of M` is unchanged. Indices into the rail, each in
   * `[0, stepCount)`; absent ⇒ every step before this one was done.
   */
  readonly skipped?: readonly number[];
  /** The popup stack's depth this flow is at (one: the channel holds one flow; the reducer driver owns stacking, ADR-0148 §5). */
  readonly depth: 1 | 2;
}
/** The tone of a flow's persistent last step: what it did (`ok`), or that what it set out to write failed (`failed`). */
export type NativeFinalTone = 'ok' | 'failed';
/**
 * A wait that STEPS BACK on `Esc` (the key step's check, O6): the snapshot's `escape` is `back`, so its legend says `Esc back` and `Ctrl+C`
 * still leaves the flow. A lone `Esc` calls `onBack` once (the flow aborts the work it waits for with its OWN controller and asks its previous
 * prompt again; the flow's signal is not touched) and is then dropped while the wait lasts. That `Esc` starts a hold over the prompt the step
 * back opens: for {@link STEP_BACK_HOLD_MS} a lone `Esc` that would step back from it is refused and restarts the hold, so an `Esc` held down at
 * any repeat rate steps back ONE step, never on to the step before that (where the first run's step back is the skip, which writes). The hold
 * goes when that prompt is resolved; `Ctrl+C` is never held.
 */
export interface NativeBusyOptions {
  readonly onBack?: () => void;
}
/** How long after a step back out of a wait a further step back is refused (the approval lockout: a held key's repeats never get past it). */
export const STEP_BACK_HOLD_MS = APPROVAL_LOCKOUT_MS;
export interface NativePromptSnapshot {
  readonly active: boolean;
  readonly kind: 'idle' | 'select' | 'text' | 'password' | 'busy' | 'picker' | 'chord';
  readonly picker?: Pick<
    NativePickerSnapshot,
    'allDirectories' | 'page' | 'cursor' | 'loading' | 'hasNext' | 'hasPrevious' | 'retryable'
  >;
  readonly message: string;
  readonly note: string;
  readonly options: readonly NativePromptOption[];
  readonly selected: number;
  readonly display: string;
  readonly error: string;
  /** What `Esc` does at the open prompt; `cancel` whenever none is open. */
  readonly escape: NativePromptEscape;
  /**
   * The body of a chord card or of a select, one row per entry (each sanitized; a card draws them behind the host's gutter, a popup wraps
   * them in its body): a chord card's facts, a Done step's lines. Empty for every other prompt.
   */
  readonly details: readonly string[];
  /** The flow is a popup ({@link NativePopupDescriptor}); absent ⇒ a card. */
  readonly popup?: NativePopupDescriptor;
  /**
   * The open select is the persistent LAST step of a flow (`framedFlow(…).done`, ADR-0148 §6), in the tone of its result: its one option closes
   * it, `Enter` and `Esc` both resolve it, and its legend says `Enter / Esc close`; a `failed` one draws its sentence as a failure. Absent on
   * every other prompt.
   */
  readonly final?: NativeFinalTone;
}
export interface NativePromptUi {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => NativePromptSnapshot;
  /** Cancellation custody only; this never exposes the private editor. */
  readonly signal: () => AbortSignal | undefined;
  readonly assertVisible: (snapshot: NativePromptSnapshot) => void;
  /** Installed by the live terminal host; never accepts secret material. */
  readonly bindVisibility: (
    check: ((snapshot: NativePromptSnapshot) => boolean) | undefined,
  ) => void;
  /**
   * Installed by the live terminal host's acknowledgement: how many rows `PgUp`/`PgDn` move the cursor of a `select` card whose options
   * do not all fit the terminal (the window the card draws), or `undefined` when the card is drawn whole. Only a number: the host's size
   * and the card's rows stay with the host.
   */
  readonly bindPageRows: (rows: (() => number | undefined) | undefined) => void;
  /**
   * Installed by the live terminal host's acknowledgement: this exact snapshot has just been measured and flushed as a NEW frame
   * (its first, or the first after a resize or a lost screen). A chord card's dwell counts from here, never from its publication.
   */
  readonly shown: (snapshot: NativePromptSnapshot) => void;
  readonly input: (input: string, key: Key) => boolean;
  readonly paste: (text: string) => boolean;
  /**
   * A key or a paste reached the host while the open prompt could not take it: its frame is not painted and measured yet, or the
   * terminal is too small to hold it. The key answers nothing and is not delivered (a secret is never typed into a card nobody can
   * see), but it IS typing, and a chord card's quiet-gap and typeahead layers must see it: otherwise a person typing into the Home's
   * composer as a card appears is invisible to the guard that exists for exactly that. A no-op when no flow is open: a key typed
   * before any card opened belongs to the composer, is an edit and not typeahead, and the dwell from the painted frame covers it.
   *
   * On a select whose highlighted option is GUARDED, a dropped key that may be an `Enter` (it is one, or the host did not say which key it was),
   * and on a chord card a dropped key that may be its `Ctrl+Y`, is a refused affirmative too: inside the lockout it restarts it, as a refused
   * answer does. A key held at a slow repeat rate, one repeat of which lands while the frame is not on screen, must not let the lockout run out
   * under it (a held `Ctrl+Y` that answered one chord card could otherwise answer the next).
   */
  readonly unseenInput: (input?: string, key?: Key) => void;
  /**
   * The terminal changed size (the acknowledgement tells it, the moment it learns of a size it has not seen; ADR-0148 §4). A masked field
   * that held anything is emptied, its rejection latch dropped, and its error row says {@link NATIVE_PROMPT_RESIZED}: nothing typed into it
   * survives a resize, framed or not. Every other prompt is left as it is.
   */
  readonly resized: () => void;
  /**
   * Whether the open prompt's affirmative is LOCKED by its guard's 2 s lockout now: a chord card's `Ctrl+Y`, a guarded option's `Enter`
   * (the maintainer's ruling of 2026-11-26 on ADR-0145 §3: its legend part is drawn dim with `(wait)`). Asked of the guard that decides
   * (`lockedUntil`), on its clock, never a second copy of the rule. A DISPLAY value read by the views, not a snapshot field: as the popup host's
   * loading clock (ADR-0147 §2), a change to it is no new frame, so it restarts no dwell, no opening settle and no acknowledgement, and an
   * answer at the unlock instant is judged exactly as it would have been without it. It changes when the prompt opens, settles or goes, and
   * once more at the unlock instant (one timer, moved by a refused press that restarted the lockout); never periodically.
   */
  readonly lock: {
    readonly subscribe: (listener: () => void) => () => void;
    readonly read: () => boolean;
  };
  readonly dispose: () => void;
}
export interface NativePromptFlow {
  readonly begin: () => AbortSignal;
  readonly end: () => Promise<void>;
  readonly cancel: () => void;
  /**
   * Draw the open flow as a popup ({@link NativePopupDescriptor}), or as a card again (`undefined`). Every text is sanitized; the descriptor is
   * part of the snapshot's identity, so a change to it is a new frame the person must be shown before anything on it counts.
   */
  readonly popup?: (descriptor: NativePopupDescriptor | undefined) => void;
  readonly note: (message: string, title?: string) => void;
  /** Preserve a completed publication fact even if cancellation arrived after it. */
  readonly committedNote?: (message: string, title?: string) => void;
  /**
   * A wait, with no prompt open. `Esc` there cancels the flow, as `Ctrl+C` does, unless the wait can step back ({@link NativeBusyOptions}).
   */
  readonly busy: (message: string, options?: NativeBusyOptions) => void;
  readonly pick: (options: NativePickerOptions) => Promise<string | symbol>;
  readonly select: (options: {
    message: string;
    options: readonly NativePromptOption[];
    initialValue?: string;
    escape?: NativePromptEscape;
    /** Rows of body above the options (a Done step's lines); each sanitized. Absent ⇒ none. */
    details?: readonly string[];
    /** The select is a flow's persistent last step ({@link NativePromptSnapshot.final}), in the tone of its result. */
    final?: NativeFinalTone;
  }) => Promise<string | symbol>;
  readonly confirm: (
    message: string,
    initialValue?: boolean,
    escape?: NativePromptEscape,
  ) => Promise<boolean | symbol>;
  readonly text: (options: {
    message: string;
    validate?: (value: string) => string | undefined;
    escape?: NativePromptEscape;
  }) => Promise<string | symbol>;
  readonly password: (options: {
    message: string;
    validate?: (value: string) => string | undefined;
    escape?: NativePromptEscape;
  }) => Promise<string | symbol>;
}
/**
 * The chord card, on its own port so a flow that only asks the ordinary prompts does not have to carry it. The channel's `flow`
 * has both.
 */
export interface NativeChordPort {
  /**
   * A card answered by a Ctrl chord alone: `Ctrl+Y` is `allow`, `Ctrl+N` is `deny`, and nothing else answers. A bare letter, a
   * pasted block, `Esc` and `Ctrl+C` decide nothing: the last two settle it with {@link NATIVE_PROMPT_BACK} or
   * {@link NATIVE_PROMPT_CANCEL}, which the caller maps (a consent card refuses on both). `allow` passes the approval guards
   * ({@link createChordGuard}), their lockout running from the moment the card opened as well as from the answer before it
   * (`createChordCardGuard`: a deliberate `Ctrl+Y` needs about two seconds after the card appeared), and needs the card's frame to be on
   * screen; `deny` is never delayed.
   */
  readonly chord: (options: {
    message: string;
    /** The body, one row per entry. The caller bounds it; a card that does not fit the terminal is never answered. */
    details?: readonly string[];
    allow: string;
    deny: string;
    escape?: NativePromptEscape;
    /** When it aborts the card closes and the call settles with {@link NATIVE_PROMPT_CANCEL}: a card must not outlive the work it asks about. */
    signal?: AbortSignal;
  }) => Promise<ChordAnswer | symbol>;
}
/** One shared empty body, so a snapshot that has none keeps the same reference (the acknowledgement compares it). */
const NO_DETAILS: readonly string[] = Object.freeze([]);
const initial: NativePromptSnapshot = {
  active: false,
  kind: 'idle',
  message: '',
  note: '',
  options: [],
  selected: 0,
  display: '',
  error: '',
  escape: 'cancel',
  details: NO_DETAILS,
};

/** The numbers and the clock behind a chord card; tests inject both, production passes neither. */
export interface NativePromptChannelOptions {
  /** A MONOTONIC millisecond clock (default `performance.now`): the chord guards' and a framed flow's opening guard's one clock. */
  readonly now?: () => number;
  /**
   * A chord card's approval guard numbers (default the product's own); `0` switches a layer off. Never a guarded option's: its numbers are
   * always `GUARDED_SELECT_GUARD`, so no caller can take its dwell away.
   */
  readonly guard?: ApprovalGuard;
  /** The Home's shared chord history (`createChordHistory`): what the other cards stamped locks this one too. Default: its own. */
  readonly history?: ChordHistory;
  /**
   * The opening guard's settle time of a framed flow (`popups/opening-guard.ts`, default 500 ms); `0` switches that rule off for a test that
   * isolates another one. Production passes none.
   */
  readonly settleMs?: number;
  /**
   * The one-shot timer that ends a lock ({@link NativePromptUi.lock}) at its unlock instant, read on the injected clock (production: an
   * unref'd timeout, so a card left open never keeps the process alive). A test with a manual clock passes its own.
   */
  readonly schedule?: Schedule;
}

/** The production timer of a lock: unref'd, cancellable. */
const unrefTimeout: Schedule = (callback, ms) => {
  const handle = setTimeout(callback, ms);
  handle.unref();
  return () => {
    clearTimeout(handle);
  };
};

/** The snapshot drawn as a card again: every field but the popup descriptor. */
function withoutPopup(snapshot: NativePromptSnapshot): NativePromptSnapshot {
  const { popup, ...card } = snapshot;
  void popup;
  return card;
}

/** The snapshot as the next prompt starts from it: every field but the last step's mark, which belongs to the select that set it. */
function withoutFinal(snapshot: NativePromptSnapshot): NativePromptSnapshot {
  const { final, ...rest } = snapshot;
  void final;
  return rest;
}

/**
 * A LONE `Esc`: the key that steps back at a prompt opened with `escape: 'back'`. `Ctrl+C` (which a host forwards as `'\x1b'` with its real
 * key), a meta chord and an `Esc` coalesced with other bytes are not: they leave the flow.
 */
function loneEscape(input: string, key: Key): boolean {
  return (
    key.escape === true &&
    key.ctrl !== true &&
    key.meta !== true &&
    (input === '' || input === '\x1b')
  );
}

/** Whether the snapshot is a select one of whose options is guarded ({@link NativePromptOption.guarded}). */
function guardedSelect(snapshot: NativePromptSnapshot): boolean {
  return snapshot.kind === 'select' && snapshot.options.some((option) => option.guarded === true);
}

/** The steps a descriptor says were skipped, as the snapshot keeps them: whole steps of the rail, in order, each once; none ⇒ absent. */
function skippedSteps(
  skipped: readonly number[] | undefined,
  stepCount: number,
): { readonly skipped?: readonly number[] } {
  const steps = [...new Set(skipped ?? [])]
    .filter((step) => Number.isInteger(step) && step >= 0 && step < stepCount)
    .sort((a, b) => a - b);
  return steps.length === 0 ? {} : { skipped: steps };
}

/** The step's descriptor as the snapshot keeps it: every text sanitized, the numbers whole, the names copied. */
function sanitizedDescriptor(descriptor: NativePopupDescriptor): NativePopupDescriptor {
  const stepCount = Math.max(1, Math.trunc(descriptor.stepCount));
  return {
    title: sanitizeInline(descriptor.title),
    origin: descriptor.origin,
    stepIndex: Math.max(0, Math.trunc(descriptor.stepIndex)),
    stepCount,
    ...(descriptor.stepNames === undefined
      ? {}
      : { stepNames: descriptor.stepNames.map((name) => sanitizeInline(name)) }),
    exitLabel: sanitizeInline(descriptor.exitLabel),
    ...(descriptor.enterVerb === undefined
      ? {}
      : { enterVerb: sanitizeInline(descriptor.enterVerb) }),
    ...(descriptor.escapeVerb === undefined
      ? {}
      : { escapeVerb: sanitizeInline(descriptor.escapeVerb) }),
    ...skippedSteps(descriptor.skipped, stepCount),
    depth: descriptor.depth,
  };
}

/** Only the flow port can receive an answer; the UI port never exposes the private editor. */
export function createNativePromptChannel(options?: NativePromptChannelOptions): {
  readonly ui: NativePromptUi;
  readonly flow: NativePromptFlow & NativeChordPort;
} {
  const now = options?.now ?? (() => performance.now());
  // ONE history for every guard of the channel (and the Home's other cards, when it shares it): a key that answered one locks the next.
  const history = options?.history ?? createChordHistory();
  const chord = createChordGuard({ now, guard: options?.guard, history });
  /**
   * The `Ctrl+Y` of a chord card (`native-prompt-guards.ts`): every chord a card is asked about is decided here, its lockout running from the
   * card's opening, on the same history (a card that is a flow's first prompt, or that appears after a wait a held key repeated through).
   */
  const chordCard = createChordCardGuard({ now, chord });
  /** The `Enter` of a guarded option (`native-prompt-guards.ts`): its lockout runs from the select's opening, on the same history. */
  const guarded = createGuardedSelect({ now, history });
  /**
   * The opening guard of the flow (ADR-0148 §3), while it is drawn as a popup: reset by `begin`, started by the flow's FIRST framed frame
   * that was measured and flushed, and asked about every key before it is routed. Per flow, not per step.
   */
  const opening = createOpeningAdmission({ now, settleMs: options?.settleMs });
  let snapshot = initial;
  let secret = '';
  let invalid = false;
  let abort: AbortController | undefined;
  let settle: ((answer: string | symbol) => void) | undefined;
  let validate: ((value: string) => string | undefined) | undefined;
  let disposed = false;
  /**
   * A note published while a chord card is open. The card draws its own rows behind the host gutter and a note above them would sit at
   * column 0, in the band the renderer reserves for itself, so the card shows none: the note is held until the card settles and then
   * shows on the frame that follows it (a later prompt keeps it; a later chord card clears it, as it clears any note).
   */
  let heldNote: string | undefined;
  /** The step back of the open wait ({@link NativeBusyOptions.onBack}) until it is taken or the wait goes. */
  let busyBack: (() => void) | undefined;
  /** Until when a lone `Esc` that would step back is refused: the hold that a step back out of a wait starts ({@link STEP_BACK_HOLD_MS}). */
  let backHeldUntil = Number.NEGATIVE_INFINITY;
  let picker: NativePickerController | undefined;
  const pickerDrains = new Set<Promise<void>>();
  let visibility: ((snapshot: NativePromptSnapshot) => boolean) | undefined;
  let pageRows: (() => number | undefined) | undefined;
  const listeners = new Set<() => void>();
  /**
   * The lock of the open prompt's affirmative ({@link NativePromptUi.lock}): asked of the guard that decides it (a chord card's `Ctrl+Y`, a
   * guarded select's `Enter`), `-Infinity` for any other prompt. Read again on every publication (a prompt opened, settled or went) and after
   * every key (a refused press inside the lockout moved its end).
   */
  const lock = createLockDisplay({
    now,
    schedule: options?.schedule ?? unrefTimeout,
    until: () => {
      if (!snapshot.active) return Number.NEGATIVE_INFINITY;
      if (snapshot.kind === 'chord') return chordCard.lockedUntil();
      return guardedSelect(snapshot) ? guarded.lockedUntil() : Number.NEGATIVE_INFINITY;
    },
  });
  const publish = (next: NativePromptSnapshot): void => {
    snapshot = next;
    // The lock first, so a view that renders on this publication reads the lock of the prompt it draws.
    lock.sync();
    for (const listener of listeners) listener();
  };
  const clear = (): void => {
    if (picker !== undefined) {
      picker.dispose();
      const drain = picker.whenSettled();
      pickerDrains.add(drain);
      void drain.then(
        () => pickerDrains.delete(drain),
        () => pickerDrains.delete(drain),
      );
      picker = undefined;
    }
    secret = '';
    validate = undefined;
    invalid = false;
  };
  const finish = (answer: string | symbol): void => {
    const callback = settle;
    settle = undefined;
    clear();
    // The hold of a step back out of a wait guards the prompt that step back opened, and goes when that prompt is resolved.
    backHeldUntil = Number.NEGATIVE_INFINITY;
    const held = heldNote;
    heldNote = undefined;
    publish({
      ...withoutFinal(snapshot),
      ...(held === undefined ? {} : { note: held }),
      kind: 'busy',
      message: '',
      options: [],
      display: '',
      error: '',
      escape: 'cancel',
      details: NO_DETAILS,
    });
    callback?.(answer);
  };
  const cancel = (): void => {
    if (!snapshot.active) return;
    abort?.abort();
    if (settle) finish(NATIVE_PROMPT_CANCEL);
    else {
      clear();
      publish({
        ...withoutFinal(snapshot),
        kind: 'busy',
        display: '',
        error: '',
        escape: 'cancel',
        details: NO_DETAILS,
      });
    }
  };
  /**
   * `Esc` or `Ctrl+C` reached the prompt. A prompt opened with `escape: 'back'` steps back on a LONE `Esc` (finishing clears any
   * secret typed so far); everything else that cancels (`Ctrl+C`, a raw ETX, a meta chord, an `Esc` coalesced with other bytes)
   * leaves the flow, as it always did. The hosts forward a refused `Ctrl+C` as `'\x1b'` with its real key, so the key is what
   * tells the two apart, never the text.
   */
  const dismiss = (input: string, key: Key, at: number): void => {
    // A step back can be an answer that writes (the first run's skip, ADR-0146 §6), and an answer of a popup needs a key that arrived after
    // it appeared (the opening guard's rule 3). The opening guard admits every key that leaves (a popup never traps the person), so an `Esc`
    // already on its way when the popup appeared leaves the flow here instead, as a cancel, writing nothing.
    const early = snapshot.popup !== undefined && !opening.appeared(at);
    if (snapshot.escape !== 'back' || !loneEscape(input, key) || early) {
      cancel();
      return;
    }
    if (at < backHeldUntil) {
      // The `Esc` that stepped back out of a wait, still held down: it steps back no further, and its repeat restarts the hold.
      backHeldUntil = at + STEP_BACK_HOLD_MS;
      return;
    }
    if (settle !== undefined) finish(NATIVE_PROMPT_BACK);
    else stepBackOutOfWait(at);
  };
  /** A lone `Esc` on a wait that steps back ({@link NativeBusyOptions}): its step back, once; a later one while it lasts is dropped. */
  const stepBackOutOfWait = (at: number): void => {
    const back = busyBack;
    busyBack = undefined;
    if (back === undefined) return;
    backHeldUntil = at + STEP_BACK_HOLD_MS;
    back();
  };
  const prompt = (
    kind: 'select' | 'text' | 'password' | 'chord',
    message: string,
    options: readonly NativePromptOption[] = [],
    initialValue?: string,
    check?: (value: string) => string | undefined,
    extras?: {
      readonly escape?: NativePromptEscape;
      readonly details?: readonly string[];
      readonly final?: NativeFinalTone;
    },
  ): Promise<string | symbol> => {
    if (!snapshot.active || abort?.signal.aborted || disposed)
      return Promise.resolve(NATIVE_PROMPT_CANCEL);
    if (settle) throw new Error('A native prompt is already active.');
    clear();
    heldNote = undefined;
    chord.begin();
    chordCard.open(kind === 'chord');
    guarded.open(kind === 'select' && options.some((option) => option.guarded === true));
    validate = check;
    const selected = Math.max(
      0,
      options.findIndex((option) => option.value === initialValue),
    );
    publish({
      ...withoutFinal(snapshot),
      // A chord card is a decision about what the text on it says, and nothing the flow stored earlier may sit above it: a note (the
      // skipped workflow files a launch lists, say) carries text the card's author did not write and the person cannot tell from the card.
      ...(kind === 'chord' ? { note: '' } : {}),
      kind,
      message: sanitizeInline(message),
      options: options.map((option) => ({
        value: option.value,
        label: sanitizeInline(option.label),
        ...(option.hint === undefined ? {} : { hint: sanitizeInline(option.hint) }),
        ...(option.guarded === true ? { guarded: true as const } : {}),
      })),
      selected,
      display: '',
      error: '',
      escape: extras?.escape ?? 'cancel',
      details: extras?.details === undefined ? NO_DETAILS : extras.details.map(sanitizeInline),
      ...(extras?.final === undefined ? {} : { final: extras.final }),
    });
    return new Promise((resolve) => {
      settle = resolve;
    });
  };
  /** What a text or password prompt shows of what is typed: bullets (at most 32) for a secret, the sanitized text otherwise. */
  const shownText = (): string =>
    snapshot.kind === 'password' ? '•'.repeat(Math.min(secret.length, 32)) : sanitizeInline(secret);
  const append = (text: string): void => {
    if (snapshot.kind === 'picker') {
      picker?.paste(text);
      return;
    }
    if (snapshot.kind !== 'text' && snapshot.kind !== 'password') return;
    // Rejected bytes must not be silently omitted from a later submission.
    // Keep the rejection visible until the user explicitly edits or cancels.
    if (invalid) return;
    // What `Esc` does here is what the person is told it does.
    const refused = (reason: string): string => {
      const { before, exit } = nativeLeave(snapshot.escape === 'back');
      return legend([{ text: reason }, { keys: 'Backspace', verb: 'edit' }, ...before], exit);
    };
    if (secret.length + text.length > NATIVE_PROMPT_INPUT_LIMIT) {
      invalid = true;
      publish({ ...snapshot, error: refused('Input is too long') });
      return;
    }
    if (
      Array.from(text).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })
    ) {
      invalid = true;
      publish({ ...snapshot, error: refused('Input contains unsupported control characters') });
      return;
    }
    secret += text;
    publish({ ...snapshot, display: shownText(), error: '' });
  };
  /**
   * The bytes before a boundary are an edit; an escape or an ETX AT the boundary leaves the prompt. `true` when it left, which is the
   * whole key's answer. A return or a newline at the boundary leaves the rest to the submit rules of the caller.
   */
  const takeBoundary = (input: string, key: Key, boundary: number, at: number): boolean => {
    const before = input.slice(0, boundary);
    if (before) append(before);
    const marker = input[boundary];
    if (marker !== '\x1b' && marker !== '\x03') return false;
    dismiss(input, key, at);
    return true;
  };
  /** A lone Ctrl+Y or Ctrl+N answers a chord card; anything else is a key the card has no use for, which is typing as far as the guard goes. */
  const routeChord = (input: string, key: Key, stamp: ChordStamp, boundary: number): void => {
    const answer = boundary >= 0 ? undefined : reduceChordKey(input, key);
    if (answer === undefined) {
      // A chord soon after such a key is refused.
      chord.foreign(stamp);
      return;
    }
    const decided = chordCard.decide(stamp, answer, visibility?.(snapshot) === true);
    if (decided !== undefined) finish(decided);
  };
  /**
   * On a card the arrows wrap. In a popup they stop at the ends (ADR-0148 §3): a list drawn in a window with `▲/▼ N more` reads as one that
   * ends, and an arrow past its end does nothing.
   */
  const moveCursor = (up: boolean): void => {
    const count = snapshot.options.length;
    if (!count) return;
    if (snapshot.popup === undefined) {
      publish({ ...snapshot, selected: (snapshot.selected + (up ? count - 1 : 1)) % count });
      return;
    }
    const to = Math.max(0, Math.min(count - 1, snapshot.selected + (up ? -1 : 1)));
    if (to !== snapshot.selected) publish({ ...snapshot, selected: to });
  };
  /**
   * A page moves the cursor by the rows of the window the card draws and stops at the ends (the arrows wrap, a page never does). A card
   * drawn whole has no window, so the keys do nothing there, as they never did.
   */
  const pageCursor = (up: boolean): void => {
    const step = pageRows?.();
    const last = snapshot.options.length - 1;
    if (step === undefined || last < 0) return;
    const to = Math.max(0, Math.min(last, snapshot.selected + (up ? -step : step)));
    if (to !== snapshot.selected) publish({ ...snapshot, selected: to });
  };
  /**
   * `Enter` answers the option under the cursor. A GUARDED option answers only when the approval card's layers pass on the frame that is on
   * screen now (a held key's repeat never does); a refused `Enter` is dropped with no word, and one that came inside the lockout restarts it.
   */
  const answerSelected = (key: Key, stamp: ChordStamp): void => {
    const option = snapshot.options[snapshot.selected];
    if (!option) return;
    if (option.guarded === true) {
      const painted = visibility?.(snapshot) === true && key.eventType !== 'repeat';
      if (!guarded.decide(stamp, painted)) return;
    }
    finish(option.value);
  };
  const routeSelect = (key: Key, submitted: boolean, stamp: ChordStamp): void => {
    if (key.upArrow || key.downArrow) moveCursor(key.upArrow);
    else if (key.pageUp || key.pageDown) pageCursor(key.pageUp);
    else if (submitted) answerSelected(key, stamp);
  };
  /** Whether the open prompt is a select whose highlighted option is guarded: what an `Enter` would try to answer there. */
  const onGuardedOption = (): boolean =>
    snapshot.kind === 'select' &&
    settle !== undefined &&
    snapshot.options[snapshot.selected]?.guarded === true;
  /** Whether a chord card is open: what a `Ctrl+Y` would try to answer. */
  const onChordCard = (): boolean => snapshot.kind === 'chord' && settle !== undefined;
  /**
   * In a popup, an arrow past the end of the picker's list does nothing (ADR-0148 §3); the picker itself wraps, as a card does, so the key
   * is not given to it.
   */
  const pickerStops = (key: Key): boolean =>
    snapshot.popup !== undefined &&
    ((key.upArrow && snapshot.selected <= 0) ||
      (key.downArrow && snapshot.selected >= snapshot.options.length - 1));
  /** A submit of a text or password prompt: the caller's validator decides, and a rejection stays visible until the person edits. */
  const submitEditor = (): void => {
    if (invalid) return;
    let error: string | undefined;
    try {
      error = validate?.(secret);
    } catch {
      error = 'Input could not be validated.';
    }
    if (error)
      publish({
        ...snapshot,
        error: snapshot.kind === 'password' ? 'A valid value is required.' : sanitizeInline(error),
      });
    else finish(secret);
  };
  const routeEditor = (input: string, key: Key, submitted: boolean): void => {
    if (submitted) {
      submitEditor();
      return;
    }
    if (key.backspace || key.delete) {
      secret = Array.from(secret).slice(0, -1).join('');
      invalid = false;
      publish({ ...snapshot, display: shownText(), error: '' });
      return;
    }
    if (!key.ctrl && !key.meta) append(input);
  };
  /** A key for the picker, a select, or a text or password editor: whichever prompt is open takes it. */
  const routeOpenPrompt = (
    input: string,
    key: Key,
    boundary: number,
    submitted: boolean,
    stamp: ChordStamp,
  ): void => {
    if (snapshot.kind === 'picker') {
      if (pickerStops(key)) return;
      picker?.input(boundary >= 0 ? '' : input, submitted ? { ...key, return: true } : key);
    } else if (snapshot.kind === 'select') routeSelect(key, submitted, stamp);
    else routeEditor(input, key, submitted);
  };
  /**
   * Whether a key on the open prompt is typing as the guards count it. Every key is, as it always was, but on a select that carries a guarded
   * option the keys the select acts on (the arrows, the pages, `Enter`) are the person using it, as on the approval card, and only the others
   * (a letter, a paste) are typing at it.
   */
  const typingAt = (key: Key, submitted: boolean): boolean =>
    !(guardedSelect(snapshot) && (navigates(key) || submitted));
  /** Route one key the prompt's host delivered; `stamp` is the guard's evidence from just before it. */
  const route = (input: string, key: Key, stamp: ChordStamp): boolean => {
    const boundary = firstBoundary(input);
    if (boundary >= 0 && takeBoundary(input, key, boundary, stamp.now)) return true;
    if (cancelsPrompt(input, key)) {
      dismiss(input, key, stamp.now);
      return true;
    }
    if (snapshot.kind === 'busy' || !settle) {
      // A key typed while the flow is open but no prompt is (a card is about to open) is typing: the next card's guard sees it.
      chord.foreign(stamp);
      return true;
    }
    const submitted = key.return || boundary >= 0;
    if (snapshot.kind === 'chord') {
      routeChord(input, key, stamp, boundary);
      return true;
    }
    if (typingAt(key, submitted)) chord.foreign(stamp);
    routeOpenPrompt(input, key, boundary, submitted, stamp);
    return true;
  };
  /**
   * The opening guard's admission of one key of a framed flow: `true` when it may be routed. A key it refuses answers nothing and is counted
   * as typing; one that would have answered a chord card's `Ctrl+Y` or a guarded option's `Enter` is a refused affirmative instead (the
   * lockout restarts when it came inside it), as the card's own guard treats one.
   */
  const admitOpening = (input: string, key: Key, stamp: ChordStamp): boolean => {
    if (snapshot.popup === undefined) return true;
    const kind = nativeOpeningKey(snapshot, settle !== undefined, input, key);
    if (opening.admits(kind, stamp.now)) return true;
    if (kind === 'answer' && snapshot.kind === 'chord') chordCard.decide(stamp, 'allow', false);
    else if (kind === 'answer' && onGuardedOption()) guarded.refuse(stamp);
    else chord.foreign(stamp);
    return false;
  };
  const ui: NativePromptUi = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    signal: () => abort?.signal,
    assertVisible: (expected) => {
      if (visibility?.(expected) !== true) throw new NativePromptVisibilityRefusedError();
    },
    bindVisibility: (check) => {
      visibility = check;
    },
    bindPageRows: (rows) => {
      pageRows = rows;
    },
    shown: (frame) => {
      if (frame !== snapshot || !snapshot.active) return;
      // The flow's first framed frame on screen: its opening guard starts here (only the first call counts).
      if (snapshot.popup !== undefined) opening.shown();
      if (settle === undefined) return;
      if (snapshot.kind === 'chord') chord.shown();
      // A guarded option's dwell counts from each NEW acknowledged frame of its select (a moved highlight is one).
      if (guardedSelect(snapshot)) guarded.shown();
    },
    input: (input, key) => {
      if (!snapshot.active) return false;
      // Every key is stamped, so the guard judges each one against what happened BEFORE it (the chat store's `lastKeyAt`). A
      // prompt this key settles starts the lockout that holds a repeating key off the card that follows it.
      const stamp = chord.stamp();
      const open = settle !== undefined;
      if (!admitOpening(input, key, stamp)) {
        // A refused press inside the lockout moved its end: the lock's one timer moves with it.
        lock.sync();
        return true;
      }
      const handled = route(input, key, stamp);
      if (open && settle === undefined) chord.resolved(stamp);
      lock.sync();
      return handled;
    },
    paste: (text) => {
      if (!snapshot.active) return false;
      const stamp = chord.stamp();
      chord.foreign(stamp);
      // A paste is typing: in a framed flow it waits, as a key does, for the flow's first frame to be on screen.
      if (snapshot.popup !== undefined && !opening.admits('type', stamp.now)) return true;
      append(text);
      return true;
    },
    unseenInput: (input, key) => {
      if (!snapshot.active) return;
      const stamp = chord.stamp();
      chord.foreign(stamp);
      // A dropped key that may be an `Enter` on a guarded option, or a `Ctrl+Y` on a chord card, is a refused affirmative too: inside the
      // lockout it restarts it (see the port's comment).
      const mayAnswer = key === undefined || key.return || firstBoundary(input ?? '') >= 0;
      if (onGuardedOption() && mayAnswer) guarded.refuse(stamp);
      if (onChordCard() && (key === undefined || chordOf(input ?? '', key) === 'allow'))
        chordCard.decide(stamp, 'allow', false);
      lock.sync();
    },
    resized: () => {
      if (snapshot.kind !== 'password' || settle === undefined) return;
      if (secret.length === 0 && !invalid) return;
      secret = '';
      invalid = false;
      publish({ ...snapshot, display: '', error: NATIVE_PROMPT_RESIZED });
    },
    dispose: () => {
      if (disposed) return;
      cancel();
      disposed = true;
      clear();
      heldNote = undefined;
      // Nothing is open any more: the publication below reads the lock open (its views are told once), then its timer and listeners go.
      publish(initial);
      listeners.clear();
      lock.dispose();
    },
    lock: { subscribe: lock.subscribe, read: lock.read },
  };
  const flow: NativePromptFlow & NativeChordPort = {
    begin: () => {
      if (disposed || snapshot.active) throw new Error('Native prompt is unavailable.');
      abort = new AbortController();
      // A new flow is a new popup: its opening guard starts again at its own first frame.
      opening.begin();
      publish({ ...initial, active: true, kind: 'busy' });
      return abort.signal;
    },
    end: async () => {
      cancel();
      await Promise.allSettled([...pickerDrains]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      clear();
      heldNote = undefined;
      abort = undefined;
      if (!disposed) publish(initial);
    },
    cancel,
    popup: (descriptor) => {
      if (!snapshot.active || disposed) return;
      if (descriptor === undefined) {
        if (snapshot.popup === undefined) return;
        publish(withoutPopup(snapshot));
        return;
      }
      publish({ ...snapshot, popup: sanitizedDescriptor(descriptor) });
    },
    note: (message, title) => {
      if (!snapshot.active || abort?.signal.aborted) return;
      const text = sanitizeInline(title ? `${title}: ${message}` : message);
      if (snapshot.kind === 'chord') heldNote = text;
      else publish({ ...snapshot, note: text });
    },
    committedNote: (message, title) => {
      if (!snapshot.active) return;
      const text = sanitizeInline(title ? `${title}: ${message}` : message);
      if (snapshot.kind === 'chord') heldNote = text;
      else publish({ ...snapshot, note: text });
    },
    busy: (message, busyOptions) => {
      if (!snapshot.active || abort?.signal.aborted === true) return;
      busyBack = busyOptions?.onBack;
      publish({
        ...withoutFinal(snapshot),
        kind: 'busy',
        message: sanitizeInline(message),
        options: [],
        display: '',
        error: '',
        escape: busyBack === undefined ? 'cancel' : 'back',
        details: NO_DETAILS,
      });
    },
    pick: (options) => {
      if (!snapshot.active || abort?.signal.aborted || disposed || abort === undefined)
        return Promise.resolve(NATIVE_PROMPT_CANCEL);
      if (settle) throw new Error('A native prompt is already active.');
      clear();
      const signal = abort.signal;
      return new Promise((resolve, reject) => {
        settle = resolve;
        picker = createNativePicker({
          ...options,
          signal,
          onChoose: finish,
          onFailure: (cause) => {
            settle = undefined;
            clear();
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Preserve the original publication fault for the owning lifetime.
            reject(cause);
          },
          onChange: (state) => {
            publish({
              ...withoutFinal(snapshot),
              kind: 'picker',
              message: sanitizeInline(options.message),
              note: '',
              options: state.options,
              selected: state.selected,
              display: state.display,
              error: state.error,
              picker: {
                allDirectories: state.allDirectories,
                page: state.page,
                cursor: state.cursor,
                loading: state.loading,
                hasNext: state.hasNext,
                hasPrevious: state.hasPrevious,
                retryable: state.retryable,
              },
            });
          },
        });
        picker.start();
      });
    },
    select: (options) =>
      prompt('select', options.message, options.options, options.initialValue, undefined, {
        escape: options.escape ?? 'cancel',
        ...(options.details === undefined ? {} : { details: options.details }),
        ...(options.final === undefined ? {} : { final: options.final }),
      }),
    confirm: async (message, initialValue = true, escape = 'cancel') => {
      const value = await prompt(
        'select',
        message,
        [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
        ],
        initialValue ? 'yes' : 'no',
        undefined,
        { escape },
      );
      return typeof value === 'symbol' ? value : value === 'yes';
    },
    text: (options) =>
      prompt('text', options.message, [], undefined, options.validate, {
        escape: options.escape ?? 'cancel',
      }),
    password: (options) =>
      prompt('password', options.message, [], undefined, options.validate, {
        escape: options.escape ?? 'cancel',
      }),
    chord: async (options) => {
      const before = settle;
      const pending = prompt(
        'chord',
        options.message,
        [
          { value: 'allow', label: options.allow },
          { value: 'deny', label: options.deny },
        ],
        undefined,
        undefined,
        { escape: options.escape ?? 'cancel', details: options.details ?? NO_DETAILS },
      );
      // The card this call opened, if it opened one: an abort closes THAT card and no other that may have replaced it.
      const mine = settle !== before ? settle : undefined;
      const signal = options.signal;
      const onAbort = (): void => {
        if (mine !== undefined && settle === mine) finish(NATIVE_PROMPT_CANCEL);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted === true) onAbort();
      try {
        const value = await pending;
        if (typeof value === 'symbol') return value;
        return value === 'allow' ? 'allow' : 'deny';
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
  return { ui, flow };
}
