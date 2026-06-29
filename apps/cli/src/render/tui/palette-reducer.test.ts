import { describe, expect, it } from 'vitest';

import { REPL_COMMANDS, type ReplCommand } from '../../commands/repl-commands.js';
import {
  clampIndex,
  filterPaletteCommands,
  foldPaletteKey,
  INITIAL_PALETTE_STATE,
  reducePaletteKey,
  shouldOpenPalette,
  stepPalette,
} from './palette-reducer.js';

/** A small fixture so the filter tests are independent of the live command set (robust to S4 additions). */
const noop = (): void => undefined;
const FIXTURE: readonly ReplCommand[] = [
  { name: 'alpha', label: 'Alpha', description: 'the first command', effect: 'read', run: noop },
  {
    name: 'beta',
    label: 'Beta',
    description: 'mentions alpha in its text',
    effect: 'read',
    run: noop,
  },
  { name: 'gamma', label: 'Gamma', description: 'unrelated', effect: 'read', run: noop },
];

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
  it('returns everything for an empty / whitespace query', () => {
    expect(filterPaletteCommands(FIXTURE, '')).toEqual(FIXTURE);
    expect(filterPaletteCommands(FIXTURE, '   ')).toEqual(FIXTURE);
  });

  it('substring-matches the NAME or the DESCRIPTION (the shown fields), case-insensitively', () => {
    // `alpha` is the name of one command AND appears in another's description → both match (matches what's shown).
    expect(filterPaletteCommands(FIXTURE, 'ALPHA').map((c) => c.name)).toEqual(['alpha', 'beta']);
    expect(filterPaletteCommands(FIXTURE, 'gam').map((c) => c.name)).toEqual(['gamma']);
    expect(filterPaletteCommands(FIXTURE, 'unrelated').map((c) => c.name)).toEqual(['gamma']);
    expect(filterPaletteCommands(FIXTURE, 'zzz')).toEqual([]);
  });
});

describe('shouldOpenPalette', () => {
  it('opens on a literal "/" at an idle empty prompt only', () => {
    expect(shouldOpenPalette('/', {}, false, 0)).toBe(true);
    expect(shouldOpenPalette('/', {}, true, 0)).toBe(false); // mid-turn
    expect(shouldOpenPalette('/', {}, false, 3)).toBe(false); // buffer not empty (a mid-message slash)
    expect(shouldOpenPalette('/', { ctrl: true }, false, 0)).toBe(false); // a chord
    expect(shouldOpenPalette('a', {}, false, 0)).toBe(false); // not a slash
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

describe('foldPaletteKey (the shared both-surface fold)', () => {
  it('Ctrl-C closes the palette (the always-escapes hatch — never trapping)', () => {
    expect(foldPaletteKey('c', { ctrl: true }, INITIAL_PALETTE_STATE, REPL_COMMANDS)).toEqual({
      kind: 'close',
    });
  });

  it('otherwise delegates to reducePaletteKey + stepPalette (a printable extends the query, Enter runs)', () => {
    expect(foldPaletteKey('e', {}, INITIAL_PALETTE_STATE, REPL_COMMANDS)).toEqual({
      kind: 'state',
      state: { query: 'e', index: 0 },
    });
    const run = foldPaletteKey('', { return: true }, { query: 'exit', index: 0 }, REPL_COMMANDS);
    expect(run.kind === 'run' && run.command?.name).toBe('exit');
    expect(foldPaletteKey('', { escape: true }, INITIAL_PALETTE_STATE, REPL_COMMANDS)).toEqual({
      kind: 'close',
    });
  });
});
