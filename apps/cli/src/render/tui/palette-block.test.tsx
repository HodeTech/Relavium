import './force-color.js';

import { cleanup, render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import type { ReplCommand } from '../../commands/repl-commands.js';
import { filterPaletteEntries, type PaletteEntry } from './palette-entries.js';
import { paletteQueryEditor, PaletteAbovePrompt } from './palette-block.js';
import type { PaletteLayout, PaletteList } from './palette-reducer.js';
import { PaletteView } from './palette-view.js';
import { Text } from './text.js';

/**
 * AR7-4 (unit 7, round 1): the palette's block above the prompt was written twice, in the chat (`chat-ink.tsx`) and on the Home's work page
 * (`DockedPalette`), with `paletteQueryEditor` defined identically in both. It is one component now, and the landing's `bare` list (the study's frame 11:
 * the list under the prompt, the query typed on the prompt row, the legend on its own row) is the same list the block above the prompt draws. What
 * the two hosts draw is pinned by `chat-palette-block.test.tsx` and `home-palette-fit.test.tsx`; this is the component alone.
 */
afterEach(cleanup);

const ESC = String.fromCharCode(0x1b);
const plain = (text: string): string => text.replace(new RegExp(`${ESC}\\[\\d+m`, 'gu'), '');

const command = (name: string, description: string): ReplCommand => ({
  name,
  label: name,
  description,
  effect: 'read',
  run: () => undefined,
});
const entry = (name: string, description: string): PaletteEntry => ({
  command: command(name, description),
  description,
  group: 'work',
  groupStart: false,
  enabled: true,
});
const ENTRIES: readonly PaletteEntry[] = [
  entry('models', 'Switch model.'),
  entry('mode', 'Choose the mode.'),
  entry('exit', 'Leave.'),
];
const listOf = (layout: PaletteLayout, query = ''): PaletteList => ({
  entries: ENTRIES,
  rows: filterPaletteEntries(ENTRIES, query),
  layout,
});
const linesOf = (element: ReactElement): string[] => {
  const view = render(element);
  const frame = plain(view.lastFrame() ?? '').split('\n');
  view.unmount();
  return frame;
};

describe('paletteQueryEditor: the query as the prompt row holds it', () => {
  it('is the slash and the typed words with the cursor at the end of them', () => {
    expect(paletteQueryEditor('')).toEqual({ text: '/', cursor: 1 });
    expect(paletteQueryEditor('mo')).toEqual({ text: '/mo', cursor: 3 });
  });
});

describe('the palette above the prompt', () => {
  it('draws the list (the first entry beside the prompt), the prompt row with the query, the rule and the legend, in that order', () => {
    const lines = linesOf(
      <PaletteAbovePrompt
        palette={{ list: listOf('up', 'mo'), state: { query: 'mo', index: 0 } }}
        maxRows={12}
        ruleColumns={20}
        color={false}
      />,
    );
    expect(lines).toEqual([
      '  /mode    Choose the mode.',
      '> /models  Switch model.',
      '> /mo ',
      '-'.repeat(20),
      '↑/↓ select · Enter run · Esc close',
    ]);
  });

  it('draws what it is given before the list (a chat’s in-flight turn)', () => {
    const lines = linesOf(
      <PaletteAbovePrompt
        palette={{ list: listOf('up'), state: { query: '', index: 0 } }}
        maxRows={12}
        ruleColumns={10}
        color={false}
        before={<Text>turn in flight</Text>}
      />,
    );
    expect(lines[0]).toBe('turn in flight');
  });

  it('says only the key that closes when nothing matches', () => {
    const lines = linesOf(
      <PaletteAbovePrompt
        palette={{ list: listOf('up', 'zzz'), state: { query: 'zzz', index: 0 } }}
        maxRows={12}
        ruleColumns={10}
        color={false}
      />,
    );
    expect(lines.at(-1)).toBe('Esc close');
    expect(lines).toContain('> /zzz ');
  });
});

describe('PaletteView `bare`: the list alone, in the order of its layout', () => {
  const draw = (layout: PaletteLayout, bare: boolean): string[] =>
    linesOf(
      <PaletteView
        list={listOf(layout, '')}
        state={{ query: '', index: 0 }}
        color={false}
        {...(bare ? { bare: true } : {})}
      />,
    );

  it('a `down` list drawn bare is its entries first to last, with no query line, no blank row above it and no legend', () => {
    expect(draw('down', true)).toEqual([
      '> /models  Switch model.',
      '  /mode    Choose the mode.',
      '  /exit    Leave.',
    ]);
  });

  it('a `down` list not drawn bare still has its query line, its blank row and its legend (the layout’s own)', () => {
    const lines = draw('down', false);
    expect(lines[0]).toBe('');
    expect(lines).toContain('/');
    expect(lines.at(-1)).toBe('↑/↓ select · Enter run · Esc close');
  });

  it('an `up` list is the same body either way: bare changes nothing for it', () => {
    expect(draw('up', true)).toEqual(draw('up', false));
  });
});
