import { cleanup, render } from 'ink-testing-library';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { waitFor } from './harness-util.js';
import { createNativePicker, type NativePickerSnapshot } from './native-picker.js';
import {
  createNativePromptChannel,
  type NativePromptEscape,
  type NativePromptSnapshot,
} from './native-prompt-channel.js';
import { NativePromptHost } from './native-prompt-host.js';
import { pickerLegend } from './native-prompt-view.js';

afterEach(cleanup);

/**
 * The legend under the resume picker ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §2 and §3): `Tab` says
 * what it does, by the state it is pressed in (it flips between this directory and all of them), and the keys that leave are the card's own
 * (`nativeLeave`), read from the same `escape` the channel reads, so a picker opened to step back says `Esc back` and names `Ctrl+C` as the key
 * that closes it.
 */

const picker = (over: Partial<NativePickerSnapshot> = {}): NativePickerSnapshot => ({
  display: '',
  cursor: 0,
  allDirectories: false,
  page: 1,
  loading: false,
  hasNext: false,
  hasPrevious: false,
  retryable: false,
  options: [{ value: 'a', label: 'A' }],
  selected: 0,
  error: '',
  ...over,
});

const promptOf = (
  state: NativePickerSnapshot,
  escape: NativePromptEscape = 'cancel',
): NativePromptSnapshot => ({
  active: true,
  kind: 'picker',
  picker: state,
  message: 'Resume',
  note: '',
  options: state.options,
  selected: state.selected,
  display: state.display,
  error: state.error,
  escape,
  details: [],
});

describe('the resume picker’s legend', () => {
  it('says where Tab goes: all directories from this one, this directory from all of them', () => {
    expect(pickerLegend(promptOf(picker()))).toBe(
      '↑/↓ select · Enter resume · Tab all directories · PgUp/PgDn page · Esc close',
    );
    expect(pickerLegend(promptOf(picker({ allDirectories: true })))).toBe(
      '↑/↓ select · Enter resume · Tab this directory · PgUp/PgDn page · Esc close',
    );
  });

  it('names the effect Tab really has: the words match the scope the real picker moves to', async () => {
    const abort = new AbortController();
    let state: NativePickerSnapshot | undefined;
    const controller = createNativePicker({
      message: 'Resume',
      load: () => Promise.resolve({ options: [{ value: 'a', label: 'A' }] }),
      signal: abort.signal,
      onChoose: vi.fn(),
      onFailure: vi.fn(),
      onChange: (next) => {
        state = next;
      },
    });
    controller.start();
    await controller.whenSettled();
    const legendNow = (): string => (state === undefined ? '' : pickerLegend(promptOf(state)));
    expect(state?.allDirectories).toBe(false);
    expect(legendNow()).toContain('Tab all directories');
    controller.input('', { tab: true });
    await controller.whenSettled();
    expect(state?.allDirectories, 'Tab went to all directories, as the legend said').toBe(true);
    expect(legendNow()).toContain('Tab this directory');
    controller.input('', { tab: true });
    await controller.whenSettled();
    expect(state?.allDirectories, 'and back to this one').toBe(false);
    controller.dispose();
    abort.abort();
  });

  it('routes its leaving keys through the card’s own: Esc steps back and Ctrl+C closes when the picker was opened to step back', () => {
    expect(pickerLegend(promptOf(picker(), 'back'))).toBe(
      '↑/↓ select · Enter resume · Tab all directories · PgUp/PgDn page · Esc back · [Ctrl+C] close',
    );
    // `cancel`: `Esc` is the key that ends the flow, and it is the only leaving key the legend names.
    expect(pickerLegend(promptOf(picker(), 'cancel'))).toMatch(/ · Esc close$/u);
  });

  it('after a failed read, offers the retry or the filter, with the same leaving keys', () => {
    const failed = picker({
      error: 'The sessions could not be read.',
      retryable: true,
      options: [],
    });
    expect(pickerLegend(promptOf(failed))).toBe('Enter retry · Esc close');
    expect(pickerLegend(promptOf({ ...failed, retryable: false }))).toBe('Edit filter · Esc close');
    expect(pickerLegend(promptOf(failed, 'back'))).toBe('Enter retry · Esc back · [Ctrl+C] close');
  });

  it('OB-7: a page with no row, or one still loading, names no `Enter resume` (the picker ignores it then)', () => {
    expect(pickerLegend(promptOf(picker({ options: [] })))).toBe(
      '↑/↓ select · Tab all directories · PgUp/PgDn page · Esc close',
    );
    expect(pickerLegend(promptOf(picker({ options: [], loading: true })))).not.toContain(
      'Enter resume',
    );
  });

  it('OB-7: the card draws the framed picker’s words for an empty directory, and no `Enter resume`', async () => {
    const { ui, flow } = createNativePromptChannel();
    flow.begin();
    const answer = flow.pick({ message: 'Resume', load: () => Promise.resolve({ options: [] }) });
    const h = render(createElement(NativePromptHost, { ui, color: false }));
    Object.defineProperty(h.stdout, 'rows', { value: 24 });
    h.stdout.emit('resize');
    await waitFor(() => (h.lastFrame() ?? '').includes('No sessions in this directory'));
    const frame = h.lastFrame() ?? '';
    expect(frame).toContain('No sessions in this directory · Tab shows all');
    expect(frame).not.toContain('No matching sessions');
    expect(frame).not.toContain('Enter resume');
    flow.cancel();
    await answer;
    await flow.end();
    ui.dispose();
  });
});
