import { describe, expect, it } from 'vitest';

import type { CommandCardFacts } from '../../chat/command-facts.js';
import { fullChrome, fullWarnings } from './tool-review-screen.js';
import { cardWarnings, commandFactRows } from './tool-review-card.js';
import { displayWidth } from './viewport.js';

/**
 * The command card's `Runs in:` row names the directory as the rest of the CLI does ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md)
 * §8: project-relative or from `~`, never absolute unless it is outside both), shortened FIRST and only then made safe for the terminal and
 * bounded to the row, keeping its end. The card is a consent path: the answer to "where does this run" must stay true, so a directory outside
 * both roots is drawn whole, and a card that is not given the roots draws the host's path as it always did.
 */
const ROOTS = { cwd: '/work/project', home: '/home/me' } as const;

const facts = (cwd: string): CommandCardFacts => ({
  standing: 'not-pre-approved',
  runsCode: false,
  protectedPath: false,
  cwd,
  offers: { session: true, remember: true },
});

const CASES = [
  ['inside the project', '/work/project/packages/app', 'Runs in: packages/app'],
  // The project itself names its folder: a resumed chat's project is the session's own directory, which is not always the one the person launched from.
  ['the project itself', '/work/project', 'Runs in: . (project root: project)'],
  ['inside the home, outside the project', '/home/me/other', 'Runs in: ~/other'],
  ['elsewhere', '/opt/shared/tools', 'Runs in: /opt/shared/tools'],
] as const;

describe('the command card’s directory', () => {
  it.each(CASES)('reads, %s, as a person names it', (_name, cwd, row) => {
    expect(commandFactRows(facts(cwd), 78, false, ROOTS)).toEqual([
      `Standing: not pre-approved · ${row}`,
    ]);
  });

  it('shortens BEFORE it makes the text safe: a control character inside the project’s own name does not forge a project-relative path', () => {
    // `/work/pro<BEL>ject/x` is not inside `/work/project`: cleaning it first would shorten it to `x` and say it runs in the project.
    const rows = commandFactRows(facts('/work/pro\u0007ject/x'), 78, false, ROOTS);
    expect(rows[0]).toContain('Runs in: /work/project/x');
    expect(rows[0]).not.toContain('Runs in: x');
  });

  it.each([
    ['BEL', '\u0007'],
    ['an SGR reset', '\u001b[0m'],
    ['NUL', '\u0000'],
    ['a right-to-left override', '\u202e'],
    ['a left-to-right mark', '\u200e'],
  ])('never lets %s in front of a `~` folder of the project read as the home', (_name, junk) => {
    // The folder `<project>/<junk>~/x` is cleaned to `~/x`, which a person reads as their home: it keeps its `./`.
    const rows = commandFactRows(facts(`/work/project/${junk}~/x`), 78, false, ROOTS);
    expect(rows[0]).toContain('Runs in: ./~/x');
    expect(rows[0]).not.toMatch(/Runs in: ~/u);
  });

  it('keeps the home form of a directory that really is in the home', () => {
    expect(commandFactRows(facts('/home/me/~bob'), 78, false, ROOTS)[0]).toContain(
      'Runs in: ~/~bob',
    );
  });

  it('names the project folder in the words, bounded to the row, and plain words when the root has no name', () => {
    const named = commandFactRows(facts('/work/project'), 78, false, ROOTS)[0] ?? '';
    expect(named).toBe('Standing: not pre-approved · Runs in: . (project root: project)');
    // A folder name is stored text: made safe, and cut at the front so the phrase still fits the room.
    const long = { cwd: `/work/${'a-long-folder-name-'.repeat(6)}end`, home: '/home/me' };
    for (const columns of [62, 78]) {
      const row = commandFactRows(facts(long.cwd), columns, false, long).join('\n');
      expect(row, row).toContain('. (project root: …');
      expect(row.endsWith('end)'), row).toBe(true);
      for (const line of row.split('\n'))
        expect(displayWidth(line), line).toBeLessThanOrEqual(columns);
    }
    const dirty = { cwd: '/work/pro\u0007je\u001b[31mct', home: '/home/me' };
    expect(commandFactRows(facts(dirty.cwd), 78, false, dirty)[0]).toContain(
      'Runs in: . (project root: project)',
    );
  });

  it('calls an empty directory the workspace, and draws neither it nor the standing while the reason box is open', () => {
    expect(commandFactRows(facts(''), 78, false, ROOTS)).toEqual([
      'Standing: not pre-approved · Runs in: (the workspace)',
    ]);
    expect(commandFactRows(facts(''), 78, false, undefined)[0]).toContain(
      'Runs in: (the workspace)',
    );
    // Compact: the plain rows give way (the box is for typing) and the warnings stay.
    expect(commandFactRows(facts('/work/project'), 78, true, ROOTS)).toEqual([]);
    const warned = { ...facts('/work/project'), runsCode: true, protectedPath: true };
    const compact = commandFactRows(warned, 78, true, ROOTS);
    expect(compact).toHaveLength(2);
    expect(compact.join('\n')).not.toContain('Standing');
    expect(compact.join('\n')).not.toContain('Runs in');
  });

  it('puts the directory on the standing row only while it has room for 24 columns, and on its own row below', () => {
    const cwd = `/opt/${'very-long-directory/'.repeat(4)}service/src`;
    // `Standing: not pre-approved` (26) + ` · ` (3) + `Runs in: ` (9) leave `columns - 38`.
    const atLeast = commandFactRows(facts(cwd), 62, false, ROOTS);
    expect(atLeast, 'room 24: one row').toHaveLength(1);
    expect(atLeast[0]?.startsWith('Standing: not pre-approved · Runs in: …')).toBe(true);
    const below = commandFactRows(facts(cwd), 61, false, ROOTS);
    expect(below, 'room 23: two rows').toHaveLength(2);
    expect(below[0]).toBe('Standing: not pre-approved');
    expect(below[1]?.startsWith('Runs in: …')).toBe(true);
    for (const row of [...atLeast, ...below])
      expect(displayWidth(row), row).toBeLessThanOrEqual(62);
    // The second row has the card's whole width to itself, but never less than eight columns.
    expect(displayWidth(below[1] ?? '')).toBe(61);
    const narrow = commandFactRows(facts(cwd), 12, false, ROOTS);
    expect(displayWidth(narrow[1] ?? ''), narrow[1]).toBe(9 + 8);
  });

  it('keeps the host’s own path when it is given no roots', () => {
    expect(commandFactRows(facts('/work/project'), 78, false, undefined)).toEqual([
      'Standing: not pre-approved · Runs in: /work/project',
    ]);
    expect(commandFactRows(facts('/work/project'))).toEqual([
      'Standing: not pre-approved · Runs in: /work/project',
    ]);
  });

  it('shortens first, then makes the text safe: a control sequence in the directory is gone and the shortening still applied', () => {
    const rows = commandFactRows(facts('/work/project/a\u001b[31mb\u0007c'), 78, false, ROOTS);
    expect(rows[0]).toContain('Runs in: abc');
    expect(rows[0]).not.toContain('/work/project');
    expect(rows[0]).not.toContain('\u001b');
  });

  it('bounds a long directory to the row after shortening it, keeping its end (here, the directory outside both roots)', () => {
    const cwd = `/opt/${'very-long-directory/'.repeat(8)}service/src`;
    for (const columns of [40, 78]) {
      const rows = commandFactRows(facts(cwd), columns, false, ROOTS);
      for (const row of rows) expect(displayWidth(row), row).toBeLessThanOrEqual(columns);
      const last = rows.at(-1) ?? '';
      expect(last.includes('…'), last).toBe(true);
      expect(last.endsWith('service/src'), last).toBe(true);
    }
  });

  it('draws the project’s own subdirectory in the room a long absolute path took, in the same rows', () => {
    const cwd = '/Users/someone/Documents/Projects/organisation/product/packages/service/src';
    const roots = {
      cwd: '/Users/someone/Documents/Projects/organisation/product',
      home: '/Users/someone',
    };
    const withRoots = commandFactRows(facts(cwd), 78, false, roots);
    const without = commandFactRows(facts(cwd), 78, false, undefined);
    expect(withRoots).toEqual(['Standing: not pre-approved · Runs in: packages/service/src']);
    expect(withRoots.length, 'never taller than the absolute form').toBeLessThanOrEqual(
      without.length,
    );
  });

  it('is the same words on the card, the full view and the chrome that budgets them', () => {
    const input = {
      document: undefined,
      shortenedTarget: false,
      targetHiddenBytes: 0,
      inspected: true,
      changesNotShown: 0,
      columns: 78,
      commandFacts: facts('/work/project/packages/app'),
      paths: ROOTS,
    };
    expect(cardWarnings(input)).toEqual(['Standing: not pre-approved · Runs in: packages/app']);
    expect(
      fullWarnings({
        kind: 'approval',
        document: undefined,
        pending: { target: false, masks: 0 },
        columns: 80,
        commandFacts: input.commandFacts,
        paths: ROOTS,
      })[0],
    ).toBe('Standing: not pre-approved · Runs in: packages/app');
    const chrome = fullChrome({
      kind: 'approval',
      title: 'Review',
      columns: 80,
      document: undefined,
      identity: [],
      hasTarget: false,
      pending: { target: false, masks: 0 },
      nav: { hasChanges: false, hasMasks: false, canCopy: false, revealed: false, numeric: false },
      keys: undefined,
      searching: false,
      commandFacts: input.commandFacts,
      paths: ROOTS,
    });
    expect(chrome.warnings[0]).toBe('Standing: not pre-approved · Runs in: packages/app');
  });
});
