import { describe, expect, it } from 'vitest';

import { REPL_COMMANDS } from '../../commands/repl-commands.js';
import {
  clampIndex,
  filterPaletteCommands,
  INITIAL_PALETTE_STATE,
  reducePaletteKey,
  stepPalette,
} from './palette-reducer.js';

/** Tests for the pure `/` command-palette reducer (2.5.C S3b) — filter / navigate / select, no ink. */
describe('reducePaletteKey', () => {
  it('maps keys to palette actions', () => {
    expect(reducePaletteKey('', { escape: true })).toEqual({ kind: 'cancel' });
    expect(reducePaletteKey('', { return: true })).toEqual({ kind: 'select' });
    expect(reducePaletteKey('', { upArrow: true })).toEqual({ kind: 'move', delta: -1 });
    expect(reducePaletteKey('', { downArrow: true })).toEqual({ kind: 'move', delta: 1 });
    expect(reducePaletteKey('', { backspace: true })).toEqual({ kind: 'backspace' });
    expect(reducePaletteKey('e', {})).toEqual({ kind: 'append', char: 'e' });
    expect(reducePaletteKey('c', { ctrl: true })).toEqual({ kind: 'none' }); // a chord is not query text
  });
});

describe('filterPaletteCommands', () => {
  it('returns everything for an empty query', () => {
    expect(filterPaletteCommands(REPL_COMMANDS, '')).toEqual(REPL_COMMANDS);
    expect(filterPaletteCommands(REPL_COMMANDS, '   ')).toEqual(REPL_COMMANDS);
  });

  it('substring-matches name or label, case-insensitively', () => {
    expect(filterPaletteCommands(REPL_COMMANDS, 'ex').map((c) => c.name)).toEqual([
      'exit',
      'export',
    ]);
    expect(filterPaletteCommands(REPL_COMMANDS, 'CANCEL').map((c) => c.name)).toEqual(['cancel']);
    expect(filterPaletteCommands(REPL_COMMANDS, 'zzz')).toEqual([]);
  });
});

describe('clampIndex', () => {
  it('clamps into [0, count-1], or 0 when empty', () => {
    expect(clampIndex(5, 3)).toBe(2);
    expect(clampIndex(-1, 3)).toBe(0);
    expect(clampIndex(0, 0)).toBe(0);
  });
});

describe('stepPalette', () => {
  it('append extends the query and resets the highlight to the top', () => {
    const step = stepPalette(
      { query: 'e', index: 2 },
      { kind: 'append', char: 'x' },
      REPL_COMMANDS,
    );
    expect(step).toEqual({ kind: 'state', state: { query: 'ex', index: 0 } });
  });

  it('backspace shortens the query and resets the highlight', () => {
    const step = stepPalette({ query: 'ex', index: 1 }, { kind: 'backspace' }, REPL_COMMANDS);
    expect(step).toEqual({ kind: 'state', state: { query: 'e', index: 0 } });
  });

  it('move re-clamps against the FILTERED count (query "ex" ⇒ 2 rows)', () => {
    const down = stepPalette({ query: 'ex', index: 0 }, { kind: 'move', delta: 1 }, REPL_COMMANDS);
    expect(down).toEqual({ kind: 'state', state: { query: 'ex', index: 1 } });
    const past = stepPalette({ query: 'ex', index: 1 }, { kind: 'move', delta: 1 }, REPL_COMMANDS);
    expect(past).toEqual({ kind: 'state', state: { query: 'ex', index: 1 } }); // clamped at the last row
  });

  it('select reads the highlighted FILTERED command', () => {
    const exit = stepPalette({ query: 'ex', index: 0 }, { kind: 'select' }, REPL_COMMANDS);
    expect(exit.kind === 'run' && exit.command?.name).toBe('exit');
    const exportCmd = stepPalette({ query: 'ex', index: 1 }, { kind: 'select' }, REPL_COMMANDS);
    expect(exportCmd.kind === 'run' && exportCmd.command?.name).toBe('export');
  });

  it('select on an empty filter yields run with no command (a no-op the caller closes on)', () => {
    const step = stepPalette({ query: 'zzz', index: 0 }, { kind: 'select' }, REPL_COMMANDS);
    expect(step).toEqual({ kind: 'run', command: undefined });
  });

  it('cancel closes; the initial state highlights the first row of the full list', () => {
    expect(stepPalette(INITIAL_PALETTE_STATE, { kind: 'cancel' }, REPL_COMMANDS)).toEqual({
      kind: 'close',
    });
    expect(INITIAL_PALETTE_STATE).toEqual({ query: '', index: 0 });
  });
});
