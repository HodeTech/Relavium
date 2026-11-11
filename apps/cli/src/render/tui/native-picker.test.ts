import { describe, expect, it, vi } from 'vitest';
import {
  createNativePicker,
  NATIVE_PICKER_PAGE_SIZE,
  NATIVE_PICKER_QUERY_LIMIT,
  type NativePickerResult,
  type NativePickerSnapshot,
  type NativePickerPage,
} from './native-picker.js';
import { createNativePromptChannel, NATIVE_PROMPT_CANCEL } from './native-prompt-channel.js';

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('deferred not initialized');
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const page = (id: string): NativePickerPage => ({ options: [{ value: id, label: id }] });
function fixture(
  load: (query: string, wide: boolean, signal: AbortSignal) => Promise<NativePickerResult>,
) {
  const abort = new AbortController(),
    onChoose = vi.fn(),
    onFailure = vi.fn();
  let state: NativePickerSnapshot | undefined;
  const controller = createNativePicker({
    message: 'Resume',
    load,
    signal: abort.signal,
    onChoose,
    onFailure,
    onChange: (next) => {
      state = next;
    },
  });
  const snapshot = (): NativePickerSnapshot => {
    if (state === undefined) throw new Error('picker not started');
    return state;
  };
  return { controller, snapshot, onChoose, onFailure, abort };
}

describe('owned searchable session picker', () => {
  it('filters, edits and widens only on input, and chooses only on explicit Enter', async () => {
    const load = vi.fn<(query: string, wide: boolean) => Promise<NativePickerResult>>(() =>
      Promise.resolve({
        options: [
          { value: 'first', label: 'First' },
          { value: 'second', label: 'Second' },
        ],
      }),
    );
    const h = fixture(load);
    expect(load).not.toHaveBeenCalled();
    h.controller.start();
    await h.controller.whenSettled();
    h.controller.input('50%', {});
    await h.controller.whenSettled();
    h.controller.input('', { tab: true });
    await h.controller.whenSettled();
    expect(load.mock.calls.map(([query, wide]) => [query, wide])).toEqual([
      ['', false],
      ['50%', false],
      ['50%', true],
    ]);
    h.controller.input('', { leftArrow: true });
    expect(load).toHaveBeenCalledTimes(3);
    h.controller.input('', { backspace: true });
    await h.controller.whenSettled();
    expect(h.snapshot().display).toBe('5%');
    h.controller.input('', { downArrow: true });
    expect(h.onChoose).not.toHaveBeenCalled();
    h.controller.input('', { return: true });
    expect(h.onChoose).toHaveBeenCalledWith('second');
    h.controller.dispose();
  });

  it('coalesces obsolete queued queries before they perform a read', async () => {
    const load = vi.fn(() => Promise.resolve(page('latest'))),
      h = fixture(load);
    h.controller.start();
    h.controller.input('a', {});
    h.controller.input('b', {});
    await h.controller.whenSettled();
    expect(load).toHaveBeenCalledTimes(1);
    expect(h.snapshot().display).toBe('ab');
    h.controller.dispose();
  });

  it('uses forward/backward page closures without accumulating a page cache', async () => {
    const first: NativePickerPage = {
      options: [{ value: 'first', label: 'First' }],
      next: () => Promise.resolve(second),
    };
    const second: NativePickerPage = {
      options: [{ value: 'second', label: 'Second' }],
      previous: () => Promise.resolve(first),
    };
    const load = vi.fn(() => Promise.resolve(first)),
      h = fixture(load);
    h.controller.start();
    await h.controller.whenSettled();
    h.controller.input('', { pageDown: true });
    await h.controller.whenSettled();
    expect(h.snapshot().page).toBe(2);
    expect(h.snapshot().options[0]?.value).toBe('second');
    h.controller.input('', { pageUp: true });
    await h.controller.whenSettled();
    expect(h.snapshot().page).toBe(1);
    expect(h.snapshot().options[0]?.value).toBe('first');
    expect(load).toHaveBeenCalledTimes(1);
    h.controller.dispose();
  });

  it('rejects a stale asynchronous query result and retires it only after settlement', async () => {
    const old = deferred<NativePickerResult>(),
      fresh = deferred<NativePickerResult>();
    const load = vi.fn((query: string) => (query === '' ? old.promise : fresh.promise)),
      h = fixture(load);
    h.controller.start();
    await Promise.resolve();
    h.controller.input('new', {});
    await Promise.resolve();
    expect(h.snapshot().loading).toBe(true);
    expect(h.snapshot().options).toEqual([]);
    h.controller.input('', { return: true });
    expect(h.onChoose).not.toHaveBeenCalled();
    fresh.resolve(page('fresh'));
    await vi.waitFor(() => expect(h.snapshot().options[0]?.value).toBe('fresh'));
    old.resolve(page('stale'));
    await h.controller.whenSettled();
    expect(h.snapshot().options[0]?.value).toBe('fresh');
    h.controller.dispose();
  });

  it('holds flow completion and native custody until a cancelled actual read settles', async () => {
    const read = deferred<NativePickerResult>(),
      load = vi.fn(() => read.promise);
    const { flow, ui } = createNativePromptChannel();
    const signal = flow.begin();
    const answer = flow.pick({ message: 'Resume', load });
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    flow.cancel();
    expect(await answer).toBe(NATIVE_PROMPT_CANCEL);
    expect(signal.aborted).toBe(true);
    let ended = false;
    const end = flow.end().then(() => {
      ended = true;
    });
    await Promise.resolve();
    expect(ended).toBe(false);
    expect(ui.getSnapshot().active).toBe(true);
    read.resolve(page('late'));
    await end;
    expect(ui.getSnapshot().active).toBe(false);
    expect(JSON.stringify(ui.getSnapshot())).not.toContain('late');
    ui.dispose();
  });

  it.each(['x'.repeat(NATIVE_PICKER_QUERY_LIMIT + 1), 'query\nnot-a-selection'])(
    'requires an explicit edit after rejected paste',
    async (text) => {
      const h = fixture(() => Promise.resolve(page('first')));
      h.controller.start();
      await h.controller.whenSettled();
      h.controller.paste(text);
      expect(h.snapshot().error).not.toBe('');
      expect(h.snapshot().display).toBe('');
      h.controller.input('', { return: true });
      expect(h.onChoose).not.toHaveBeenCalled();
      h.controller.input('', { backspace: true });
      await h.controller.whenSettled();
      expect(h.snapshot().error).toBe('');
      expect(h.snapshot().options[0]?.value).toBe('first');
      h.controller.dispose();
    },
  );

  it('shows fixed read failure and retries without reflecting its private cause', async () => {
    let calls = 0;
    const h = fixture(() =>
      ++calls === 1
        ? Promise.reject(new Error('PRIVATE database path'))
        : Promise.resolve(page('recovered')),
    );
    h.controller.start();
    await h.controller.whenSettled();
    expect(h.snapshot().error).toContain('Enter retries');
    expect(JSON.stringify(h.snapshot())).not.toContain('PRIVATE');
    h.controller.input('', { return: true });
    await h.controller.whenSettled();
    expect(h.snapshot().options[0]?.value).toBe('recovered');
    expect(h.onFailure).not.toHaveBeenCalled();
    h.controller.dispose();
  });

  it.each([NATIVE_PICKER_PAGE_SIZE, NATIVE_PICKER_PAGE_SIZE + 1])(
    'admits exactly the bounded page size or refuses it whole (%s)',
    async (length) => {
      const h = fixture(() =>
        Promise.resolve({
          options: Array.from({ length }, (_, i) => ({ value: `id-${i}`, label: `Row ${i}` })),
        }),
      );
      h.controller.start();
      await h.controller.whenSettled();
      expect(h.snapshot().options).toHaveLength(length === NATIVE_PICKER_PAGE_SIZE ? length : 0);
      expect(h.snapshot().error !== '').toBe(length > NATIVE_PICKER_PAGE_SIZE);
      h.controller.dispose();
    },
  );

  it('routes an unexpected publication failure to the owner instead of an unhandled asynchronous rejection', async () => {
    const failure = new Error('publication failure'),
      onFailure = vi.fn();
    const controller = createNativePicker({
      message: 'Resume',
      signal: new AbortController().signal,
      load: () => Promise.resolve(page('one')),
      onChoose: () => {},
      onFailure,
      onChange: (state) => {
        if (state.options.length > 0) throw failure;
      },
    });
    controller.start();
    await controller.whenSettled();
    expect(onFailure).toHaveBeenCalledWith(failure);
    controller.dispose();
  });
});
