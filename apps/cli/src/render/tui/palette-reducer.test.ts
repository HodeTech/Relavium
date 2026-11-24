import { describe, expect, it } from 'vitest';

import { type PaletteSurface, type ReplCommand } from '../../commands/repl-commands.js';
import {
  buildPaletteEntries,
  filterPaletteEntries,
  firstEnabledIndex,
  type PaletteEntry,
} from './palette-entries.js';
import {
  clampIndex,
  foldPaletteKey,
  openPalette,
  reducePaletteKey,
  shouldOpenPalette,
  stepPalette,
  type OpenPalette,
  type PaletteLayout,
  type PaletteStep,
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
const entry = (
  name: string,
  description: string,
  over: Partial<Pick<PaletteEntry, 'enabled' | 'reason' | 'groupStart'>> = {},
): PaletteEntry => ({
  command: cmd(name, description),
  description,
  group: 'work',
  groupStart: false,
  enabled: true,
  ...over,
});
const dim = (name: string, reason = 'not now'): PaletteEntry =>
  entry(name, `the ${name} command`, { enabled: false, reason });

const names = (entries: readonly PaletteEntry[]): string[] =>
  entries.map((item) => item.command.name);

/** Tests for the pure `/` command-palette reducer (2.5.C S3b; the rows, the layout and the dim rows are MVP-11 Step 2.2) — no ink. */
describe('reducePaletteKey', () => {
  it('maps keys to palette actions: on the Home ↓ is the next entry', () => {
    expect(reducePaletteKey('', { escape: true })).toEqual({ kind: 'cancel' });
    expect(reducePaletteKey('', { return: true })).toEqual({ kind: 'select' });
    expect(reducePaletteKey('', { upArrow: true })).toEqual({ kind: 'move', delta: -1 });
    expect(reducePaletteKey('', { downArrow: true })).toEqual({ kind: 'move', delta: 1 });
    expect(reducePaletteKey('', { backspace: true })).toEqual({ kind: 'backspace' });
    expect(reducePaletteKey('e', {})).toEqual({ kind: 'append', char: 'e' });
    expect(reducePaletteKey('c', { ctrl: true })).toEqual({ kind: 'none' }); // a chord is not query text
  });

  it('in a chat the keys follow the screen: the list is drawn bottom-up, so ↑ is the next entry and ↓ the previous', () => {
    expect(reducePaletteKey('', { upArrow: true }, 'up')).toEqual({ kind: 'move', delta: 1 });
    expect(reducePaletteKey('', { downArrow: true }, 'up')).toEqual({ kind: 'move', delta: -1 });
    // The layout only turns the arrows: every other key means what it meant.
    expect(reducePaletteKey('', { return: true }, 'up')).toEqual({ kind: 'select' });
    expect(reducePaletteKey('x', {}, 'up')).toEqual({ kind: 'append', char: 'x' });
  });

  it('maps Home and End (Ink exposes both) to the first and the last entry of the LIST, whichever way it is drawn', () => {
    for (const layout of ['down', 'up'] as const) {
      expect(reducePaletteKey('', { home: true }, layout)).toEqual({ kind: 'jump', to: 'first' });
      expect(reducePaletteKey('', { end: true }, layout)).toEqual({ kind: 'jump', to: 'last' });
    }
  });
});

describe('filterPaletteEntries', () => {
  const FIXTURE: readonly PaletteEntry[] = [
    entry('alpha', 'the first command'),
    entry('beta', 'mentions alpha in its text'),
    entry('gamma', 'unrelated'),
  ];

  it('returns everything for an empty / whitespace query', () => {
    expect(filterPaletteEntries(FIXTURE, '')).toEqual(FIXTURE);
    expect(filterPaletteEntries(FIXTURE, '   ')).toEqual(FIXTURE);
  });

  it('substring-matches the NAME or the DESCRIPTION (the shown fields), case-insensitively', () => {
    // `alpha` is the name of one command AND appears in another's description → both match (matches what's shown).
    expect(names(filterPaletteEntries(FIXTURE, 'ALPHA'))).toEqual(['alpha', 'beta']);
    expect(names(filterPaletteEntries(FIXTURE, 'gam'))).toEqual(['gamma']);
    expect(names(filterPaletteEntries(FIXTURE, 'unrelated'))).toEqual(['gamma']);
    expect(filterPaletteEntries(FIXTURE, 'zzz')).toEqual([]);
  });
});

/** The palettes the user can open, by the rows each one lists (the cached facts of a Home with a saved session, and of a live chat). */
const PALETTES: readonly (readonly [string, PaletteSurface, readonly PaletteEntry[]])[] = [
  [
    'the bare Home',
    'home',
    buildPaletteEntries('home', { hasSession: false, hasKey: true, hasSavedSessions: true }),
  ],
  ['a standalone chat', 'chat', buildPaletteEntries('chat', { hasSession: true, hasKey: true })],
  [
    'the chat inside the Home',
    'home-chat',
    buildPaletteEntries('home-chat', { hasSession: true, hasKey: true }),
  ],
];

const hasName = (item: PaletteEntry, q: string): boolean =>
  item.command.name.toLowerCase().includes(q);
const hasDescription = (item: PaletteEntry, q: string): boolean =>
  item.description.toLowerCase().includes(q);

/** The commands that end a session or spend tokens (ADR-0145 §7.6): inside a tier they come after the others. */
const LAST = new Set(['clear', 'cancel', 'compact', 'exit']);

/**
 * The ranking written a second way, as a stable sort over the list's own index (the implementation buckets): the tier (the name that equals
 * the query, the names that start with it, the names that contain it, the descriptions that contain it), then the commands that end a
 * session or spend tokens after the others, then the list order. A command that matches neither its name nor its description is not in
 * the result.
 */
function expectedOrder(entries: readonly PaletteEntry[], query: string): readonly string[] {
  const q = query.trim().toLowerCase();
  const tier = (item: PaletteEntry): number => {
    const name = item.command.name.toLowerCase();
    if (name === q) return 0;
    if (name.startsWith(q)) return 1;
    if (name.includes(q)) return 2;
    return 3;
  };
  return entries
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => hasName(item, q) || hasDescription(item, q))
    .sort(
      (a, b) =>
        tier(a.item) - tier(b.item) ||
        Number(LAST.has(a.item.command.name)) - Number(LAST.has(b.item.command.name)) ||
        a.index - b.index,
    )
    .map(({ item }) => item.command.name);
}

describe('filterPaletteEntries ranks the matches (the name the user typed comes first)', () => {
  const RANKED: readonly PaletteEntry[] = [
    entry('init', 'Set up the agent directories.'),
    entry('subagent', 'A name that contains the query.'),
    entry('agents', 'A name that starts with the query.'),
    entry('agent', 'The name that is the query.'),
    entry('agentic', 'Another name that starts with it.'),
    entry('later', 'Its agent is only in the description.'),
    entry('other', 'unrelated'),
  ];

  it('orders the name that equals the query, then names that start with it, names that contain it, then descriptions', () => {
    expect(names(filterPaletteEntries(RANKED, 'agent'))).toEqual([
      'agent',
      'agents',
      'agentic',
      'subagent',
      'init',
      'later',
    ]);
  });

  it('keeps the list order inside each group, ignores case and the whitespace around the query', () => {
    expect(names(filterPaletteEntries(RANKED, '  AGENT '))).toEqual([
      'agent',
      'agents',
      'agentic',
      'subagent',
      'init',
      'later',
    ]);
    // Two names that start with the query keep their list order, and a name that equals it jumps ahead of both.
    expect(
      names(filterPaletteEntries([entry('ab', ''), entry('abc', ''), entry('a', '')], 'a')),
    ).toEqual(['a', 'ab', 'abc']);
  });

  it('puts a command that ends a session or spends tokens after the others of its tier, and never ahead of its own exact name', () => {
    const tier = [
      entry('exit', 'x'),
      entry('export', 'x'),
      entry('clear', 'x'),
      entry('cancel', 'x'),
      entry('compact', 'x'),
      entry('cost', 'x'),
      entry('copy', 'x'),
    ];
    // `c` starts five of them: the three that end or spend come last, in their own order.
    expect(names(filterPaletteEntries(tier, 'c'))).toEqual([
      'cost',
      'copy',
      'clear',
      'cancel',
      'compact',
    ]);
    // `ex` starts exit and export: /exit follows /export though it is declared first.
    expect(names(filterPaletteEntries(tier, 'ex'))).toEqual(['export', 'exit']);
    // The name that IS the query is tier 0 and leads whoever it is.
    expect(names(filterPaletteEntries(tier, 'exit'))[0]).toBe('exit');
    expect(names(filterPaletteEntries(tier, 'clear'))[0]).toBe('clear');
  });

  it('changes only the order: the same commands match as under a plain name-or-description substring test', () => {
    for (const query of ['agent', 'age', 'a', 'e', 'unrelated', 'zzz', 'its']) {
      const q = query.toLowerCase();
      const plain = RANKED.filter((c) => hasName(c, q) || hasDescription(c, q)).map(
        (c) => c.command.name,
      );
      expect(
        names(filterPaletteEntries(RANKED, query)).sort(),
        `the matches of ${JSON.stringify(query)}`,
      ).toEqual([...plain].sort());
    }
  });

  it.each(PALETTES)(
    'typing a command`s whole name puts that command first, for every command of %s',
    (_where, _surface, entries) => {
      for (const item of entries)
        expect(
          filterPaletteEntries(entries, item.command.name)[0]?.command.name,
          `/${item.command.name} typed in full`,
        ).toBe(item.command.name);
    },
  );

  it.each(PALETTES)(
    'every query a person types on the way (each prefix, each letter) ranks as the rule says, on %s',
    (_where, _surface, entries) => {
      const queries = new Set<string>('abcdefghijklmnopqrstuvwxyz');
      for (const item of entries)
        for (let length = 1; length <= item.command.name.length; length += 1)
          queries.add(item.command.name.slice(0, length));
      for (const query of queries)
        expect(
          names(filterPaletteEntries(entries, query)),
          `the ranking of ${JSON.stringify(query)}`,
        ).toEqual(expectedOrder(entries, query));
    },
  );

  it.each(PALETTES)(
    'a word that is not a command here (agent, copy, help) puts a name match first, or nothing, on %s',
    (_where, _surface, entries) => {
      for (const word of ['agent', 'copy', 'help']) {
        const found = filterPaletteEntries(entries, word);
        const first = found[0];
        if (entries.some((c) => hasName(c, word)))
          expect(first !== undefined && hasName(first, word), `/${word}: a name leads`).toBe(true);
        else if (first !== undefined)
          expect(hasDescription(first, word), `/${word}: only descriptions match`).toBe(true);
        // Whatever leads, it is a command that matches: nothing is ever offered that the plain test would not.
        for (const item of found)
          expect(hasName(item, word) || hasDescription(item, word)).toBe(true);
      }
    },
  );

  it('on the Home, `agent` is `/agents` and not `/init` (whose description names "agent directories"); in a chat it is `/agent`', () => {
    const [, , home] = PALETTES[0] ?? [];
    const [, , chat] = PALETTES[1] ?? [];
    expect(filterPaletteEntries(home ?? [], 'agent')[0]?.command.name).toBe('agents');
    expect(names(filterPaletteEntries(home ?? [], 'agent'))).toContain('init');
    expect(filterPaletteEntries(chat ?? [], 'agent')[0]?.command.name).toBe('agent');
    expect(filterPaletteEntries(chat ?? [], 'copy')[0]?.command.name).toBe('copy');
  });

  it('lists /help in every palette (ADR-0145 §7.3): the keys that only /help lists are otherwise undiscoverable', () => {
    for (const [, , entries] of PALETTES) expect(names(entries)).toContain('help');
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

/** Open a palette over `entries` (`down` unless said): ONE value, its state and the rows it reads. */
function opened(entries: readonly PaletteEntry[], layout: PaletteLayout = 'down'): OpenPalette {
  return openPalette(entries, layout);
}

/** Fold a key and require the palette to stay open with new state. */
function press(
  palette: OpenPalette,
  char: string,
  key: Parameters<typeof foldPaletteKey>[1] = {},
): OpenPalette {
  const step = foldPaletteKey(char, key, palette);
  if (step.kind !== 'state') throw new Error(`expected the palette to stay open, got ${step.kind}`);
  return step.palette;
}

const highlighted = (palette: OpenPalette): string | undefined =>
  palette.list.rows[palette.state.index]?.command.name;

describe('openPalette: the highlight starts on the first row that can act, never on row 0 by default', () => {
  it('opens on the first entry when it can act', () => {
    const { state, list } = opened([entry('a', 'x'), entry('b', 'y')]);
    expect(state).toEqual({ query: '', index: 0 });
    expect(list.rows).toBe(list.entries);
  });

  it('skips the dim rows at the head: the index is the first ENABLED entry', () => {
    const { state } = opened([dim('a'), dim('b'), entry('c', 'z'), entry('d', 'w')]);
    expect(state).toEqual({ query: '', index: 2 });
  });

  it('opens on row 0 when nothing can act (a dim row only explains itself)', () => {
    expect(opened([dim('a'), dim('b')]).state.index).toBe(0);
    expect(opened([]).state.index).toBe(0);
  });

  it('stores the layout the list runs in', () => {
    expect(opened([entry('a', 'x')], 'up').list.layout).toBe('up');
    expect(opened([entry('a', 'x')]).list.layout).toBe('down');
  });

  it.each([
    ['the Home with a saved session', 'home', true, 'resume'],
    ['the Home with none', 'home', false, 'run'],
  ] as const)(
    '%s: `/` then Enter runs the first row that can act and never leaves the application',
    (_n, surface, saved, expected) => {
      const entries = buildPaletteEntries(surface, {
        hasSession: false,
        hasKey: true,
        hasSavedSessions: saved,
      });
      const step = foldPaletteKey('', { return: true }, opened(entries, 'down'));
      expect(step.kind === 'run' && step.command?.name).toBe(expected);
    },
  );

  it('a keyless Home: `/` then Enter runs /providers', () => {
    const entries = buildPaletteEntries('home', {
      hasSession: false,
      hasKey: false,
      hasSavedSessions: true,
    });
    const step = foldPaletteKey('', { return: true }, opened(entries, 'down'));
    expect(step.kind === 'run' && step.command?.name).toBe('providers');
  });

  it('a chat: `/` then Enter runs /models', () => {
    for (const surface of ['chat', 'home-chat'] as const) {
      const step = foldPaletteKey(
        '',
        { return: true },
        opened(buildPaletteEntries(surface, { hasSession: true, hasKey: true }), 'up'),
      );
      expect(step.kind === 'run' && step.command?.name, surface).toBe('models');
    }
  });
});

describe('stepPalette', () => {
  const LIST: readonly PaletteEntry[] = [
    entry('exit', 'ends it'),
    entry('export', 'writes it'),
    entry('mode', 'sets the mode, explicitly saved'),
    entry('compact', 'summarises the context'),
  ];

  it('append extends the query and puts the highlight on the first row of the new list that can act', () => {
    const { state, list } = opened([dim('exa'), entry('exb', 'x'), entry('zzz', 'y')]);
    const step = stepPalette(
      { state: { query: 'e', index: 2 }, list },
      { kind: 'append', char: 'x' },
    );
    expect(step.kind).toBe('state');
    if (step.kind !== 'state') return;
    expect(step.palette.state).toEqual({ query: 'ex', index: 1 }); // `exa` is dim, `exb` is the first that can act
    expect(names(step.palette.list.rows)).toEqual(['exa', 'exb']);
    expect(state.index).toBe(1);
  });

  it('builds the rows ONCE per edit: the new list is what the view draws and what the next key reads', () => {
    const { list } = opened(LIST);
    const step = stepPalette(
      { state: { query: '', index: 0 }, list },
      { kind: 'append', char: 'e' },
    );
    if (step.kind !== 'state') throw new Error('stay open');
    expect(step.palette.list.rows).toEqual(filterPaletteEntries(LIST, 'e'));
    expect(step.palette.list.entries, 'the base entries are the same array').toBe(list.entries);
    expect(step.palette.list.layout).toBe(list.layout);
    // A key that edits nothing keeps the very same palette.
    const none = stepPalette(step.palette, { kind: 'none' });
    expect(none.kind === 'state' && none.palette).toBe(step.palette);
  });

  it('backspace shortens the query and puts the highlight on the first row that can act', () => {
    const { list } = opened(LIST);
    const typed = stepPalette(
      { state: { query: 'e', index: 0 }, list },
      { kind: 'append', char: 'x' },
    );
    if (typed.kind !== 'state') throw new Error('stay open');
    const step = stepPalette(
      { state: { query: 'ex', index: 1 }, list: typed.palette.list },
      { kind: 'backspace' },
    );
    expect(step.kind === 'state' && step.palette.state).toEqual({ query: 'e', index: 0 });
  });

  it('a typed EXACT NAME that is dim stays highlighted, so Enter says why instead of running what else matched', () => {
    const { list } = opened([
      dim('clear', 'no conversation to clear'),
      entry('pricing', 'Set or clear a price'),
    ]);
    let at: OpenPalette = { state: { query: '', index: 1 }, list };
    for (const char of 'clear') at = press(at, char);
    expect(names(at.list.rows)).toEqual(['clear', 'pricing']);
    expect(at.state, 'the dim exact name is highlighted').toEqual({ query: 'clear', index: 0 });
    expect(foldPaletteKey('', { return: true }, at)).toEqual({
      kind: 'unavailable',
      reason: 'no conversation to clear',
    });
    // A dim row that is only a PREFIX of what was typed is not an exact name: the highlight goes to the first row that can act.
    let prefix: OpenPalette = { state: { query: '', index: 1 }, list };
    for (const char of 'cle') prefix = press(prefix, char);
    expect(prefix.state.index).toBe(1);
    expect(highlighted(prefix)).toBe('pricing');
  });

  describe('a short query never highlights a command that ends a session or spends tokens while another row can act (ADR-0145 §7.6)', () => {
    const END_OR_SPEND = new Set(['clear', 'cancel', 'compact', 'exit']);
    /** Type `query` into a palette opened over the live registry and read the highlighted row's name. */
    function typed(surface: PaletteSurface, query: string): string | undefined {
      const entries = buildPaletteEntries(surface, {
        hasSession: surface !== 'home',
        hasKey: true,
        hasSavedSessions: true,
      });
      let at = opened(entries, surface === 'home' ? 'down' : 'up');
      for (const char of query) at = press(at, char);
      return highlighted(at);
    }

    it.each([
      ['home', 'e'],
      ['home', 'ex'],
      ['chat', 'e'],
      ['chat', 'ex'],
      ['chat', 'cl'],
      ['chat', 'co'],
      ['home-chat', 'e'],
      ['home-chat', 'ex'],
      ['home-chat', 'cl'],
    ] as const)('%s: /%s lands on a row that does neither', (surface, query) => {
      const name = typed(surface, query);
      expect(name).toBeDefined();
      expect(END_OR_SPEND.has(name ?? ''), `${surface} /${query} highlighted /${name}`).toBe(false);
    });

    it.each([
      ['home', 'exit'],
      ['chat', 'exit'],
      ['chat', 'clear'],
      ['chat', 'cancel'],
      ['chat', 'compact'],
      ['home-chat', 'clear'],
    ] as const)('%s: the exact name /%s still wins', (surface, query) => {
      expect(typed(surface, query)).toBe(query);
    });

    it('when every row that can act is one of them, the first of those is highlighted', () => {
      expect(typed('chat', 'can'), 'only /cancel matches').toBe('cancel');
      expect(
        typed('chat', 'res'),
        'a stand-alone chat has no /resume: /clear and /cancel are all there is',
      ).toBe('clear');
      expect(typed('home', 'exi'), 'only /exit matches').toBe('exit');
    });

    /** Type `query` into a palette over `list` and read the highlighted row's name. */
    function typedOver(list: readonly PaletteEntry[], query: string): string | undefined {
      let at = opened(list);
      for (const char of query) at = press(at, char);
      return highlighted(at);
    }

    it('prefers a row of a lower tier to an end row of a higher one: /exit by name, /close only by its description', () => {
      const list = [entry('exit', 'ends it'), entry('close', 'the exit door')];
      expect(names(filterPaletteEntries(list, 'exi'))).toEqual(['exit', 'close']);
      expect(typedOver(list, 'exi')).toBe('close');
      expect(typedOver(list, 'exit'), 'the whole name is the exact name').toBe('exit');
    });

    it('with a dim row ahead of the only end row that can act, the highlight is that end row and not the dim one', () => {
      const list = [dim('clearly'), entry('clear', 'wipes the screen')];
      expect(names(filterPaletteEntries(list, 'cl'))).toEqual(['clearly', 'clear']);
      expect(typedOver(list, 'cl')).toBe('clear');
    });

    it('a dim row that is not an end row does not take the highlight from the first row that can act', () => {
      const list = [dim('later'), entry('exit', 'ends it'), entry('else', 'something else')];
      expect(typedOver(list, 'e')).toBe('else');
    });
  });

  describe('move: arrows skip the dim rows and stop at both ends (no wrap-around)', () => {
    const ENTRIES = [
      entry('a', 'x'),
      dim('b'),
      dim('c'),
      entry('d', 'y'),
      dim('e'),
      entry('f', 'z'),
    ];

    it('moves to the next row that can act, in both directions', () => {
      const { list } = opened(ENTRIES);
      const next = (index: number, delta: number) => {
        const step = stepPalette({ state: { query: '', index }, list }, { kind: 'move', delta });
        return step.kind === 'state' ? step.palette.state.index : -1;
      };
      expect(next(0, 1), 'a → d, over b and c').toBe(3);
      expect(next(3, 1), 'd → f, over e').toBe(5);
      expect(next(5, -1), 'f → d').toBe(3);
      expect(next(3, -1), 'd → a').toBe(0);
    });

    it('clamps at the ends: there is no wrap-around', () => {
      const { list } = opened(ENTRIES);
      const at = (index: number, delta: number) => {
        const step = stepPalette({ state: { query: '', index }, list }, { kind: 'move', delta });
        return step.kind === 'state' ? step.palette.state.index : -1;
      };
      expect(at(5, 1), 'past the last row').toBe(5);
      expect(at(0, -1), 'before the first row').toBe(0);
    });

    it('stays put when nothing after it can act (a dim tail)', () => {
      const { list } = opened([entry('a', 'x'), dim('b'), dim('c')]);
      const step = stepPalette(
        { state: { query: '', index: 0 }, list },
        { kind: 'move', delta: 1 },
      );
      expect(step.kind === 'state' && step.palette.state.index).toBe(0);
    });

    it('keeps the query, and the list, as they were', () => {
      const { list } = opened(ENTRIES);
      const step = stepPalette(
        { state: { query: 'q', index: 0 }, list },
        { kind: 'move', delta: 1 },
      );
      expect(step.kind === 'state' && step.palette.state.query).toBe('q');
      expect(step.kind === 'state' && step.palette.list).toBe(list);
    });
  });

  describe('jump: Home and End go to the first and the last row that can act', () => {
    it('lands on enabled rows only', () => {
      const { list } = opened([dim('a'), entry('b', 'x'), entry('c', 'y'), dim('d')]);
      const to = (where: 'first' | 'last') => {
        const step = stepPalette(
          { state: { query: '', index: 2 }, list },
          { kind: 'jump', to: where },
        );
        return step.kind === 'state' ? step.palette.state.index : -1;
      };
      expect(to('first')).toBe(1);
      expect(to('last')).toBe(2);
    });

    it('through the key: End reaches /exit, the last row of every list, and Home the first row that can act', () => {
      for (const [where, surface, entries] of PALETTES) {
        const layout = surface === 'home' ? 'down' : 'up';
        const palette = opened(entries, layout);
        const end = press(palette, '', { end: true });
        expect(highlighted(end), where).toBe('exit');
        const home = press(end, '', { home: true });
        expect(home.state.index, where).toBe(firstEnabledIndex(palette.list.rows));
      }
    });
  });

  describe('layout up: the arrow keys follow the screen', () => {
    it('↑ is the next entry and ↓ the previous; the first entry is the one beside the prompt', () => {
      const palette = opened([entry('one', 'a'), entry('two', 'b'), entry('three', 'c')], 'up');
      expect(highlighted(palette)).toBe('one');
      const up = press(palette, '', { upArrow: true });
      expect(highlighted(up)).toBe('two');
      const upAgain = press(up, '', { upArrow: true });
      expect(highlighted(upAgain)).toBe('three');
      const down = press(upAgain, '', { downArrow: true });
      expect(highlighted(down)).toBe('two');
    });

    it('does not move past the first entry with ↓, nor past the last with ↑ (no wrap-around)', () => {
      const palette = opened([entry('one', 'a'), entry('two', 'b')], 'up');
      expect(press(palette, '', { downArrow: true }).state.index).toBe(0);
      const top = press(palette, '', { upArrow: true });
      expect(press(top, '', { upArrow: true }).state.index).toBe(1);
    });

    it('skips a dim row in either direction', () => {
      const palette = opened([entry('one', 'a'), dim('two'), entry('three', 'c')], 'up');
      const up = press(palette, '', { upArrow: true });
      expect(highlighted(up)).toBe('three');
      const down = press(up, '', { downArrow: true });
      expect(highlighted(down)).toBe('one');
    });
  });

  describe('select', () => {
    it('reads the highlighted row of the FILTERED list', () => {
      const { list } = opened(LIST);
      const typed = stepPalette(
        { state: { query: '', index: 0 }, list },
        { kind: 'append', char: 'e' },
      );
      if (typed.kind !== 'state') throw new Error('stay open');
      const first = stepPalette(
        { state: { query: 'e', index: 0 }, list: typed.palette.list },
        { kind: 'select' },
      );
      expect(first.kind === 'run' && first.command?.name).toBe('export'); // `exit` ends a session: it follows `export`
      const second = stepPalette(
        { state: { query: 'e', index: 1 }, list: typed.palette.list },
        { kind: 'select' },
      );
      expect(second.kind === 'run' && second.command?.name).toBe('exit');
    });

    it('on a dim row says why and runs nothing', () => {
      const { list } = opened([dim('clear', 'no conversation to clear'), entry('exit', 'ends')]);
      expect(stepPalette({ state: { query: '', index: 0 }, list }, { kind: 'select' })).toEqual({
        kind: 'unavailable',
        reason: 'no conversation to clear',
      });
    });

    it('on an empty filter yields run with no command (a no-op the caller closes on)', () => {
      const { list } = opened(LIST);
      const typed = stepPalette(
        { state: { query: '', index: 0 }, list },
        { kind: 'append', char: 'z' },
      );
      if (typed.kind !== 'state') throw new Error('stay open');
      expect(
        stepPalette(
          { state: { query: 'z', index: 0 }, list: typed.palette.list },
          { kind: 'select' },
        ),
      ).toEqual({
        kind: 'run',
        command: undefined,
      });
    });
  });

  it('cancel closes', () => {
    expect(stepPalette(opened(LIST), { kind: 'cancel' })).toEqual({ kind: 'close' });
  });
});

describe('foldPaletteKey (the shared both-surface fold)', () => {
  const palette = opened([entry('exit', 'ends it'), entry('export', 'writes it')]);

  it('Ctrl-C closes the palette (the always-escapes hatch — never trapping)', () => {
    expect(foldPaletteKey('c', { ctrl: true }, palette)).toEqual({ kind: 'close' });
  });

  it('otherwise delegates to reducePaletteKey + stepPalette (a printable extends the query, Enter runs)', () => {
    const typed = foldPaletteKey('e', {}, palette);
    expect(typed.kind === 'state' && typed.palette.state).toEqual({ query: 'e', index: 0 });
    const run = foldPaletteKey(
      '',
      { return: true },
      { state: { query: 'exit', index: 0 }, list: palette.list },
    );
    expect(run.kind === 'run' && run.command?.name).toBe('exit');
    expect(foldPaletteKey('', { escape: true }, palette)).toEqual({ kind: 'close' });
  });

  it('typed key by key and confirmed with Return, the palette runs the command whose name was typed', () => {
    for (const [where, surface, entries] of PALETTES)
      for (const item of entries) {
        let at = opened(entries, surface === 'home' ? 'down' : 'up');
        for (const char of item.command.name) at = press(at, char);
        const run: PaletteStep = foldPaletteKey('', { return: true }, at);
        // A dim row (`/clear` on the Home) is the exact name typed too: Enter on it says why, and never runs another command.
        expect(
          run.kind === 'run' ? run.command?.name : run.kind,
          `/${item.command.name} on ${where}`,
        ).toBe(item.enabled ? item.command.name : 'unavailable');
      }
  });

  it('walks to /exit and stops there: ↓ on the Home and ↑ in a chat, many more times than the list is long, never wrap to the top', () => {
    for (const [where, surface, entries] of PALETTES) {
      const layout = surface === 'home' ? 'down' : 'up';
      const key = layout === 'down' ? { downArrow: true } : { upArrow: true };
      let at = opened(entries, layout);
      let reached = -1;
      for (let step = 0; step < entries.length + 10; step += 1) {
        at = press(at, '', key);
        if (highlighted(at) === 'exit' && reached < 0) reached = step;
      }
      expect(highlighted(at), `${where}: still on /exit after extra presses`).toBe('exit');
      expect(reached, `${where}: /exit is reached`).toBeGreaterThan(0);
      // Only the explicit selection of /exit runs it.
      const run = foldPaletteKey('', { return: true }, at);
      expect(run.kind === 'run' && run.command?.name, where).toBe('exit');
    }
  });
});
