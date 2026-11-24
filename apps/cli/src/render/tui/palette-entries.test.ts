import { describe, expect, it } from 'vitest';

import { type PaletteSurface } from '../../commands/repl-commands.js';
import {
  buildPaletteEntries,
  filterPaletteEntries,
  firstEnabledIndex,
  isExactNameMatch,
  lastEnabledIndex,
  type PaletteEntry,
} from './palette-entries.js';

/**
 * The palette's rows (ADR-0145 §7, MVP-11 Step 2.2): the registry's order with the availability the host read, the first row the key
 * lands on, the keyless lead, and the typed query's ranking.
 */
const names = (entries: readonly PaletteEntry[]): string[] =>
  entries.map((entry) => entry.command.name);
const groupStarts = (entries: readonly PaletteEntry[]): string[] =>
  entries.filter((entry) => entry.groupStart).map((entry) => entry.command.name);

const HOME = { hasSession: false, hasKey: true, hasSavedSessions: true, turnRunning: false };
const CHAT = { hasSession: true, hasKey: true, turnRunning: false };

describe('buildPaletteEntries: the registry’s order, with what each row can do now', () => {
  it('lists 15, 20 and 21 entries in the surfaces’ order, with a group start where a group begins', () => {
    const home = buildPaletteEntries('home', HOME);
    expect(names(home)).toEqual([
      'resume', 'run', 'workflows', 'agents',
      'providers', 'models', 'mode', 'permissions', 'pricing', 'init', 'import',
      'doctor', 'help',
      'clear', 'exit',
    ]); // prettier-ignore
    expect(groupStarts(home), 'Work, Set up, Check, End').toEqual([
      'resume',
      'providers',
      'doctor',
      'clear',
    ]);

    const chat = buildPaletteEntries('chat', CHAT);
    expect(chat).toHaveLength(20);
    expect(groupStarts(chat), 'Model, Context, Inspect, Take away, End').toEqual([
      'models',
      'trim',
      'cost',
      'copy',
      'clear',
    ]);

    const homeChat = buildPaletteEntries('home-chat', CHAT);
    expect(homeChat).toHaveLength(21);
    expect(groupStarts(homeChat)).toEqual(['models', 'trim', 'cost', 'copy', 'resume']);
  });

  it('carries the surface’s own words and group on each entry', () => {
    const byName = (surface: PaletteSurface, name: string): PaletteEntry | undefined =>
      buildPaletteEntries(surface, HOME).find((entry) => entry.command.name === name);
    expect(byName('home', 'exit')?.description).toBe('Leave Relavium.');
    expect(byName('chat', 'exit')?.description).toBe('End the chat session.');
    expect(byName('home-chat', 'exit')?.description).toBe(
      'Leave this chat and go back to the Home.',
    );
    expect(byName('home', 'exit')?.group).toBe('end');
    expect(byName('chat', 'doctor')?.group).toBe('inspect');
    expect(byName('home', 'doctor')?.group).toBe('check');
  });

  it('marks /clear dim with its reason on the bare Home, and enabled in a chat', () => {
    const clear = buildPaletteEntries('home', HOME).find((entry) => entry.command.name === 'clear');
    expect(clear?.enabled).toBe(false);
    expect(clear?.reason).toBe('no conversation to clear');
    for (const surface of ['chat', 'home-chat'] as const) {
      const row = buildPaletteEntries(surface, CHAT).find(
        (entry) => entry.command.name === 'clear',
      );
      expect(row?.enabled, surface).toBe(true);
      expect(row, `${surface}: an enabled row carries no reason`).not.toHaveProperty('reason');
    }
  });

  it('marks /resume dim when there is nothing to resume, and reads an unknown fact as enabled', () => {
    const resume = (hasSavedSessions: boolean | undefined) =>
      buildPaletteEntries('home', { ...HOME, hasSavedSessions }).find(
        (entry) => entry.command.name === 'resume',
      );
    expect(resume(false)?.enabled).toBe(false);
    expect(resume(false)?.reason).toBe('nothing to resume');
    expect(resume(true)?.enabled).toBe(true);
    expect(resume(undefined)?.enabled, 'the snapshot has not said').toBe(true);
    // The chat the Home hosts does not know the saved sessions (its snapshot may predate this Home's chats): unknown ⇒ enabled.
    expect(
      buildPaletteEntries('home-chat', CHAT).find((entry) => entry.command.name === 'resume')
        ?.enabled,
    ).toBe(true);
  });

  it('puts /providers FIRST on the Home with no key, as a group of its own, and changes nothing else', () => {
    const keyless = buildPaletteEntries('home', { ...HOME, hasKey: false });
    expect(keyless).toHaveLength(15);
    expect(names(keyless)[0]).toBe('providers');
    expect(new Set(names(keyless)).size, 'no row is listed twice').toBe(15);
    expect(names(keyless).slice(1)).toEqual(
      names(buildPaletteEntries('home', HOME)).filter((name) => name !== 'providers'),
    );
    expect(keyless[0]?.groupStart).toBe(true);
    // The lead is a group: Work starts again after it, and Set up starts again after Work.
    expect(groupStarts(keyless)).toEqual(['providers', 'resume', 'models', 'doctor', 'clear']);
    // A key present, or unknown, leaves the Home's own order.
    expect(names(buildPaletteEntries('home', { ...HOME, hasKey: true }))[0]).toBe('resume');
    expect(names(buildPaletteEntries('home', { ...HOME, hasKey: undefined }))[0]).toBe('resume');
    // The lead is the Home's: a chat has no /providers, with a key or without one.
    expect(names(buildPaletteEntries('chat', { ...CHAT, hasKey: false }))[0]).toBe('models');
  });

  it('ignores a surface inside the context: the surface is the argument', () => {
    const entries = buildPaletteEntries('chat', { ...CHAT, surface: 'home' });
    expect(entries).toHaveLength(20);
  });
});

describe('the row `/` then `Enter` lands on is never destructive and never ends the session (ADR-0145 §7.2)', () => {
  const CONTEXTS: readonly (readonly [string, PaletteSurface, Parameters<typeof buildPaletteEntries>[1], string])[] = [
    ['the Home with a saved session', 'home', HOME, 'resume'],
    ['the Home with none', 'home', { ...HOME, hasSavedSessions: false }, 'run'],
    ['the Home before its snapshot is read', 'home', { ...HOME, hasSavedSessions: undefined }, 'resume'],
    ['the keyless Home', 'home', { ...HOME, hasKey: false }, 'providers'],
    ['a stand-alone chat', 'chat', CHAT, 'models'],
    ['the chat the Home hosts', 'home-chat', CHAT, 'models'],
  ]; // prettier-ignore

  it.each(CONTEXTS)('%s: the default row', (_name, surface, ctx, expected) => {
    const entries = buildPaletteEntries(surface, ctx);
    const row = entries[firstEnabledIndex(entries)];
    expect(row?.command.name).toBe(expected);
    expect(row?.enabled).toBe(true);
    expect(row?.command.effect).not.toBe('destructive');
    expect(['exit', 'cancel', 'clear']).not.toContain(row?.command.name);
  });

  it('is never one of those, whatever the cached facts', () => {
    for (const surface of ['home', 'chat', 'home-chat'] as const)
      for (const hasKey of [true, false, undefined])
        for (const hasSavedSessions of [true, false, undefined]) {
          const entries = buildPaletteEntries(surface, {
            hasSession: surface !== 'home',
            hasKey,
            hasSavedSessions,
          });
          const row = entries[firstEnabledIndex(entries)];
          expect(
            ['exit', 'cancel', 'clear'],
            `${surface} ${String(hasKey)} ${String(hasSavedSessions)}`,
          ).not.toContain(row?.command.name);
          expect(row?.command.effect).not.toBe('destructive');
        }
  });

  it('finds the first and the last row that can act, and 0 when none can', () => {
    const entries = buildPaletteEntries('home', { ...HOME, hasSavedSessions: false });
    expect(firstEnabledIndex(entries)).toBe(1);
    expect(lastEnabledIndex(entries), '/clear is dim, /exit is last').toBe(entries.length - 1);
    expect(firstEnabledIndex([])).toBe(0);
    expect(lastEnabledIndex([])).toBe(0);
    const dim = entries.filter((entry) => !entry.enabled);
    expect(firstEnabledIndex(dim)).toBe(0);
    expect(lastEnabledIndex(dim)).toBe(0);
  });
});

describe('filterPaletteEntries ranks a typed query (ADR-0145 §7.6)', () => {
  const chat = buildPaletteEntries('chat', CHAT);
  const home = buildPaletteEntries('home', HOME);

  it('leaves an empty or blank query as the list it is, groups and all', () => {
    expect(filterPaletteEntries(chat, '')).toBe(chat);
    expect(filterPaletteEntries(chat, '   ')).toBe(chat);
  });

  it('keeps the tiers: the name that is the query, names that start with it, names that hold it, descriptions that hold it', () => {
    // Home: `agent` is the name of nothing; `agents` starts with it and `/init` holds it in its description ("agent directories").
    expect(names(filterPaletteEntries(home, 'agent'))).toEqual(['agents', 'init']);
    // In a chat `agent` is a name, and `/workflows` (whose words hold "agents") follows it.
    expect(names(filterPaletteEntries(chat, 'agent'))).toEqual(['agent', 'workflows']);
    expect(names(filterPaletteEntries(chat, 'copy'))[0]).toBe('copy');
    expect(names(filterPaletteEntries(chat, 'MODE'))[0], 'case-insensitive').toBe('mode');
    expect(names(filterPaletteEntries(chat, '  mode '))[0], 'whitespace around it is ignored').toBe(
      'mode',
    );
  });

  it('searches a name or the description the row shows, and nothing else', () => {
    expect(names(filterPaletteEntries(chat, 'zzzzz'))).toEqual([]);
    expect(names(filterPaletteEntries(chat, 'osc 52'))).toEqual(['copy']);
    // The label ("Tool details") is not shown, so it is not searched.
    expect(names(filterPaletteEntries(chat, 'tool details'))).toEqual([]);
  });

  it('puts the commands that end a session or spend tokens after the others of the same tier', () => {
    // `c` starts cost, copy, compact, clear and cancel (a name tier), and nothing else of a chat.
    expect(names(filterPaletteEntries(chat, 'c')).slice(0, 5)).toEqual([
      'cost',
      'copy',
      'compact',
      'clear',
      'cancel',
    ]);
    // `e` is a prefix of effort, export, edit and exit: /exit comes last of them.
    const e = names(filterPaletteEntries(chat, 'e'));
    expect(e.slice(0, 4)).toEqual(['effort', 'export', 'edit', 'exit']);
    // Only inside a tier: a name that is the query still leads, even when it is one of the four.
    expect(names(filterPaletteEntries(chat, 'exit'))[0]).toBe('exit');
    expect(names(filterPaletteEntries(chat, 'clear'))[0]).toBe('clear');
    expect(names(filterPaletteEntries(chat, 'compact'))[0]).toBe('compact');
  });

  it('is the one ranking the Home’s Enter reads: every name is the first answer to itself', () => {
    for (const entries of [home, chat, buildPaletteEntries('home-chat', CHAT)])
      for (const entry of entries)
        expect(names(filterPaletteEntries(entries, entry.command.name))[0]).toBe(
          entry.command.name,
        );
  });

  it('starts no group in a ranked list: the gaps belong to the grouped list', () => {
    const ranked = filterPaletteEntries(home, 'e');
    expect(ranked.length).toBeGreaterThan(1);
    expect(ranked.some((entry) => entry.groupStart)).toBe(false);
    expect(
      home.some((entry) => entry.groupStart),
      'the source list is untouched',
    ).toBe(true);
  });

  it('keeps a dim row in the result, with its reason', () => {
    const [first] = filterPaletteEntries(home, 'clear');
    expect(first?.command.name).toBe('clear');
    expect(first?.enabled).toBe(false);
    expect(first?.reason).toBe('no conversation to clear');
  });

  it('names an exact match without regard to case or the whitespace around it', () => {
    const exit = home.find((entry) => entry.command.name === 'exit');
    expect(exit).toBeDefined();
    if (exit === undefined) return;
    expect(isExactNameMatch(exit, 'EXIT')).toBe(true);
    expect(isExactNameMatch(exit, ' exit ')).toBe(true);
    expect(isExactNameMatch(exit, 'exi')).toBe(false);
  });
});
