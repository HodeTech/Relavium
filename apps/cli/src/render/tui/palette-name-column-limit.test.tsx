import './force-color.js';

import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import type { ReplCommand } from '../../commands/repl-commands.js';
import { filterPaletteEntries, type PaletteEntry } from './palette-entries.js';
import type { PaletteList } from './palette-reducer.js';
import { PALETTE_NAME_COLUMN_MAX, PaletteView } from './palette-view.js';

/**
 * The widest the palette's name column is drawn is a NUMBER, sixteen columns with the slash (OB7-L8), and `palette-name-column.test.tsx` states it
 * through the constant itself, so loosening the constant to fifteen moved the test with it and nothing failed (MVP-11 unit 7, round 1: the mutation
 * sweep's pal007). Here the sixteen is written out: a name that is exactly sixteen columns wide with its slash is drawn whole and its description
 * starts two spaces after it; one column more is cut with the host's ellipsis to the sixteen.
 */
afterEach(cleanup);

const ESC = String.fromCharCode(0x1b);
const ELLIPSIS = String.fromCodePoint(0x2026);
const plain = (text: string): string => text.replace(new RegExp(`${ESC}\\[[\\d;]*m`, 'gu'), '');

const entry = (name: string, description: string): PaletteEntry => {
  const command: ReplCommand = {
    name,
    label: name,
    description,
    effect: 'read',
    run: () => undefined,
  };
  return { command, description, group: 'work', groupStart: false, enabled: true };
};

/** The rows of a palette (colour off) listing `entries`, in the layout that draws down from the prompt. */
function drawn(entries: readonly PaletteEntry[]): string[] {
  const list: PaletteList = {
    entries,
    rows: filterPaletteEntries(entries, ''),
    layout: 'down',
  };
  const view = render(<PaletteView list={list} state={{ query: '', index: 0 }} color={false} />);
  return plain(view.lastFrame() ?? '').split('\n');
}

/** A command name that is `columns` columns wide with its slash. */
const nameOfWidth = (columns: number): string => 'n'.repeat(columns - 1);

describe('the palette’s name column is sixteen columns wide at most', () => {
  it('is sixteen: the number the design and the longest command (`/permissions`, twelve) are measured against', () => {
    expect(PALETTE_NAME_COLUMN_MAX).toBe(16);
  });

  it('draws a name of exactly sixteen columns whole, and its description two spaces after it', () => {
    const name = nameOfWidth(16);
    const rows = drawn([entry(name, 'Fits exactly.')]);
    const row = rows.find((line) => line.includes('Fits exactly.')) ?? '';
    expect(row, rows.join('\n')).toContain(`/${name}  Fits exactly.`);
    expect(row).not.toContain(ELLIPSIS);
  });

  it('cuts a name of seventeen columns to sixteen, the last of them the host’s ellipsis', () => {
    const name = nameOfWidth(17);
    const rows = drawn([entry(name, 'Is cut.')]);
    const row = rows.find((line) => line.includes('Is cut.')) ?? '';
    expect(row, rows.join('\n')).toContain(`/${name.slice(0, 14)}${ELLIPSIS}  Is cut.`);
    expect(row).not.toContain(`/${name}`);
  });

  it('aligns every description to the sixteen while a name that wide is in view', () => {
    const rows = drawn([entry(nameOfWidth(16), 'Wide.'), entry('ok', 'Narrow.')]);
    const wide = rows.find((line) => line.includes('Wide.')) ?? '';
    const narrow = rows.find((line) => line.includes('Narrow.')) ?? '';
    expect(narrow.indexOf('Narrow.')).toBe(wide.indexOf('Wide.'));
    expect(narrow, rows.join('\n')).toContain(`/ok${' '.repeat(16 - 3)}  Narrow.`);
  });
});
