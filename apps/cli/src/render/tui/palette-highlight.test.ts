import { describe, expect, it } from 'vitest';

import {
  commandsOf,
  type AvailabilityContext,
  type PaletteSurface,
} from '../../commands/repl-commands.js';
import {
  bestMatchIndex,
  buildPaletteEntries,
  filterPaletteEntries,
  NO_HIGHLIGHT,
  type PaletteContext,
  type PaletteEntry,
} from './palette-entries.js';
import { foldPaletteKey, openPalette, type OpenPalette } from './palette-reducer.js';

/**
 * A query that matches a command only through its DESCRIPTION never highlights a command that ends a session, spends tokens or drops
 * messages (MVP-11 Step 2 review round 2, A2). The highlight fell back to the first ending row whenever every row that could act was one of
 * them, so `/res` in a stand-alone chat landed on `/clear` and `Enter` ran it, `/su` landed on `/compact` (which spends tokens), `/hom` on
 * `/exit` and `/ini` on `/trim` (which drops the older messages, and was not in the ending set). A new file.
 */
const SURFACES: readonly PaletteSurface[] = ['home', 'standalone-chat', 'home-chat'];
/** Every state a host builds the rows from, per surface: with and without a key, saved conversations and a running turn. */
const CONTEXTS: Readonly<Record<PaletteSurface, readonly PaletteContext[]>> = {
  home: [
    { hasSession: false, hasKey: true, hasSavedSessions: true, turnRunning: false },
    { hasSession: false, hasKey: true, hasSavedSessions: false, turnRunning: false },
    { hasSession: false, hasKey: false, hasSavedSessions: false, turnRunning: false },
  ],
  'standalone-chat': [
    { hasSession: true, hasKey: true, turnRunning: false },
    { hasSession: true, hasKey: true, turnRunning: true },
  ],
  'home-chat': [
    { hasSession: true, hasKey: true, turnRunning: false },
    { hasSession: true, hasKey: true, turnRunning: true },
  ],
};
/** The commands a query may land on only when it is the start of their name. */
const GUARDED: ReadonlySet<string> = new Set(['clear', 'cancel', 'compact', 'exit', 'trim']);
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/** Every one to three letter query. */
function shortQueries(): string[] {
  const queries: string[] = [];
  for (const a of LETTERS) {
    queries.push(a);
    for (const b of LETTERS) {
      queries.push(a + b);
      for (const c of LETTERS) queries.push(a + b + c);
    }
  }
  return queries;
}

/** Every prefix of every word the registry and the Home offer: a command name, and each word of a shown description, on every surface. */
function wordPrefixes(): Set<string> {
  const prefixes = new Set<string>();
  const add = (word: string): void => {
    const lower = word.toLowerCase().replace(/[^a-z0-9-]/gu, '');
    for (let end = 1; end <= lower.length; end += 1) prefixes.add(lower.slice(0, end));
  };
  for (const surface of SURFACES) {
    for (const command of commandsOf(surface)) add(command.name);
    for (const ctx of CONTEXTS[surface])
      for (const entry of buildPaletteEntries(surface, ctx))
        for (const word of entry.description.split(/\s+/u)) add(word);
  }
  return prefixes;
}

const nameOf = (rows: readonly PaletteEntry[], index: number): string | undefined =>
  rows[index]?.command.name;

/** Every (surface, state, query) whose highlight is a guarded row for a query that is not the start of its name. */
function violations(queries: Iterable<string>): string[] {
  const found: string[] = [];
  for (const query of queries) {
    for (const surface of SURFACES) {
      for (const ctx of CONTEXTS[surface]) {
        const rows = filterPaletteEntries(buildPaletteEntries(surface, ctx), query);
        const name = nameOf(rows, bestMatchIndex(rows, query));
        if (name !== undefined && GUARDED.has(name) && !name.startsWith(query))
          found.push(`${surface} ${JSON.stringify(ctx)} /${query} -> /${name}`);
      }
    }
  }
  return found;
}

describe('the highlight of a typed query (A2)', () => {
  it('no query of one to three letters highlights an ending or spending row it does not start the name of', () => {
    expect(violations(shortQueries())).toEqual([]);
  });

  it('no prefix of any command name or description word does either', () => {
    expect(violations(wordPrefixes())).toEqual([]);
  });

  it('the enumeration is not vacuous: description-only matches exist, and they highlight nothing', () => {
    let descriptionOnly = 0;
    for (const query of [...shortQueries(), ...wordPrefixes()]) {
      for (const surface of SURFACES) {
        for (const ctx of CONTEXTS[surface]) {
          const rows = filterPaletteEntries(buildPaletteEntries(surface, ctx), query);
          if (
            rows.length > 0 &&
            rows.every((row) => !row.command.name.includes(query)) &&
            bestMatchIndex(rows, query) === NO_HIGHLIGHT
          )
            descriptionOnly += 1;
        }
      }
    }
    expect(
      descriptionOnly,
      'queries that reach rows through their description only',
    ).toBeGreaterThan(100);
  });

  // The queries of the review, one by one, on the surfaces where each landed on an ending row.
  describe.each([
    ['a stand-alone chat: /res reached /clear', 'standalone-chat', ['res', 'resu', 'resum']],
    [
      'both chats: /sta, /sav and /fr reached /clear',
      'standalone-chat',
      ['sta', 'start', 'sav', 'save', 'fr', 'fre', 'fres', 'fresh'],
    ],
    [
      'the Home-hosted chat: the same words',
      'home-chat',
      ['sta', 'start', 'sav', 'save', 'fr', 'fre', 'fres', 'fresh'],
    ],
    [
      'both chats: /su and /end reached /compact, which spends tokens',
      'standalone-chat',
      ['su', 'sum', 'summ', 'summa', 'summar', 'summari', 'end'],
    ],
    [
      'the Home-hosted chat: /su and /end reached /compact',
      'home-chat',
      ['su', 'sum', 'summ', 'summa', 'summar', 'summari', 'end'],
    ],
    [
      'the Home-hosted chat: /hom and /go reached /exit',
      'home-chat',
      ['hom', 'home', 'leav', 'leave', 'go'],
    ],
    ['the bare Home: /rel reached /exit', 'home', ['rel']],
    [
      'a chat: /ini and /sa reached /trim, which drops the older messages',
      'standalone-chat',
      ['ini', 'sa'],
    ],
    ['the Home-hosted chat: /ini and /sa reached /trim', 'home-chat', ['ini', 'sa']],
  ] as const)('%s', (_why, surface, queries) => {
    it.each(queries)('/%s highlights no ending, spending or dropping row', (query) => {
      const ctx = CONTEXTS[surface][0] ?? {};
      const rows = filterPaletteEntries(buildPaletteEntries(surface, ctx), query);
      const name = nameOf(rows, bestMatchIndex(rows, query));
      expect(name === undefined || !GUARDED.has(name), `${surface} /${query} -> ${name}`).toBe(
        true,
      );
    });
  });

  it('answers NO_HIGHLIGHT, and Enter then answers as it does for a query that matches nothing: a run with no command', () => {
    const entries = buildPaletteEntries('standalone-chat', { hasSession: true, hasKey: true });
    let palette: OpenPalette = openPalette(entries, 'up');
    for (const char of 'res') {
      const step = foldPaletteKey(char, {}, palette);
      if (step.kind !== 'state') throw new Error('the palette closed while typing');
      palette = step.palette;
    }
    expect(palette.state.index).toBe(NO_HIGHLIGHT);
    expect(palette.list.rows.length, 'a row still matches the description').toBeGreaterThan(0);
    expect(foldPaletteKey('', { return: true }, palette)).toEqual({
      kind: 'run',
      command: undefined,
    });
  });

  it('still highlights an ending row for the start of its name, and an exact name wins', () => {
    const chat = buildPaletteEntries('standalone-chat', { hasSession: true, hasKey: true });
    for (const [query, name] of [
      ['clear', 'clear'],
      ['tri', 'trim'],
      ['trim', 'trim'],
      ['can', 'cancel'],
      ['exi', 'exit'],
    ] as const) {
      const rows = filterPaletteEntries(chat, query);
      expect(nameOf(rows, bestMatchIndex(rows, query)), `/${query}`).toBe(name);
    }
  });

  it('prefers a safe row that can act to any ending one, as before', () => {
    const chat = buildPaletteEntries('standalone-chat', { hasSession: true, hasKey: true });
    for (const query of ['e', 'ex', 'c', 'co', 't']) {
      const rows = filterPaletteEntries(chat, query);
      const name = nameOf(rows, bestMatchIndex(rows, query));
      expect(name !== undefined && !GUARDED.has(name), `/${query} -> ${name}`).toBe(true);
    }
  });

  it('keeps the explanation of a dim row for an exact name and when nothing can act', () => {
    const home = buildPaletteEntries('home', {
      hasSession: false,
      hasKey: true,
      hasSavedSessions: false,
    });
    const rows = filterPaletteEntries(home, 'resume');
    expect(rows[bestMatchIndex(rows, 'resume')]?.enabled, 'the dim /resume explains itself').toBe(
      false,
    );
    const none = filterPaletteEntries(home, 'zzz');
    expect(bestMatchIndex(none, 'zzz'), 'no rows: the index stays 0').toBe(0);
  });

  it('is not defined over the context type alone: every availability field a host passes is one the rows read', () => {
    const context: Partial<AvailabilityContext> = CONTEXTS.home[0] ?? {};
    expect(Object.keys(context).sort()).toEqual(
      ['hasKey', 'hasSavedSessions', 'hasSession', 'turnRunning'].sort(),
    );
  });
});
