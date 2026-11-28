/**
 * Two rules of the popup frame ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §3, §4)
 * that `frame-model.test.ts` leaves open (found by the step-5 round-1 mutation sweep): the ONE filter of a list (what the typed text is compared
 * to, how, and which rows no text can hide), and the width at which a form's tab row starts leaving options out.
 */
import { describe, expect, it } from 'vitest';

import { displayWidth } from '../render/tui/viewport.js';
import { filterListRows, formLines, type PopupForm, type PopupListRow } from './frame-model.js';

const ids = (rows: readonly PopupListRow[]): string[] => rows.map((row) => row.id);

describe('the filter of a list', () => {
  const rows: readonly PopupListRow[] = [
    { id: 'a', label: 'GPT-5', detail: 'OpenAI' },
    { id: 'b', label: 'claude' },
    { id: 'c', label: 'o3', match: 'Reasoning Model' },
    { id: 'refresh', label: 'Refresh the list', pinned: true },
  ];

  it('folds the typed text: an upper-case query finds a lower-case label, detail and match word', () => {
    expect(
      ids(filterListRows([{ id: 'x', label: 'gpt-5', detail: 'openai', match: 'big' }], 'GPT')),
    ).toEqual(['x']);
    expect(
      ids(filterListRows([{ id: 'x', label: 'gpt-5', detail: 'openai', match: 'big' }], 'OPENAI')),
    ).toEqual(['x']);
    expect(
      ids(filterListRows([{ id: 'x', label: 'gpt-5', detail: 'openai', match: 'big' }], 'BIG')),
    ).toEqual(['x']);
  });

  it('folds what it searches: an upper-case label, detail or match word is found by a lower-case query', () => {
    expect(ids(filterListRows(rows, 'gpt'))).toEqual(['a', 'refresh']);
    expect(ids(filterListRows(rows, 'openai'))).toEqual(['a', 'refresh']);
    expect(ids(filterListRows(rows, 'reasoning'))).toEqual(['c', 'refresh']);
  });

  it('searches the words a row never draws (its match) as well as its label and detail', () => {
    expect(ids(filterListRows(rows, 'model'))).toEqual(['c', 'refresh']);
    expect(ids(filterListRows(rows, 'clau'))).toEqual(['b', 'refresh']);
  });

  it('keeps a pinned row under any filter, where it sits, even one that matches nothing', () => {
    expect(ids(filterListRows(rows, 'zzz'))).toEqual(['refresh']);
    expect(ids(filterListRows(rows, 'claude'))).toEqual(['b', 'refresh']);
  });

  it('leaves every row for a filter that is empty, blank or absent, and ignores the blanks around a typed one', () => {
    for (const filter of [undefined, '', '   ']) expect(filterListRows(rows, filter)).toBe(rows);
    expect(ids(filterListRows(rows, '  claude  '))).toEqual(['b', 'refresh']);
  });
});

describe('a form’s tab row', () => {
  const form: PopupForm = {
    kind: 'form',
    tabs: {
      label: 'Reasoning effort',
      verb: 'effort',
      options: ['low', 'medium', 'high'].map((id) => ({ id, label: id })),
    },
  };
  const rowAt = (width: number): string | undefined =>
    formLines(form, { selected: 0, tab: 1 }, width, 'compact')
      .find((line) => line.text.includes('medium'))
      ?.text.replace(/\s+$/u, '');

  it('keeps every option on a row exactly as wide as the tabs: nothing is left out at the exact width', () => {
    const full = rowAt(100);
    expect(full).toBeDefined();
    expect(full).not.toContain('…');
    const exact = displayWidth(full ?? '');
    expect(rowAt(exact)).toBe(full);
  });

  it('leaves the option farthest from the chosen one out, ending in the ellipsis, as soon as the row is one column narrower', () => {
    const full = rowAt(100) ?? '';
    const narrower = rowAt(displayWidth(full) - 1);
    expect(narrower).toBeDefined();
    expect(narrower).toContain('…');
    expect(narrower).toContain('medium');
    expect(narrower).not.toBe(full);
  });
});
