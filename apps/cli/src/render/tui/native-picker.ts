import { sanitizeInline } from '../sanitize.js';
import {
  applyEditorAction,
  emptyEditor,
  insertAtCursor,
  reduceEditorMotion,
  type EditorState,
  type ChatKey,
} from './chat-input.js';
import type { NativePromptOption } from './native-prompt-channel.js';

export const NATIVE_PICKER_PAGE_SIZE = 6;
export const NATIVE_PICKER_QUERY_LIMIT = 256;
export interface NativePickerPage {
  readonly options: readonly NativePromptOption[];
  readonly next?: () => Promise<NativePickerResult>;
  readonly previous?: () => Promise<NativePickerResult>;
}
export type NativePickerResult = NativePickerPage | { readonly unavailable: true };
export interface NativePickerOptions {
  readonly message: string;
  readonly load: (
    query: string,
    allDirectories: boolean,
    signal: AbortSignal,
  ) => Promise<NativePickerResult>;
}
export interface NativePickerSnapshot {
  readonly display: string;
  readonly cursor: number;
  readonly allDirectories: boolean;
  readonly page: number;
  readonly loading: boolean;
  readonly hasNext: boolean;
  readonly hasPrevious: boolean;
  readonly retryable: boolean;
  readonly options: readonly NativePromptOption[];
  readonly selected: number;
  readonly error: string;
}
export interface NativePickerController {
  readonly start: () => void;
  readonly input: (input: string, key: ChatKey) => void;
  readonly paste: (text: string) => void;
  readonly dispose: () => void;
  /** Cancellation never retires an actual outstanding read. */
  readonly whenSettled: () => Promise<void>;
}

/** One current page, no growing page cache; late reads cannot replace a newer filter/scope. */
export function createNativePicker(
  options: NativePickerOptions & {
    readonly signal: AbortSignal;
    readonly onChange: (snapshot: NativePickerSnapshot) => void;
    readonly onChoose: (value: string) => void;
    readonly onFailure: (cause: unknown) => void;
  },
): NativePickerController {
  let editor: EditorState = emptyEditor();
  let allDirectories = false,
    page = 1,
    loading = false,
    selected = 0,
    error = '',
    invalid = false,
    sealed = false,
    generation = 0;
  let current: NativePickerPage | undefined;
  let lastRead: (() => Promise<NativePickerResult>) | undefined;
  const jobs = new Set<Promise<void>>();
  const active = (): boolean => !sealed && !options.signal.aborted;
  const publish = (): void => {
    if (!active()) return;
    options.onChange({
      display: sanitizeInline(editor.text),
      cursor: sanitizeInline(editor.text.slice(0, editor.cursor)).length,
      allDirectories,
      page,
      loading,
      hasNext: current?.next !== undefined,
      hasPrevious: current?.previous !== undefined,
      retryable: error !== '' && !invalid,
      options: current?.options ?? [],
      selected,
      error,
    });
  };
  const load = (read: () => Promise<NativePickerResult>): void => {
    if (!active() || invalid) return;
    const identity = ++generation;
    lastRead = read;
    current = undefined;
    loading = true;
    selected = 0;
    error = '';
    publish();
    const unavailable = (): void => {
      if (!active() || identity !== generation) return;
      current = undefined;
      loading = false;
      error = 'Session history could not be read. Enter retries; Esc returns.';
      publish();
    };
    const source = Promise.resolve().then(() =>
      active() && identity === generation ? read() : ({ unavailable: true } as const),
    );
    const observed = source.then((result) => {
      if (!active() || identity !== generation) return;
      if (
        'unavailable' in result ||
        result.options.length > NATIVE_PICKER_PAGE_SIZE ||
        new Set(result.options.map((option) => option.value)).size !== result.options.length
      ) {
        unavailable();
        return;
      }
      current = {
        ...result,
        options: result.options.map((option) => ({
          value: option.value,
          label: sanitizeInline(option.label),
          ...(option.hint === undefined ? {} : { hint: sanitizeInline(option.hint) }),
        })),
      };
      loading = false;
      publish();
    }, unavailable);
    // Publication/observer failures are unexpected and remain visible to the owning flow.
    const owned = observed.then(
      () => undefined,
      (cause: unknown) => {
        sealed = true;
        options.onFailure(cause);
      },
    );
    jobs.add(owned);
    void owned.then(
      () => jobs.delete(owned),
      () => jobs.delete(owned),
    );
  };
  const reload = (): void => {
    page = 1;
    const query = editor.text,
      wide = allDirectories;
    load(() => options.load(query, wide, options.signal));
  };
  const edit = (next: EditorState, clearRejected = false): void => {
    if (!active()) return;
    // eslint-disable-next-line no-control-regex -- Reject control-bearing search input as a whole before publication.
    if (next.text.length > NATIVE_PICKER_QUERY_LIMIT || /[\x00-\x1f\x7f]/u.test(next.text)) {
      invalid = true;
      error = 'Filter must be one line of at most 256 characters. Edit it or Esc returns.';
      generation++;
      current = undefined;
      loading = false;
      publish();
      return;
    }
    const changed = next.text !== editor.text;
    const acknowledged = invalid && clearRejected;
    editor = next;
    if (changed || acknowledged) {
      invalid = false;
      reload();
    } else publish();
  };
  return {
    start: reload,
    input: (input, key) => {
      if (!active()) return;
      if (key.tab && !invalid) {
        allDirectories = !allDirectories;
        reload();
        return;
      }
      if (key.return) {
        if (invalid || loading) return;
        if (error !== '') {
          if (lastRead !== undefined) load(lastRead);
          return;
        }
        const choice = current?.options[selected];
        if (choice !== undefined) options.onChoose(choice.value);
        return;
      }
      if (key.pageDown || key.pageUp) {
        if (loading || invalid) return;
        const read = key.pageUp ? current?.previous : current?.next;
        if (read !== undefined) {
          page = Math.max(1, page + (key.pageUp ? -1 : 1));
          load(read);
        }
        return;
      }
      if (key.upArrow || key.downArrow) {
        const count = current?.options.length ?? 0;
        if (!loading && count > 0) {
          selected = (selected + (key.upArrow ? count - 1 : 1)) % count;
          publish();
        }
        return;
      }
      const action = reduceEditorMotion(input, key);
      if (action !== undefined)
        edit(
          applyEditorAction(editor, action),
          action.kind === 'backspace' || action.kind === 'kill',
        );
    },
    paste: (text) => edit(insertAtCursor(editor, text)),
    dispose: () => {
      sealed = true;
      generation++;
      editor = emptyEditor();
      current = undefined;
      lastRead = undefined;
    },
    whenSettled: async () => {
      await Promise.allSettled([...jobs]);
    },
  };
}
