import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { REASONING_EFFORTS } from '@relavium/shared';

import { AttachmentBar } from './attachment-bar.js';
import { foldEffortPickerKey, type EffortPickerState } from './effort-picker.js';
import { EFFORT_OVERLAY_FOOTER, EffortTierList } from './effort-tier-list.js';
import {
  INITIAL_REVERSE_SEARCH,
  foldReverseSearchKey,
  reverseSearchExtendQuery,
} from './input-history.js';
import { foldMentionKey, type MentionState } from './mention.js';
import { MentionView } from './mention-view.js';
import { buildPaletteEntries, filterPaletteEntries } from './palette-entries.js';
import { reducePaletteKey, type PaletteList } from './palette-reducer.js';
import { PaletteView } from './palette-view.js';
import { ReverseSearchView } from './reverse-search-view.js';

/**
 * The legend under each small overlay of the prompt (the `/` palette, the `Ctrl+R` search, the `@` completion and the `/effort` list) says
 * only keys its fold answers, and each does what its word says ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md)
 * §3: a test presses every key a legend lists). The legend is read from the frame the real view draws, so a word changed in the view and
 * not in the fold, or the other way, fails here.
 */
afterEach(cleanup);

/** The keys a legend row lists: the first word of each ` · ` item, as written (brackets and all). */
const listedKeys = (row: string): string[] =>
  row.split(' · ').map((item) => item.split(' ')[0] ?? '');

/** The last non-empty row of a frame: where each of these views draws its legend, or the one above it. */
const rowsOf = (frame: string | undefined): string[] =>
  (frame ?? '').split('\n').map((line) => line.trimEnd());

describe('the palette legend', () => {
  const entries = buildPaletteEntries('home', { hasKey: true });
  const listOf = (layout: 'down' | 'up'): PaletteList => ({
    entries,
    rows: filterPaletteEntries(entries, ''),
    layout,
  });

  it.each(['down', 'up'] as const)(
    'lists ↑/↓, Enter and Esc, and the fold answers each (the list runs %s)',
    (layout) => {
      const view = render(
        <PaletteView list={listOf(layout)} state={{ query: '', index: 0 }} color={false} />,
      );
      const legend = rowsOf(view.lastFrame()).find((row) => row.includes('Enter run')) ?? '';
      expect(legend).toBe('↑/↓ select · Enter run · Esc close');
      expect(listedKeys(legend)).toEqual(['↑/↓', 'Enter', 'Esc']);
      expect(reducePaletteKey('', { upArrow: true }, layout).kind).toBe('move');
      expect(reducePaletteKey('', { downArrow: true }, layout).kind).toBe('move');
      expect(reducePaletteKey('', { return: true }, layout)).toEqual({ kind: 'select' });
      expect(reducePaletteKey('', { escape: true }, layout)).toEqual({ kind: 'cancel' });
    },
  );
});

describe('the reverse-search legend', () => {
  const entries = ['git status', 'npm test', 'npm run build'];

  it('lists Ctrl+R, Enter and Esc, and the fold answers each', () => {
    const state = reverseSearchExtendQuery(entries, INITIAL_REVERSE_SEARCH, 'npm');
    const view = render(<ReverseSearchView state={state} entries={entries} color={false} />);
    const legend = rowsOf(view.lastFrame()).find((row) => row.includes('older')) ?? '';
    expect(legend).toBe('[Ctrl+R] older · Enter accept · Esc close');
    expect(listedKeys(legend)).toEqual(['[Ctrl+R]', 'Enter', 'Esc']);
    // Ctrl+R steps to the next older match, Enter accepts the match it shows, Esc closes and keeps the draft as it was.
    const older = foldReverseSearchKey('r', { ctrl: true }, state, entries);
    expect(older.kind).toBe('state');
    expect(older.kind === 'state' && older.state.matchIndex).not.toBe(state.matchIndex);
    expect(foldReverseSearchKey('', { return: true }, state, entries)).toEqual({
      kind: 'accept',
      text: 'npm run build',
    });
    expect(foldReverseSearchKey('', { escape: true }, state, entries)).toEqual({ kind: 'close' });
  });
});

describe('the @ completion legend', () => {
  const state: MentionState = {
    dir: '',
    filter: '',
    selected: 0,
    loading: false,
    candidates: [
      { name: 'src', type: 'directory', path: 'src' },
      { name: 'a.md', type: 'file', path: 'a.md' },
    ],
  };

  it('lists ↑/↓, Enter and Esc, and the fold answers each (Enter opens a directory and inserts a file)', () => {
    const view = render(<MentionView state={state} color={false} />);
    const legend = rowsOf(view.lastFrame()).find((row) => row.includes('open/insert')) ?? '';
    expect(legend).toBe('↑/↓ select · Enter open/insert · Esc close');
    expect(listedKeys(legend)).toEqual(['↑/↓', 'Enter', 'Esc']);
    expect(foldMentionKey('', { downArrow: true }, state)).toEqual({
      kind: 'state',
      state: { ...state, selected: 1 },
    });
    expect(foldMentionKey('', { upArrow: true }, { ...state, selected: 1 })).toEqual({
      kind: 'state',
      state: state,
    });
    expect(foldMentionKey('', { return: true }, state)).toEqual({ kind: 'descend', dir: 'src' });
    expect(foldMentionKey('', { return: true }, { ...state, selected: 1 })).toEqual({
      kind: 'accept',
      path: 'a.md',
    });
    expect(foldMentionKey('', { escape: true }, state)).toEqual({ kind: 'close', restore: '@' });
  });
});

describe('the /effort overlay legend', () => {
  const picker: EffortPickerState = {
    tiers: [...REASONING_EFFORTS],
    selected: 1,
    current: undefined,
    model: 'deepseek-v4-flash',
  };

  it('lists ↑/↓, Enter and Esc, and the fold answers each (Esc closes: the session keeps its effort)', () => {
    const view = render(
      <EffortTierList
        tiers={picker.tiers}
        model={picker.model}
        selected={picker.selected}
        current={picker.current}
        footer={EFFORT_OVERLAY_FOOTER}
        color={false}
      />,
    );
    const legend = rowsOf(view.lastFrame()).find((row) => row.includes('apply')) ?? '';
    expect(legend).toBe('↑/↓ select · Enter apply · Esc close');
    expect(listedKeys(legend)).toEqual(['↑/↓', 'Enter', 'Esc']);
    expect(foldEffortPickerKey('', { downArrow: true }, picker)).toEqual({
      kind: 'state',
      state: { ...picker, selected: 2 },
    });
    expect(foldEffortPickerKey('', { upArrow: true }, picker)).toEqual({
      kind: 'state',
      state: { ...picker, selected: 0 },
    });
    expect(foldEffortPickerKey('', { return: true }, picker)).toEqual({
      kind: 'accept',
      effort: REASONING_EFFORTS[1],
    });
    expect(foldEffortPickerKey('', { escape: true }, picker).kind).toBe('close');
  });
});

describe('the attachment bar legend', () => {
  it('lists Esc, which clears the queued attachments, and states what it does as a fact', () => {
    const view = render(
      <AttachmentBar
        color={false}
        attachments={[
          { kind: 'file', path: 'src/a.ts', content: 'x', sizeBytes: 1 },
          {
            kind: 'command',
            cmd: { command: 'npm', args: ['test'] },
            exitCode: 0,
            stdout: '',
            stderr: '',
          },
        ]}
      />,
    );
    const bar = rowsOf(view.lastFrame()).find((row) => row.includes('📎')) ?? '';
    expect(bar).toBe('📎 @src/a.ts \u00b7 !npm test (exit 0) \u00b7 Esc clears them');
    expect(listedKeys(bar.slice(bar.lastIndexOf(' \u00b7 ') + 3))).toEqual(['Esc']);
    // The key is answered where the bar is drawn: `Esc` at an idle prompt (home-controller.test.ts presses it: both attachments go, a note is made).
  });
});
