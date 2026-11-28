/**
 * The session picker's source reads a page with the cursor's own direction, and reads the store only while the flow may (MVP-11 unit 6, round 2:
 * N08 to N10). The rows, the scope and the scrub are `session-picker-rows.test.ts`'s and `session-picker-scope.test.ts`'s.
 */
import type { SessionPage, SessionPageOptions, SessionPageRow } from '@relavium/db';
import { describe, expect, it, vi } from 'vitest';

import { createSessionPickerSource } from './session-picker.js';

const NOW = Date.parse('2026-11-26T01:00:00.000Z');
const row = (id: string): SessionPageRow => ({
  id,
  title: `Session ${id}`,
  agentSlug: 'coder',
  workingDir: '/w/project',
  updatedAt: '2026-11-26T00:00:00.000Z',
});
type ListPage = (options?: SessionPageOptions) => SessionPage;
const sourceOf = (listSessionPage: ListPage, assertAdmitting: () => void = () => {}) =>
  createSessionPickerSource({
    store: { listSessionPage },
    cwd: '/w/project',
    now: () => NOW,
    assertAdmitting,
    runRead: (operation) => operation(),
  });

describe('the session picker source pages in the cursor’s own direction', () => {
  it('the next page is read forward from the page’s own cursor and the previous page backward from its', async () => {
    const next = { updatedAt: '2026-11-25T00:00:00.000Z', id: 'n' };
    const previous = { updatedAt: '2026-11-27T00:00:00.000Z', id: 'p' };
    const list = vi.fn<ListPage>(() => ({ sessions: [row('a')], next, previous }));
    const page = await sourceOf(list)('', false, new AbortController().signal);
    if ('unavailable' in page || page.next === undefined || page.previous === undefined)
      throw new Error('no pages');
    await page.next();
    expect(list.mock.calls.at(-1)?.[0]).toMatchObject({ cursor: next, direction: 'forward' });
    await page.previous();
    expect(list.mock.calls.at(-1)?.[0]).toMatchObject({ cursor: previous, direction: 'backward' });
  });
});

describe('the session picker source reads the store only while the flow may', () => {
  it('a read for a flow that was already stopped never reaches the store, and says the page is unavailable', async () => {
    const list = vi.fn<ListPage>(() => ({ sessions: [row('a')] }));
    const stopped = new AbortController();
    stopped.abort(new Error('stopped'));
    const result = await sourceOf(list)('', false, stopped.signal);
    expect(result).toEqual({ unavailable: true });
    expect(list).not.toHaveBeenCalled();
  });

  it('a flow stopped WHILE the store was read gets no rows from it: the page is unavailable', async () => {
    const controller = new AbortController();
    const list = vi.fn<ListPage>(() => {
      controller.abort(new Error('stopped'));
      return { sessions: [row('a')] };
    });
    const result = await sourceOf(list)('', false, controller.signal);
    expect(result).toEqual({ unavailable: true });
    expect(list).toHaveBeenCalledTimes(1);
  });
});
