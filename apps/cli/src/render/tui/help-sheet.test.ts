/**
 * The pure model of the landing's `/help` sheet ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §3): which commands it lists, which keys it names, and that no line is wider than the sheet frame or the sheet taller than its rows.
 * `home-help-sheet.test.ts` presses every key the sheet names through the real Home controller, and `home-help-sheet-app.test.tsx` draws it.
 */
import { describe, expect, it } from 'vitest';

import {
  HOME_PALETTE_COMMANDS,
  REPL_COMMANDS,
  type ReplCommand,
} from '../../commands/repl-commands.js';
import {
  HELP_SHEET_KEYS,
  HELP_SHEET_ROWS,
  HELP_TOO_SMALL,
  HOME_HELP_COMMANDS,
  HOME_KEYS,
  helpSheetLines,
} from './help-sheet.js';
import { usableColumns } from './sheet-frame.js';
import { displayWidth } from './viewport.js';

const textOf = (columns: number, terminalRows = 24, commands?: readonly ReplCommand[]) =>
  helpSheetLines({ columns, terminalRows }, commands).map((line) => line.text);

/** The command rows of a sheet: those whose first word is a slash word (the keys' rows start with a key name). */
const commandRows = (lines: readonly string[]): string[] =>
  lines.filter((line) => /^ {2}\/[a-z]/u.test(line));

const SIZES: readonly (readonly [number, number])[] = [
  [80, 24],
  [81, 25],
  [100, 30],
  [120, 50],
  [200, 24],
  [500, 80],
];

describe('which commands the sheet lists', () => {
  it('lists /help and every command the bare Home offers, each by name with its description', () => {
    const rows = commandRows(textOf(200));
    // The home-enabled registry commands, /help (typed at the landing, though the registry marks it a chat's) and the Home's own.
    const expected = new Set([
      'help',
      ...REPL_COMMANDS.filter((command) => command.availableIn.includes('home')).map(
        (command) => command.name,
      ),
      ...HOME_PALETTE_COMMANDS.map((command) => command.name),
    ]);
    expect(expected.size).toBeGreaterThan(8);
    expect(rows).toHaveLength(expected.size);
    for (const command of HOME_HELP_COMMANDS) {
      const row = rows.find((candidate) => candidate.startsWith(`  /${command.name} `));
      expect(row, `/${command.name} has a row`).toBeDefined();
      // A description longer than the row is cut with `…`: what is shown is then the start of it, and never anything else.
      const shown = (row ?? '').slice((row ?? '').indexOf(' ', 3)).trim();
      const whole = shown === command.description;
      const cut = shown.endsWith('…') && command.description.startsWith(shown.slice(0, -1));
      expect(whole || cut, `/${command.name}: ${shown}`).toBe(true);
      expect(shown.length, `/${command.name} shows more than its name`).toBeGreaterThan(5);
    }
    expect(new Set(HOME_HELP_COMMANDS.map((command) => command.name))).toEqual(expected);
  });

  it('shows a short description whole', () => {
    const rows = commandRows(textOf(200));
    const exit = HOME_HELP_COMMANDS.find((command) => command.name === 'exit');
    expect(rows.find((row) => row.startsWith('  /exit '))).toContain(exit?.description);
  });

  it('does not list a command that works only in a chat: /cost, /cancel, /export, /effort and the rest', () => {
    const listed = new Set(HOME_HELP_COMMANDS.map((command) => command.name));
    const rows = commandRows(textOf(200));
    for (const command of REPL_COMMANDS) {
      if (listed.has(command.name)) continue;
      expect(command.availableIn, `/${command.name} is a chat's`).not.toContain('home');
      expect(
        rows.some((row) => row.startsWith(`  /${command.name} `)),
        `/${command.name} has no row`,
      ).toBe(false);
    }
    expect(listed.has('cost')).toBe(false);
  });

  it('lists the commands by name, in one order', () => {
    const names = commandRows(textOf(200)).map((row) => row.trim().split(/\s+/u)[0] ?? '');
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')));
    expect(names).toEqual(HOME_HELP_COMMANDS.map((command) => `/${command.name}`));
  });
});

describe('which keys the sheet names', () => {
  it('names every key of the Home and what it does, from the constants the test presses', () => {
    const lines = textOf(200);
    expect(Object.keys(HOME_KEYS).sort()).toEqual(
      ['back', 'commands', 'eof', 'interrupt', 'newline', 'rows', 'send'].sort(),
    );
    for (const [id, key] of Object.entries(HOME_KEYS)) {
      const row = lines.find((line) => line.trimStart().startsWith(`${key.keys} `));
      expect(row, `${id}: a row for ${key.keys}`).toBeDefined();
      expect(row, `${id}: its verb`).toContain(key.verb);
    }
  });

  it('ends on the legend that names the sheet’s own keys, and they are the ones the constant says', () => {
    const lines = textOf(80);
    expect(lines.at(-1)).toBe(`${HELP_SHEET_KEYS.close.keys} ${HELP_SHEET_KEYS.close.verb}`);
    expect(HELP_SHEET_KEYS.close.keys).toBe('Esc / Ctrl+C');
    expect(HELP_SHEET_KEYS.close.presses).toEqual([
      { input: '', key: { escape: true } },
      { input: 'c', key: { ctrl: true } },
    ]);
  });

  it('writes every verb as a lower-case phrase with no full stop', () => {
    for (const key of Object.values(HOME_KEYS)) {
      expect(key.verb).toMatch(/^[a-z]/u);
      expect(key.verb.endsWith('.')).toBe(false);
    }
  });
});

describe('the frame', () => {
  it.each(SIZES)(
    'fits %i columns by %i rows: no line wider than the sheet, no more rows than it may take',
    (columns, rows) => {
      const lines = helpSheetLines({ columns, terminalRows: rows });
      expect(lines.length).toBeLessThanOrEqual(HELP_SHEET_ROWS);
      expect(lines.length).toBeLessThanOrEqual(rows - 1);
      for (const line of lines)
        expect(displayWidth(line.text), line.text).toBeLessThanOrEqual(usableColumns(columns));
    },
  );

  it('draws the whole of it at 80x24: both lists, the legend and no note about anything left out', () => {
    const lines = textOf(80);
    expect(lines[0]).toBe('Commands');
    expect(lines).toContain('Keys of the Home');
    expect(lines.length).toBeLessThanOrEqual(HELP_SHEET_ROWS);
    expect(lines.some((line) => /more$/u.test(line))).toBe(false);
  });

  it('keeps every span inside its line', () => {
    for (const [columns, rows] of SIZES)
      for (const line of helpSheetLines({ columns, terminalRows: rows }))
        for (const span of line.spans ?? []) {
          expect(span.from).toBeGreaterThanOrEqual(0);
          expect(span.to).toBeLessThanOrEqual(line.text.length);
          expect(span.to).toBeGreaterThan(span.from);
        }
  });

  it('cuts a list of commands too long for the rows, says how many it left out, and keeps the keys and the way out', () => {
    const many: readonly ReplCommand[] = Array.from({ length: 40 }, (_, index) => ({
      name: `cmd${String.fromCharCode(97 + (index % 26))}${String(index)}`,
      label: 'x',
      description: `Does the ${String(index)}th thing.`,
      effect: 'read' as const,
      run: () => undefined,
      availableIn: ['home' as const],
    }));
    const lines = textOf(80, 24, many);
    expect(lines.length).toBeLessThanOrEqual(HELP_SHEET_ROWS);
    const shown = commandRows(lines).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(40);
    expect(lines).toContain(`  and ${String(40 - shown)} more`);
    expect(lines).toContain('Keys of the Home');
    expect(lines.at(-1)).toBe('Esc / Ctrl+C close');
  });

  it.each([
    [79, 24],
    [80, 23],
    [40, 10],
    [12, 24],
  ])(
    'below the floor (%i x %i) it is two lines that fit: the hint to enlarge and the way out',
    (columns, rows) => {
      const lines = helpSheetLines({ columns, terminalRows: rows });
      expect(lines).toHaveLength(2);
      expect(lines[0]?.text.startsWith(HELP_TOO_SMALL.slice(0, Math.min(8, columns)))).toBe(true);
      expect(lines[1]?.text.startsWith('Esc')).toBe(true);
      for (const line of lines)
        expect(displayWidth(line.text), line.text).toBeLessThanOrEqual(usableColumns(columns));
    },
  );
});
