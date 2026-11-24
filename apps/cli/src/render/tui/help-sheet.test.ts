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

/** The slash words a sheet names, in the order it names them: a described row names one, a row of names several. */
const namedCommands = (lines: readonly string[]): string[] =>
  commandRows(lines).flatMap((row) =>
    row
      .trim()
      .split(/ {2,}/u)
      .filter((part) => /^\/[a-z][a-z0-9-]*$/u.test(part)),
  );

/** A row that gives `name` a line of its own, with its description after it (a row of names alone does not). */
const describedRow = (lines: readonly string[], name: string): string | undefined =>
  commandRows(lines).find(
    (row) =>
      row.startsWith(`  /${name} `) && !/^ {2}\/[a-z0-9-]+( {2,}\/[a-z0-9-]+)+ *$/u.test(row),
  );

const SIZES: readonly (readonly [number, number])[] = [
  [80, 24],
  [81, 25],
  [100, 30],
  [120, 50],
  [200, 24],
  [500, 80],
];

describe('which commands the sheet lists', () => {
  it('names /help and every command the bare Home offers, and gives a row with its description to as many as the rows allow', () => {
    const lines = textOf(200);
    // The home-enabled registry commands, /help (typed at the landing, though the registry marks it a chat's) and the Home's own.
    const expected = new Set([
      'help',
      ...REPL_COMMANDS.filter((command) => command.availableIn.includes('home')).map(
        (command) => command.name,
      ),
      ...HOME_PALETTE_COMMANDS.map((command) => command.name),
    ]);
    expect(expected.size).toBeGreaterThan(8);
    // The invariant: every command is named, whatever the number of commands is (the rows that are left give up descriptions first).
    expect(namedCommands(lines).sort()).toEqual([...expected].map((name) => `/${name}`).sort());
    let described = 0;
    for (const command of HOME_HELP_COMMANDS) {
      const row = describedRow(lines, command.name);
      if (row === undefined) continue;
      described += 1;
      // A description longer than the row is cut with `…`: what is shown is then the start of it, and never anything else.
      const shown = row.slice(row.indexOf(' ', 3)).trim();
      const whole = shown === command.description;
      const cut = shown.endsWith('…') && command.description.startsWith(shown.slice(0, -1));
      expect(whole || cut, `/${command.name}: ${shown}`).toBe(true);
      expect(shown.length, `/${command.name} shows more than its name`).toBeGreaterThan(5);
    }
    expect(described, 'at least the first commands keep their description').toBeGreaterThan(4);
    expect(new Set(HOME_HELP_COMMANDS.map((command) => command.name))).toEqual(expected);
  });

  it('shows a short description whole', () => {
    const exit = HOME_HELP_COMMANDS.find((command) => command.name === 'exit');
    expect(describedRow(textOf(200), 'exit')).toContain(exit?.description);
  });

  it('does not list a command that works only in a chat: /cost, /cancel, /export, /effort and the rest', () => {
    const listed = new Set(HOME_HELP_COMMANDS.map((command) => command.name));
    const named = new Set(namedCommands(textOf(200)));
    for (const command of REPL_COMMANDS) {
      if (listed.has(command.name)) continue;
      expect(command.availableIn, `/${command.name} is a chat's`).not.toContain('home');
      expect(named.has(`/${command.name}`), `/${command.name} is not named`).toBe(false);
    }
    expect(listed.has('cost')).toBe(false);
  });

  it('lists the commands by name, in one order', () => {
    const names = namedCommands(textOf(200));
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

  it('says what the Home does with a run in view, whole at 80×24: `Enter` opens it, a row is any row of the strip, and leaving asks first', () => {
    const lines = textOf(80);
    const rowOf = (keys: string): string =>
      lines.find((line) => line.trimStart().startsWith(`${keys} `)) ?? '';
    expect(rowOf('Enter')).toContain('or open the row or the running run');
    expect(rowOf('↓')).toContain('move onto a row of the strip');
    expect(rowOf('Ctrl+D')).toContain('asks first while a run executes');
    expect(rowOf('Ctrl+C')).toContain('asks first while a run executes');
    // No verb is cut at 80 columns: every key row carries its verb whole.
    for (const key of Object.values(HOME_KEYS)) expect(rowOf(key.keys)).toContain(key.verb);
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

  it('draws the whole of it at 80x24: every command named, every key, the legend and no note about anything left out', () => {
    const lines = textOf(80);
    expect(lines[0]).toBe('Commands');
    expect(lines).toContain('Keys of the Home');
    // The invariant, not a row count: never more rows than the sheet may take, and every command of the Home is named in them.
    expect(lines.length).toBeLessThanOrEqual(HELP_SHEET_ROWS);
    expect(namedCommands(lines).sort()).toEqual(
      HOME_HELP_COMMANDS.map((command) => `/${command.name}`).sort(),
    );
    for (const key of Object.values(HOME_KEYS))
      expect(
        lines.some((line) => line.includes(key.keys)),
        key.keys,
      ).toBe(true);
    expect(lines.some((line) => /\d+ more$/u.test(line))).toBe(false);
    expect(lines.at(-1)).toBe('Esc / Ctrl+C close');
  });

  it('names /import and /pricing at every size the sheet is drawn at, in at most 23 rows and with no note about anything left out', () => {
    for (const [columns, rows] of SIZES) {
      const lines = textOf(columns, rows); // every size in SIZES is at or above the floor the sheet is drawn at
      const named = namedCommands(lines);
      for (const word of ['/import', '/pricing'])
        expect(named, `${word} at ${String(columns)}x${String(rows)}`).toContain(word);
      expect(lines.length).toBeLessThanOrEqual(HELP_SHEET_ROWS);
      expect(lines.some((line) => /\d+ more$/u.test(line))).toBe(false);
    }
    // With the two new commands the 80x24 sheet holds every command of the Home and the rows it takes are the ones it may take.
    const at80 = textOf(80, 24);
    expect(HOME_HELP_COMMANDS.map((command) => command.name)).toEqual(
      expect.arrayContaining(['import', 'pricing']),
    );
    expect(namedCommands(at80).length).toBe(HOME_HELP_COMMANDS.length);
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

  const commandsOf = (count: number): readonly ReplCommand[] =>
    Array.from({ length: count }, (_, index) => ({
      name: `cmd${String.fromCharCode(97 + (index % 26))}${String(index)}`,
      label: 'x',
      description: `Does the ${String(index)}th thing.`,
      effect: 'read' as const,
      run: () => undefined,
      availableIn: ['home' as const],
    }));

  it.each([1, 13, 14, 15, 25, 40, 80])(
    'with %i commands: never more rows than it may take, every command named, the keys and the way out kept',
    (count) => {
      const many = commandsOf(count);
      const lines = textOf(80, 24, many);
      expect(lines.length).toBeLessThanOrEqual(HELP_SHEET_ROWS);
      expect(namedCommands(lines)).toEqual(many.map((command) => `/${command.name}`));
      expect(lines.some((line) => /^ {2}and \d+ more$/u.test(line))).toBe(false);
      expect(lines).toContain('Keys of the Home');
      for (const key of Object.values(HOME_KEYS))
        expect(
          lines.some((line) => line.includes(key.keys)),
          key.keys,
        ).toBe(true);
      expect(lines.at(-1)).toBe('Esc / Ctrl+C close');
      for (const line of lines)
        expect(displayWidth(line), line).toBeLessThanOrEqual(usableColumns(80));
    },
  );

  it('gives up descriptions before it gives up a command: the first commands keep theirs, the last are named alone, several to a row', () => {
    const lines = textOf(80, 24, commandsOf(40));
    const described = commandsOf(40).filter((command) => describedRow(lines, command.name));
    expect(described.length, 'some keep a description').toBeGreaterThan(0);
    expect(described.length, 'some do not').toBeLessThan(40);
    // The commands that keep a description are the first ones, in order.
    expect(described.map((command) => command.name)).toEqual(
      commandsOf(40)
        .slice(0, described.length)
        .map((command) => command.name),
    );
    const rest = commandRows(lines).filter((row) =>
      /^ {2}\/[a-z0-9-]+( {2,}\/[a-z0-9-]+)+ *$/u.test(row),
    );
    expect(rest.length, 'the rest are on rows of names').toBeGreaterThan(0);
  });

  it('counts what it leaves out only when even the names do not fit, and then names the count of what it did not show', () => {
    const many = commandsOf(400);
    const lines = textOf(80, 24, many);
    expect(lines.length).toBeLessThanOrEqual(HELP_SHEET_ROWS);
    const shown = namedCommands(lines).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(400);
    expect(lines).toContain(`  and ${String(400 - shown)} more`);
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
