import './force-color.js';

import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import type { ReplCommand } from '../../commands/repl-commands.js';
import { PaletteView } from './palette-view.js';

/**
 * The `/` palette as the terminal shows it ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §3): the lines of a palette whose entries all fit are the ones it always drew (the literals below are those lines), and a palette given
 * fewer rows than it has entries draws a window of them, with a marker for the entries it hides, the highlighted entry always in it.
 */
afterEach(cleanup);

const ESC = String.fromCharCode(0x1b);
const plain = (text: string): string => text.replace(new RegExp(`${ESC}\\[\\d+m`, 'gu'), '');

const command = (name: string, description: string): ReplCommand => ({
  name,
  label: name,
  description,
  effect: 'read',
  availableIn: ['home'],
  run: () => undefined,
});
const SHORT: readonly ReplCommand[] = [
  command('exit', 'End the chat session.'),
  command('doctor', 'Check your setup.'),
  command('models', 'Switch model (opens the catalog picker).'),
];
const MANY: readonly ReplCommand[] = Array.from({ length: 14 }, (_, index) =>
  command(`cmd${String(index)}`, `Does thing ${String(index)}.`),
);

function lines(
  commands: readonly ReplCommand[],
  state: { query: string; index: number },
  maxRows?: number,
): string[] {
  const view = render(
    <PaletteView
      commands={commands}
      state={state}
      color={false}
      {...(maxRows === undefined ? {} : { maxRows })}
    />,
  );
  return plain(view.lastFrame() ?? '').split('\n');
}

describe('a palette whose entries all fit', () => {
  const UNBOUNDED = [
    '',
    '/',
    '› /exit  End the chat session.',
    '  /doctor  Check your setup.',
    '  /models  Switch model (opens the catalog picker).',
    '↑/↓ select · Enter run · Esc cancel',
  ];

  it('is drawn as it always was, with no bound given', () => {
    expect(lines(SHORT, { query: '', index: 0 })).toEqual(UNBOUNDED);
  });

  it.each([6, 7, 24, 100])('is drawn the same with %i rows to draw in', (maxRows) => {
    expect(lines(SHORT, { query: '', index: 0 }, maxRows)).toEqual(UNBOUNDED);
  });

  it('moves the highlight and filters on the name and the description, as it always did', () => {
    expect(lines(SHORT, { query: '', index: 2 }, 24)).toEqual([
      '',
      '/',
      '  /exit  End the chat session.',
      '  /doctor  Check your setup.',
      '› /models  Switch model (opens the catalog picker).',
      '↑/↓ select · Enter run · Esc cancel',
    ]);
    expect(lines(SHORT, { query: 'catalog', index: 0 }, 24)).toEqual([
      '',
      '/catalog',
      '› /models  Switch model (opens the catalog picker).',
      '↑/↓ select · Enter run · Esc cancel',
    ]);
    expect(lines(SHORT, { query: 'zzz', index: 0 }, 6)).toEqual([
      '',
      '/zzz',
      'no matching command',
      '↑/↓ select · Enter run · Esc cancel',
    ]);
  });
});

describe('a palette with more entries than rows', () => {
  it('draws a window of the entries, the highlighted one in it, and says how many it hides', () => {
    // 9 rows: the gap, the query and the legend, and six lines of entries.
    const top = lines(MANY, { query: '', index: 0 }, 9);
    expect(top).toEqual([
      '',
      '/',
      '› /cmd0  Does thing 0.',
      '  /cmd1  Does thing 1.',
      '  /cmd2  Does thing 2.',
      '  /cmd3  Does thing 3.',
      '  /cmd4  Does thing 4.',
      '  ▼ 9 more',
      '↑/↓ select · Enter run · Esc cancel',
    ]);
    const bottom = lines(MANY, { query: '', index: 13 }, 9);
    expect(bottom).toEqual([
      '',
      '/',
      '  ▲ 9 more',
      '  /cmd9  Does thing 9.',
      '  /cmd10  Does thing 10.',
      '  /cmd11  Does thing 11.',
      '  /cmd12  Does thing 12.',
      '› /cmd13  Does thing 13.',
      '↑/↓ select · Enter run · Esc cancel',
    ]);
  });

  it('never draws more lines than the rows it was given, and the legend is always the last one', () => {
    for (const maxRows of [4, 5, 6, 9, 12, 16])
      for (const index of [0, 7, 13]) {
        const drawn = lines(MANY, { query: '', index }, maxRows);
        // The gap above the query is the frame's first line, so the frame is the palette's rows.
        expect(drawn.length, `${String(maxRows)} rows, entry ${String(index)}`).toBeLessThanOrEqual(
          maxRows,
        );
        expect(drawn.at(-1)).toBe('↑/↓ select · Enter run · Esc cancel');
        expect(
          drawn.some((line) => line.startsWith(`› /cmd${String(index)}  `)),
          `${String(maxRows)} rows: the highlighted entry ${String(index)} is drawn`,
        ).toBe(true);
      }
  });

  it('filters first and windows what matches', () => {
    // Five of the fourteen match `thing 1`: three rows of chrome and five of entries fit them, so there is no marker...
    expect(lines(MANY, { query: 'thing 1', index: 0 }, 8)).toEqual([
      '',
      '/thing 1',
      '› /cmd1  Does thing 1.',
      '  /cmd10  Does thing 10.',
      '  /cmd11  Does thing 11.',
      '  /cmd12  Does thing 12.',
      '  /cmd13  Does thing 13.',
      '↑/↓ select · Enter run · Esc cancel',
    ]);
    // ...and with a row fewer the fifth is the one the marker stands on.
    expect(lines(MANY, { query: 'thing 1', index: 0 }, 7)).toEqual([
      '',
      '/thing 1',
      '› /cmd1  Does thing 1.',
      '  /cmd10  Does thing 10.',
      '  /cmd11  Does thing 11.',
      '  ▼ 2 more',
      '↑/↓ select · Enter run · Esc cancel',
    ]);
  });
});
