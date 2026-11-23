/**
 * The Sessions tab's read ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §3, MVP-8 step 5): the newest saved conversations of this project, from the same store read the `/resume` picker pages. The store is a
 * scripted fake that answers the way `listSessionPage` does (newest first, scoped by working directory, bounded by the limit), so the tests
 * need no database; what is proved is the call the port makes, the rows it makes of the answer, and that the picker and the port see one list.
 */
import type { SessionPage, SessionPageOptions, SessionPageRow } from '@relavium/db';
import { describe, expect, it, vi } from 'vitest';

import { NATIVE_PICKER_PAGE_SIZE } from '../render/tui/native-picker.js';
import { createSessionsPort, SESSIONS_LIST_MAX } from './sessions-port.js';
import { createSessionPickerSource } from './session-picker.js';

// A key-shaped string, built from parts so no literal credential sits in the source.
const KEY = `sk-${'A1b2C3d4E5'.repeat(3)}`;
const MASK = '[REDACTED]';

const CWD = '/work/project';
const NOW = Date.parse('2026-11-23T12:00:00.000Z');

const row = (index: number, over: Partial<SessionPageRow> = {}): SessionPageRow => ({
  id: `sess-${String(index).padStart(3, '0')}`,
  agentSlug: 'coder',
  title: `Conversation ${String(index)}`,
  updatedAt: new Date(NOW - index * 60_000).toISOString(),
  workingDir: CWD,
  ...over,
});

/** A conversation that has no title at all (the store leaves the field out, it does not set it to `undefined`). */
const untitled = (index: number): SessionPageRow => ({
  id: `sess-${String(index).padStart(3, '0')}`,
  agentSlug: 'coder',
  updatedAt: new Date(NOW - index * 60_000).toISOString(),
  workingDir: CWD,
});

/** A store of `rows` (newest first) that answers like `listSessionPage` for the options the tab and the picker use. */
function storeOf(rows: readonly SessionPageRow[]) {
  const listSessionPage = vi.fn((options: SessionPageOptions = {}): SessionPage => {
    const limit = options.limit ?? 20;
    const scoped = rows.filter(
      (candidate) =>
        options.workingDir === undefined || candidate.workingDir === options.workingDir,
    );
    const selected = scoped.slice(0, limit);
    const last = selected.at(-1);
    return {
      sessions: selected,
      ...(scoped.length > limit && last !== undefined
        ? { next: { updatedAt: last.updatedAt, id: last.id } }
        : {}),
    };
  });
  return { store: { listSessionPage }, listSessionPage };
}

describe('createSessionsPort', () => {
  it('reads one page of this project’s conversations, the very call the /resume picker makes, and keeps each row’s own id', () => {
    const { store, listSessionPage } = storeOf([row(0), row(1), row(2, { workingDir: '/other' })]);
    const read = createSessionsPort({ store, cwd: CWD, now: () => NOW }).read();
    expect(listSessionPage).toHaveBeenCalledTimes(1);
    expect(listSessionPage).toHaveBeenCalledWith({ limit: SESSIONS_LIST_MAX, workingDir: CWD });
    expect(read.rows.map((r) => [r.id, r.title, r.agent, r.age])).toEqual([
      ['sess-000', 'Conversation 0', 'coder', 'just now'],
      ['sess-001', 'Conversation 1', 'coder', '1m ago'],
    ]);
    expect(read.more).toBe(false);
  });

  it('lists the conversations the /resume picker offers first, in the same order, and no others', async () => {
    const all = Array.from({ length: 30 }, (_, index) => row(index));
    const { store } = storeOf(all);
    const listed = createSessionsPort({ store, cwd: CWD, now: () => NOW })
      .read()
      .rows.map((r) => r.id);
    const picker = createSessionPickerSource({
      store,
      cwd: CWD,
      now: () => NOW,
      assertAdmitting: () => undefined,
      runRead: (operation) => operation(),
    });
    const page = await picker('', false, new AbortController().signal);
    if ('unavailable' in page) throw new Error('the picker could not read the store');
    const offered = page.options.map((option) => option.value);
    expect(offered).toHaveLength(NATIVE_PICKER_PAGE_SIZE);
    expect(listed.slice(0, offered.length)).toEqual(offered);
    expect(listed).toHaveLength(SESSIONS_LIST_MAX);
  });

  it('says when older conversations exist than the page holds', () => {
    const many = Array.from({ length: SESSIONS_LIST_MAX + 1 }, (_, index) => row(index));
    const { store } = storeOf(many);
    const read = createSessionsPort({ store, cwd: CWD, now: () => NOW }).read();
    expect(read.rows).toHaveLength(SESSIONS_LIST_MAX);
    expect(read.more).toBe(true);
  });

  it('sanitizes what a title can carry: a key is masked, controls and escapes are gone, and a long one is bounded', () => {
    const { store } = storeOf([
      row(0, { title: `Deploy with ${KEY} now` }),
      row(1, { title: 'bell\u0007 and \u001b[31mred\u001b[0m' }),
      row(2, { title: 'x'.repeat(2000) }),
      row(3, { agentSlug: `agent-${KEY}` }),
    ]);
    const rows = createSessionsPort({ store, cwd: CWD, now: () => NOW }).read().rows;
    expect(rows[0]?.title).toContain(MASK);
    expect(JSON.stringify(rows)).not.toContain(KEY);
    expect(
      [...(rows[1]?.title ?? '')].every(
        (char) => char.charCodeAt(0) > 0x1f && char.charCodeAt(0) !== 0x7f,
      ),
      'no control character is left in the title',
    ).toBe(true);
    expect(rows[1]?.title).toContain('red');
    expect((rows[2]?.title ?? '').length).toBeLessThanOrEqual(121);
    expect(rows[2]?.title).toMatch(/…$/u);
    expect(rows[3]?.agent).toContain(MASK);
  });

  it('calls a conversation with no title, or none that survives the scrub, Untitled', () => {
    const { store } = storeOf([
      untitled(0),
      row(1, { title: '\u0007\u0007' }),
      row(2, { title: '   ' }),
    ]);
    const rows = createSessionsPort({ store, cwd: CWD, now: () => NOW }).read().rows;
    expect(rows.map((r) => r.title)).toEqual(['Untitled', 'Untitled', 'Untitled']);
  });

  it('leaves a store that cannot be read to the tab, which then says it cannot list', () => {
    const port = createSessionsPort({
      store: {
        listSessionPage: () => {
          throw new Error('PRIVATE_FAULT_TEXT');
        },
      },
      cwd: CWD,
      now: () => NOW,
    });
    expect(() => port.read()).toThrow();
  });
});
