/**
 * The session picker's scope and the row's directory hint (MVP-11 unit 6, round 1: test gaps T04, T05, T08, T09). "This directory" asks the store
 * for the working directory and "All directories" asks for none; the hint of a row (its directory, drawn in "All directories" only) is cut at the
 * front at {@link PICKER_PLACE_COLUMNS} columns and not before; and a choice that arrives after the flow was stopped or while the host is closing
 * is not returned.
 */
import type { SessionPage, SessionPageOptions, SessionPageRow } from '@relavium/db';
import { describe, expect, it, vi } from 'vitest';

import type { NativePickerResult } from '../render/tui/native-picker.js';
import type { NativePromptFlow } from '../render/tui/native-prompt-channel.js';
import { displayWidth } from '../render/tui/viewport.js';
import { createSessionPickerSource, runSessionPicker } from './session-picker.js';

const NOW = Date.parse('2026-11-26T01:00:00.000Z');
const PROJECT = '/w/project';
/** The columns the picker gives a row's directory line (the picker is drawn at 80 columns, the line is indented two). */
const HINT_COLUMNS = 78;

const row = (workingDir: string): SessionPageRow => ({
  id: 's1',
  title: 'Fix the flaky test',
  agentSlug: 'coder',
  workingDir,
  updatedAt: '2026-11-26T00:00:00.000Z',
  // The remaining columns of a stored session are not read by the picker.
});

type ListPage = (options?: SessionPageOptions) => SessionPage;
/** A store whose page reads are recorded. */
const lister = (page: ListPage) => vi.fn<ListPage>(page);

function sourceOf(listSessionPage: ListPage) {
  return createSessionPickerSource({
    store: { listSessionPage },
    cwd: PROJECT,
    now: () => NOW,
    assertAdmitting: () => {},
    runRead: (operation) => operation(),
  });
}

const optionsOf = (result: Awaited<ReturnType<ReturnType<typeof sourceOf>>>) => {
  if ('unavailable' in result) throw new Error('the page was not read');
  return result.options;
};

describe('the picker scope (T05)', () => {
  it('"This directory" asks the store for the working directory, and "All directories" asks for none', async () => {
    const listSessionPage = lister(() => ({ sessions: [row(PROJECT)] }));
    const load = sourceOf(listSessionPage);
    const signal = new AbortController().signal;
    await load('', false, signal);
    expect(listSessionPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ workingDir: PROJECT }),
    );
    await load('', true, signal);
    expect(listSessionPage.mock.calls.at(-1)?.[0]).not.toHaveProperty('workingDir');
  });

  it('the scope is kept for the pages that follow (the next page of "All directories" is not narrowed to the project)', async () => {
    const listSessionPage = lister((options) =>
      options?.cursor === undefined
        ? {
            sessions: [row('/elsewhere/a')],
            next: { updatedAt: '2026-11-26T00:00:00.000Z', id: 's1' },
          }
        : { sessions: [row('/elsewhere/b')] },
    );
    const first = await sourceOf(listSessionPage)('', true, new AbortController().signal);
    if ('unavailable' in first || first.next === undefined) throw new Error('no next page');
    await first.next();
    expect(listSessionPage).toHaveBeenCalledTimes(2);
    for (const [options] of listSessionPage.mock.calls)
      expect(options).not.toHaveProperty('workingDir');
  });
});

describe('the row’s directory hint (T08)', () => {
  const hintOf = async (
    directory: string,
    allDirectories: boolean,
  ): Promise<string | undefined> => {
    const result = await sourceOf(() => ({ sessions: [row(directory)] }))(
      '',
      allDirectories,
      new AbortController().signal,
    );
    return optionsOf(result)[0]?.hint;
  };

  it('a directory of exactly 78 columns is the hint whole, and 79 is cut at the front with the end kept', async () => {
    const whole = `/w/${'d'.repeat(HINT_COLUMNS - 3)}`;
    expect(displayWidth(whole)).toBe(HINT_COLUMNS);
    expect(await hintOf(whole, true)).toBe(whole);
    const tooLong = `/w/${'d'.repeat(HINT_COLUMNS - 2)}end`;
    const cut = await hintOf(tooLong, true);
    expect(displayWidth(cut ?? '')).toBe(HINT_COLUMNS);
    expect(cut?.startsWith('…')).toBe(true);
    expect(cut?.endsWith('ddend')).toBe(true);
  });

  it('a 70-column directory in "All directories" is the hint whole (a narrower bound than the picker’s would cut it)', async () => {
    const directory = `/w/${'d'.repeat(67)}`;
    expect(displayWidth(directory)).toBe(70);
    expect(await hintOf(directory, true)).toBe(directory);
  });

  it('in "This directory" a row has no hint at all', async () => {
    expect(await hintOf(PROJECT, false)).toBeUndefined();
  });
});

describe('a choice returned from the picker stage (T04, T09)', () => {
  const stage = (
    answer: () => Promise<string>,
    signal: AbortSignal,
  ): Pick<NativePromptFlow, 'begin' | 'end' | 'pick'> => ({
    begin: () => signal,
    end: () => Promise.resolve(),
    pick: answer,
  });
  const deps = (assertAdmitting: () => void) => ({
    store: { listSessionPage: (): SessionPage => ({ sessions: [] }) },
    cwd: PROJECT,
    now: () => NOW,
    assertAdmitting,
    runRead: (operation: () => Promise<NativePickerResult>) => operation(),
  });

  it('an answer that arrives after the flow was stopped is not a choice', async () => {
    const controller = new AbortController();
    const choice = await runSessionPicker({
      ...deps(() => {}),
      flow: stage(() => {
        controller.abort();
        return Promise.resolve('s1');
      }, controller.signal),
    });
    expect(choice).toBeUndefined();
  });

  it('the Home is asked once more before a choice is returned: a closing Home returns none', async () => {
    let closing = false;
    const asked = vi.fn(() => {
      if (closing) throw new Error('the Home is closing');
    });
    await expect(
      runSessionPicker({
        ...deps(asked),
        flow: stage(() => {
          closing = true;
          return Promise.resolve('s1');
        }, new AbortController().signal),
      }),
    ).rejects.toThrow('the Home is closing');
  });

  it('an unstopped answer is the session id', async () => {
    const choice = await runSessionPicker({
      ...deps(() => {}),
      flow: stage(() => Promise.resolve('s1'), new AbortController().signal),
    });
    expect(choice).toBe('s1');
  });
});
