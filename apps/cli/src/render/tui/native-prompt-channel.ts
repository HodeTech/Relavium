import type { Key } from 'ink';
import { sanitizeInline } from '../sanitize.js';
import {
  createChordGuard,
  reduceChordKey,
  type ChordAnswer,
  type ChordHistory,
  type ChordStamp,
} from './chord-guard.js';
import type { ApprovalGuard } from './tool-review-model.js';
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
export const NATIVE_PROMPT_INPUT_LIMIT = 4096;
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
}
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
  /** A chord card's body, one row per entry (each sanitized and drawn behind the host's gutter); empty for every other prompt. */
  readonly details: readonly string[];
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
   */
  readonly unseenInput: () => void;
  readonly dispose: () => void;
}
export interface NativePromptFlow {
  readonly begin: () => AbortSignal;
  readonly end: () => Promise<void>;
  readonly cancel: () => void;
  readonly note: (message: string, title?: string) => void;
  /** Preserve a completed publication fact even if cancellation arrived after it. */
  readonly committedNote?: (message: string, title?: string) => void;
  readonly busy: (message: string) => void;
  readonly pick: (options: NativePickerOptions) => Promise<string | symbol>;
  readonly select: (options: {
    message: string;
    options: readonly NativePromptOption[];
    initialValue?: string;
    escape?: NativePromptEscape;
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
   * ({@link createChordGuard}) and needs the card's frame to be on screen; `deny` is never delayed.
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
  /** A MONOTONIC millisecond clock (default `performance.now`). */
  readonly now?: () => number;
  /** The approval guard's numbers (default the product's own); `0` switches a layer off. */
  readonly guard?: ApprovalGuard;
  /** The Home's shared chord history (`createChordHistory`): what the other cards stamped locks this one too. Default: its own. */
  readonly history?: ChordHistory;
}

/** Only the flow port can receive an answer; the UI port never exposes the private editor. */
export function createNativePromptChannel(options?: NativePromptChannelOptions): {
  readonly ui: NativePromptUi;
  readonly flow: NativePromptFlow & NativeChordPort;
} {
  const chord = createChordGuard({
    now: options?.now ?? (() => performance.now()),
    guard: options?.guard,
    history: options?.history,
  });
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
  let picker: NativePickerController | undefined;
  const pickerDrains = new Set<Promise<void>>();
  let visibility: ((snapshot: NativePromptSnapshot) => boolean) | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: NativePromptSnapshot): void => {
    snapshot = next;
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
    const held = heldNote;
    heldNote = undefined;
    publish({
      ...snapshot,
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
        ...snapshot,
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
  const dismiss = (input: string, key: Key): void => {
    const lone =
      key.escape === true &&
      key.ctrl !== true &&
      key.meta !== true &&
      (input === '' || input === '\x1b');
    if (snapshot.escape === 'back' && settle !== undefined && lone) finish(NATIVE_PROMPT_BACK);
    else cancel();
  };
  const prompt = (
    kind: 'select' | 'text' | 'password' | 'chord',
    message: string,
    options: readonly NativePromptOption[] = [],
    initialValue?: string,
    check?: (value: string) => string | undefined,
    extras?: { readonly escape?: NativePromptEscape; readonly details?: readonly string[] },
  ): Promise<string | symbol> => {
    if (!snapshot.active || abort?.signal.aborted || disposed)
      return Promise.resolve(NATIVE_PROMPT_CANCEL);
    if (settle) throw new Error('A native prompt is already active.');
    clear();
    heldNote = undefined;
    chord.begin();
    validate = check;
    const selected = Math.max(
      0,
      options.findIndex((option) => option.value === initialValue),
    );
    publish({
      ...snapshot,
      // A chord card is a decision about what the text on it says, and nothing the flow stored earlier may sit above it: a note (the
      // skipped workflow files a launch lists, say) carries text the card's author did not write and the person cannot tell from the card.
      ...(kind === 'chord' ? { note: '' } : {}),
      kind,
      message: sanitizeInline(message),
      options: options.map((option) => ({
        value: option.value,
        label: sanitizeInline(option.label),
        ...(option.hint === undefined ? {} : { hint: sanitizeInline(option.hint) }),
      })),
      selected,
      display: '',
      error: '',
      escape: extras?.escape ?? 'cancel',
      details: extras?.details === undefined ? NO_DETAILS : extras.details.map(sanitizeInline),
    });
    return new Promise((resolve) => {
      settle = resolve;
    });
  };
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
    const escapeWord = snapshot.escape === 'back' ? 'go back' : 'cancel';
    if (secret.length + text.length > NATIVE_PROMPT_INPUT_LIMIT) {
      invalid = true;
      publish({
        ...snapshot,
        error: `Input is too long. Press Backspace to edit or Esc to ${escapeWord}.`,
      });
      return;
    }
    if (
      Array.from(text).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })
    ) {
      invalid = true;
      publish({
        ...snapshot,
        error: `Input contains unsupported control characters. Press Backspace to edit or Esc to ${escapeWord}.`,
      });
      return;
    }
    secret += text;
    publish({
      ...snapshot,
      display:
        snapshot.kind === 'password'
          ? '•'.repeat(Math.min(secret.length, 32))
          : sanitizeInline(secret),
      error: '',
    });
  };
  /** Route one key the prompt's host delivered; `stamp` is the guard's evidence from just before it. */
  const route = (input: string, key: Key, stamp: ChordStamp): boolean => {
    let boundary = -1;
    for (const marker of ['\r', '\n', '\x1b', '\x03']) {
      const index = input.indexOf(marker);
      if (index >= 0 && (boundary < 0 || index < boundary)) boundary = index;
    }
    if (boundary >= 0) {
      const before = input.slice(0, boundary);
      const marker = input[boundary];
      if (before) append(before);
      if (marker === '\x1b' || marker === '\x03') {
        dismiss(input, key);
        return true;
      }
    }
    if (key.escape || key.meta || (key.ctrl && input.toLowerCase() === 'c')) {
      dismiss(input, key);
      return true;
    }
    if (snapshot.kind === 'busy' || !settle) {
      // A key typed while the flow is open but no prompt is (a card is about to open) is typing: the next card's guard sees it.
      chord.foreign(stamp);
      return true;
    }
    const submitted = key.return || boundary >= 0;
    if (snapshot.kind === 'chord') {
      // Only a lone Ctrl+Y or Ctrl+N answers. Anything else is a key the card has no use for, which is typing as far as the guard
      // is concerned: a chord soon after it is refused.
      const answer = boundary >= 0 ? undefined : reduceChordKey(input, key);
      if (answer === undefined) chord.foreign(stamp);
      else {
        const decided = chord.decide(stamp, answer, visibility?.(snapshot) === true);
        if (decided !== undefined) finish(decided);
      }
      return true;
    }
    chord.foreign(stamp);
    if (snapshot.kind === 'picker') {
      picker?.input(boundary >= 0 ? '' : input, submitted ? { ...key, return: true } : key);
    } else if (snapshot.kind === 'select') {
      if (key.upArrow || key.downArrow) {
        const count = snapshot.options.length;
        if (count)
          publish({
            ...snapshot,
            selected: (snapshot.selected + (key.upArrow ? count - 1 : 1)) % count,
          });
      } else if (submitted) {
        const option = snapshot.options[snapshot.selected];
        if (option) finish(option.value);
      }
    } else if (submitted) {
      if (invalid) return true;
      let error: string | undefined;
      try {
        error = validate?.(secret);
      } catch {
        error = 'Input could not be validated.';
      }
      if (error)
        publish({
          ...snapshot,
          error:
            snapshot.kind === 'password' ? 'A valid value is required.' : sanitizeInline(error),
        });
      else finish(secret);
    } else if (key.backspace || key.delete) {
      secret = Array.from(secret).slice(0, -1).join('');
      invalid = false;
      publish({
        ...snapshot,
        display:
          snapshot.kind === 'password'
            ? '•'.repeat(Math.min(secret.length, 32))
            : sanitizeInline(secret),
        error: '',
      });
    } else if (!key.ctrl && !key.meta) append(input);
    return true;
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
    shown: (frame) => {
      if (frame === snapshot && snapshot.kind === 'chord' && settle !== undefined) chord.shown();
    },
    input: (input, key) => {
      if (!snapshot.active) return false;
      // Every key is stamped, so the guard judges each one against what happened BEFORE it (the chat store's `lastKeyAt`). A
      // prompt this key settles starts the lockout that holds a repeating key off the card that follows it.
      const stamp = chord.stamp();
      const open = settle !== undefined;
      const handled = route(input, key, stamp);
      if (open && settle === undefined) chord.resolved(stamp);
      return handled;
    },
    paste: (text) => {
      if (!snapshot.active) return false;
      chord.foreign(chord.stamp());
      append(text);
      return true;
    },
    unseenInput: () => {
      if (!snapshot.active) return;
      chord.foreign(chord.stamp());
    },
    dispose: () => {
      if (disposed) return;
      cancel();
      disposed = true;
      clear();
      heldNote = undefined;
      publish(initial);
      listeners.clear();
    },
  };
  const flow: NativePromptFlow & NativeChordPort = {
    begin: () => {
      if (disposed || snapshot.active) throw new Error('Native prompt is unavailable.');
      abort = new AbortController();
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
    busy: (message) => {
      if (snapshot.active && !abort?.signal.aborted)
        publish({
          ...snapshot,
          kind: 'busy',
          message: sanitizeInline(message),
          options: [],
          display: '',
          error: '',
          escape: 'cancel',
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
              ...snapshot,
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
        return typeof value === 'symbol' ? value : value === 'allow' ? 'allow' : 'deny';
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
  return { ui, flow };
}
