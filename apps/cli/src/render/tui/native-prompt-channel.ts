import type { Key } from 'ink';
import { sanitizeInline } from '../sanitize.js';

export const NATIVE_PROMPT_CANCEL = Symbol('native prompt cancelled');
export const NATIVE_PROMPT_INPUT_LIMIT = 4096;
export interface NativePromptOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}
export interface NativePromptSnapshot {
  readonly active: boolean;
  readonly kind: 'idle' | 'select' | 'text' | 'password' | 'busy';
  readonly message: string;
  readonly note: string;
  readonly options: readonly NativePromptOption[];
  readonly selected: number;
  readonly display: string;
  readonly error: string;
}
export interface NativePromptUi {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => NativePromptSnapshot;
  readonly input: (input: string, key: Key) => boolean;
  readonly paste: (text: string) => boolean;
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
  readonly select: (options: {
    message: string;
    options: readonly NativePromptOption[];
    initialValue?: string;
  }) => Promise<string | symbol>;
  readonly confirm: (message: string) => Promise<boolean | symbol>;
  readonly text: (options: {
    message: string;
    validate?: (value: string) => string | undefined;
  }) => Promise<string | symbol>;
  readonly password: (options: {
    message: string;
    validate?: (value: string) => string | undefined;
  }) => Promise<string | symbol>;
}
const initial: NativePromptSnapshot = {
  active: false,
  kind: 'idle',
  message: '',
  note: '',
  options: [],
  selected: 0,
  display: '',
  error: '',
};

/** Only the flow port can receive an answer; the UI port never exposes the private editor. */
export function createNativePromptChannel(): {
  readonly ui: NativePromptUi;
  readonly flow: NativePromptFlow;
} {
  let snapshot = initial;
  let secret = '';
  let invalid = false;
  let abort: AbortController | undefined;
  let settle: ((answer: string | symbol) => void) | undefined;
  let validate: ((value: string) => string | undefined) | undefined;
  let disposed = false;
  const listeners = new Set<() => void>();
  const publish = (next: NativePromptSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const clear = (): void => {
    secret = '';
    validate = undefined;
    invalid = false;
  };
  const finish = (answer: string | symbol): void => {
    const callback = settle;
    settle = undefined;
    clear();
    publish({ ...snapshot, kind: 'busy', message: '', options: [], display: '', error: '' });
    callback?.(answer);
  };
  const cancel = (): void => {
    if (!snapshot.active) return;
    abort?.abort();
    if (settle) finish(NATIVE_PROMPT_CANCEL);
    else {
      clear();
      publish({ ...snapshot, kind: 'busy', display: '', error: '' });
    }
  };
  const prompt = (
    kind: 'select' | 'text' | 'password',
    message: string,
    options: readonly NativePromptOption[] = [],
    initialValue?: string,
    check?: (value: string) => string | undefined,
  ): Promise<string | symbol> => {
    if (!snapshot.active || abort?.signal.aborted || disposed)
      return Promise.resolve(NATIVE_PROMPT_CANCEL);
    if (settle) throw new Error('A native prompt is already active.');
    clear();
    validate = check;
    const selected = Math.max(
      0,
      options.findIndex((option) => option.value === initialValue),
    );
    publish({
      ...snapshot,
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
    });
    return new Promise((resolve) => {
      settle = resolve;
    });
  };
  const append = (text: string): void => {
    if (snapshot.kind !== 'text' && snapshot.kind !== 'password') return;
    if (secret.length + text.length > NATIVE_PROMPT_INPUT_LIMIT) {
      invalid = true;
      publish({ ...snapshot, error: 'Input is too long. Remove text or cancel.' });
      return;
    }
    if (
      Array.from(text).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })
    ) {
      invalid = true;
      publish({ ...snapshot, error: 'Input contains unsupported control characters.' });
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
  const ui: NativePromptUi = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    input: (input, key) => {
      if (!snapshot.active) return false;
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
          cancel();
          return true;
        }
      }
      if (key.escape || key.meta || (key.ctrl && input.toLowerCase() === 'c')) {
        cancel();
        return true;
      }
      if (snapshot.kind === 'busy' || !settle) return true;
      const submitted = key.return || boundary >= 0;
      if (snapshot.kind === 'select') {
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
    },
    paste: (text) => {
      if (!snapshot.active) return false;
      append(text);
      return true;
    },
    dispose: () => {
      if (disposed) return;
      cancel();
      disposed = true;
      clear();
      publish(initial);
      listeners.clear();
    },
  };
  const flow: NativePromptFlow = {
    begin: () => {
      if (disposed || snapshot.active) throw new Error('Native prompt is unavailable.');
      abort = new AbortController();
      publish({ ...initial, active: true, kind: 'busy' });
      return abort.signal;
    },
    end: async () => {
      cancel();
      await new Promise<void>((resolve) => setImmediate(resolve));
      clear();
      abort = undefined;
      if (!disposed) publish(initial);
    },
    cancel,
    note: (message, title) => {
      if (snapshot.active && !abort?.signal.aborted)
        publish({ ...snapshot, note: sanitizeInline(title ? `${title}: ${message}` : message) });
    },
    committedNote: (message, title) => {
      if (snapshot.active)
        publish({
          ...snapshot,
          note: sanitizeInline(title ? `${title}: ${message}` : message),
        });
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
        });
    },
    select: (options) => prompt('select', options.message, options.options, options.initialValue),
    confirm: async (message) => {
      const value = await prompt('select', message, [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
      ]);
      return value === NATIVE_PROMPT_CANCEL ? value : value === 'yes';
    },
    text: (options) => prompt('text', options.message, [], undefined, options.validate),
    password: (options) => prompt('password', options.message, [], undefined, options.validate),
  };
  return { ui, flow };
}
