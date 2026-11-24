import { describe, expect, it } from 'vitest';

import {
  CHAT_PALETTE_COMMANDS,
  HOME_CHAT_PALETTE_COMMANDS,
  HOME_PALETTE_COMMANDS,
  REPL_COMMANDS,
  type ReplCommand,
} from '../../commands/repl-commands.js';
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
const cmd = (name: string, description: string): ReplCommand => ({
  name,
  label: name,
  description,
  effect: 'read',
  run: noop,
  availableIn: ['home', 'chat'],
});
const FIXTURE: readonly ReplCommand[] = [
  cmd('alpha', 'the first command'),
  cmd('beta', 'mentions alpha in its text'),
  cmd('gamma', 'unrelated'),
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

/** The palettes the user can open, by the set of commands each one lists. */
const PALETTES: readonly (readonly [string, readonly ReplCommand[]])[] = [
  ['the bare Home', HOME_PALETTE_COMMANDS],
  ['a standalone chat', CHAT_PALETTE_COMMANDS],
  ['the chat inside the Home', HOME_CHAT_PALETTE_COMMANDS],
];

const hasName = (command: ReplCommand, q: string): boolean =>
  command.name.toLowerCase().includes(q);
const hasDescription = (command: ReplCommand, q: string): boolean =>
  command.description.toLowerCase().includes(q);

/**
 * The ranking written a second way, as a stable sort by tier over the list's own index (the implementation buckets): the name that equals
 * the query, the names that start with it, the names that contain it, the descriptions that contain it. A command that matches neither
 * its name nor its description is not in the result.
 */
function expectedOrder(commands: readonly ReplCommand[], query: string): readonly string[] {
  const q = query.trim().toLowerCase();
  const tier = (command: ReplCommand): number => {
    const name = command.name.toLowerCase();
    if (name === q) return 0;
    if (name.startsWith(q)) return 1;
    if (name.includes(q)) return 2;
    return 3;
  };
  return commands
    .map((command, index) => ({ command, index }))
    .filter(({ command }) => hasName(command, q) || hasDescription(command, q))
    .sort((a, b) => tier(a.command) - tier(b.command) || a.index - b.index)
    .map(({ command }) => command.name);
}

describe('filterPaletteCommands ranks the matches (the name the user typed comes first)', () => {
  const RANKED: readonly ReplCommand[] = [
    cmd('init', 'Set up the agent directories.'),
    cmd('subagent', 'A name that contains the query.'),
    cmd('agents', 'A name that starts with the query.'),
    cmd('agent', 'The name that is the query.'),
    cmd('agentic', 'Another name that starts with it.'),
    cmd('later', 'Its agent is only in the description.'),
    cmd('other', 'unrelated'),
  ];

  it('orders the name that equals the query, then names that start with it, names that contain it, then descriptions', () => {
    expect(filterPaletteCommands(RANKED, 'agent').map((c) => c.name)).toEqual([
      'agent',
      'agents',
      'agentic',
      'subagent',
      'init',
      'later',
    ]);
  });

  it('keeps the list order inside each group, ignores case and the whitespace around the query', () => {
    expect(filterPaletteCommands(RANKED, '  AGENT ').map((c) => c.name)).toEqual([
      'agent',
      'agents',
      'agentic',
      'subagent',
      'init',
      'later',
    ]);
    // Two names that start with the query keep their list order, and a name that equals it jumps ahead of both.
    expect(
      filterPaletteCommands([cmd('ab', ''), cmd('abc', ''), cmd('a', '')], 'a').map((c) => c.name),
    ).toEqual(['a', 'ab', 'abc']);
  });

  it('changes only the order: the same commands match as under a plain name-or-description substring test', () => {
    for (const query of ['agent', 'age', 'a', 'e', 'unrelated', 'zzz', 'its']) {
      const q = query.toLowerCase();
      const plain = RANKED.filter((c) => hasName(c, q) || hasDescription(c, q)).map((c) => c.name);
      expect(
        filterPaletteCommands(RANKED, query)
          .map((c) => c.name)
          .sort(),
        `the matches of ${JSON.stringify(query)}`,
      ).toEqual([...plain].sort());
    }
  });

  it.each(PALETTES)(
    'typing a command`s whole name puts that command first, for every command of %s',
    (_where, commands) => {
      for (const command of commands)
        expect(
          filterPaletteCommands(commands, command.name)[0]?.name,
          `/${command.name} typed in full`,
        ).toBe(command.name);
    },
  );

  it.each(PALETTES)(
    'every query a person types on the way (each prefix, each letter) ranks as the rule says, on %s',
    (_where, commands) => {
      const queries = new Set<string>('abcdefghijklmnopqrstuvwxyz');
      for (const command of commands)
        for (let length = 1; length <= command.name.length; length += 1)
          queries.add(command.name.slice(0, length));
      for (const query of queries)
        expect(
          filterPaletteCommands(commands, query).map((c) => c.name),
          `the ranking of ${JSON.stringify(query)}`,
        ).toEqual(expectedOrder(commands, query));
    },
  );

  it.each(PALETTES)(
    'a word that is not a command here (agent, copy, help) puts a name match first, or nothing, on %s',
    (_where, commands) => {
      for (const word of ['agent', 'copy', 'help']) {
        const found = filterPaletteCommands(commands, word);
        const first = found[0];
        if (commands.some((c) => hasName(c, word)))
          expect(first !== undefined && hasName(first, word), `/${word}: a name leads`).toBe(true);
        else if (first !== undefined)
          expect(hasDescription(first, word), `/${word}: only descriptions match`).toBe(true);
        // Whatever leads, it is a command that matches: nothing is ever offered that the plain test would not.
        for (const command of found)
          expect(hasName(command, word) || hasDescription(command, word)).toBe(true);
      }
    },
  );

  it('on the Home, `agent` is `/agents` and not `/init` (whose description names "agent directories"); in a chat it is `/agent`', () => {
    expect(filterPaletteCommands(HOME_PALETTE_COMMANDS, 'agent')[0]?.name).toBe('agents');
    expect(filterPaletteCommands(HOME_PALETTE_COMMANDS, 'agent').map((c) => c.name)).toContain(
      'init',
    );
    expect(filterPaletteCommands(CHAT_PALETTE_COMMANDS, 'agent')[0]?.name).toBe('agent');
    expect(filterPaletteCommands(CHAT_PALETTE_COMMANDS, 'copy')[0]?.name).toBe('copy');
    // `/help` is the palette itself, never an entry; no command here carries the word at all.
    for (const [, commands] of PALETTES)
      expect(commands.some((command) => command.name === 'help')).toBe(false);
  });

  it('typed key by key and confirmed with Return, the palette runs the command whose name was typed', () => {
    for (const [where, commands] of PALETTES)
      for (const command of commands) {
        let state = INITIAL_PALETTE_STATE;
        for (const char of command.name) {
          const step = foldPaletteKey(char, {}, state, commands);
          if (step.kind !== 'state') throw new Error('a printable key did not extend the query');
          state = step.state;
        }
        const run = foldPaletteKey('', { return: true }, state, commands);
        expect(run.kind === 'run' && run.command?.name, `/${command.name} on ${where}`).toBe(
          command.name,
        );
      }
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

  it('move re-clamps against the FILTERED count (query "ex" ⇒ exit, export, mode, compact)', () => {
    // Names match exit/export; descriptions match mode's explicit save and compact's context.
    const down = stepPalette({ query: 'ex', index: 0 }, { kind: 'move', delta: 1 }, REPL_COMMANDS);
    expect(down).toEqual({ kind: 'state', state: { query: 'ex', index: 1 } });
    const past = stepPalette({ query: 'ex', index: 3 }, { kind: 'move', delta: 1 }, REPL_COMMANDS);
    expect(past).toEqual({ kind: 'state', state: { query: 'ex', index: 3 } }); // clamped at the last row
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
