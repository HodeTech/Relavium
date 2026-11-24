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
  ['the project itself', '/work/project', 'Runs in: . (project root)'],
  ['inside the home, outside the project', '/home/me/other', 'Runs in: ~/other'],
  ['elsewhere', '/opt/shared/tools', 'Runs in: /opt/shared/tools'],
] as const;

describe('the command card’s directory', () => {
  it.each(CASES)('reads, %s, as a person names it', (_name, cwd, row) => {
    expect(commandFactRows(facts(cwd), 78, false, ROOTS)).toEqual([
      `Standing: not pre-approved · ${row}`,
    ]);
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
