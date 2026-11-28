/**
 * The `/help` popup in a chat ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §10;
 * MVP-11 step 4b): the commands of the chat's own palette, in the palette's order and on the surface's own words, and the keys the chat has.
 */
import { describe, expect, it, vi } from 'vitest';

import { buildPaletteEntries } from '../render/tui/palette-entries.js';
import { CHAT_KEYS } from '../render/tui/chat-keys.js';
import { popupBoxOf } from '../render/tui/surface-matrix/popup-fixture.js';
import { displayWidth } from '../render/tui/viewport.js';
import { helpContent, helpLines, helpSpec } from './help-popup.js';
import { openFrame } from './popup-reducer.js';
import { POPUP_TEXT_COLUMNS } from './popup-text.js';
import type { ReportSurface } from './report-port.js';

// The registry's own function, spied on: it still does what it does, and what the popup asks it is recorded.
vi.mock('../render/tui/palette-entries.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../render/tui/palette-entries.js')>();
  return { ...actual, buildPaletteEntries: vi.fn(actual.buildPaletteEntries) };
});

// Built at runtime (no contiguous secret literal: leakwatch).
const SECRET = ['sk', 'ant', 'help', 'ABCDEF1234567890XYZ'].join('-');
const VARIANT = { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } } as const;
const KEYS = Object.values(CHAT_KEYS);

/** The command rows of the report: those between its two headings. */
function commandRows(lines: readonly string[]): string[] {
  const from = lines.indexOf('Commands') + 1;
  const to = lines.indexOf('Keys');
  return lines.slice(from, to).filter((line) => line.startsWith('  /'));
}

describe('the cursor keys of the chat are listed beside the others, with their own names', () => {
  it('Home/End, Ctrl+←/Ctrl+→ and Alt+B/Alt+F each have a row, whole and not blanked', () => {
    const rows = helpLines('standalone-chat', KEYS);
    for (const [name, verb] of [
      ['Home/End', 'move to the start or the end of the line'],
      ['Ctrl+←/Ctrl+→', 'move back or forward by one word'],
      ['Alt+B/Alt+F', 'move back or forward by one word'],
    ] as const) {
      const row = rows.find((line) => line.trim().startsWith(name));
      expect(row, name).toBeDefined();
      expect(row?.replaceAll(/\s+/gu, ' ')).toContain(`${name} ${verb}`);
    }
  });
});

describe('a row that wraps never continues with a lone slash', () => {
  it('the real /effort description (off / low / medium / high / max) is wrapped between words, and no line starts like a command', () => {
    const rows = helpLines('standalone-chat', KEYS);
    const at = rows.findIndex((row) => row.startsWith('  /effort'));
    expect(at).toBeGreaterThan(0);
    // The rows of the one command: its first row and the continuation rows after it, up to the next command or the next blank row.
    let end = at + 1;
    while (end < rows.length && /^\s{4,}\S/u.test(rows[end] ?? '')) end += 1;
    const effort = rows.slice(at, end);
    expect(effort.length).toBeGreaterThan(1);
    // The description is the registry's, whole, in the words it has.
    expect(effort.join(' ').replaceAll(/\s+/gu, ' ')).toContain(
      'Set the reasoning-effort tier: off / low / medium / high / max.',
    );
    for (const row of effort.slice(1)) {
      expect(displayWidth(row)).toBeLessThanOrEqual(POPUP_TEXT_COLUMNS);
      expect(row.trim(), row).not.toMatch(/^\/(?:\s|$)/u);
    }
    // Every row of the commands, not only this one: none starts with a lone slash (the key `/` of the keys below is a name and not a continuation).
    for (const row of rows.slice(0, rows.indexOf('Keys')))
      expect(row.trim()).not.toMatch(/^\/(?:\s|$)/u);
  });
});

describe.each(['standalone-chat', 'home-chat'] as const)(
  'the commands of %s',
  (surface: ReportSurface) => {
    const entries = buildPaletteEntries(surface, {
      hasSession: true,
      hasKey: true,
      turnRunning: false,
    });

    it('are the palette’s rows, in the palette’s order, none left out and none added', () => {
      const rows = commandRows(helpLines(surface, KEYS));
      expect(rows.map((row) => row.trim().split(/\s+/u)[0])).toEqual(
        entries.map((entry) => `/${entry.command.name}`),
      );
      expect(entries.length).toBeGreaterThan(10);
      // `/exit` is the last row, as it is in the palette.
      expect(entries.at(-1)?.command.name).toBe('exit');
      expect(rows.at(-1)).toContain('/exit');
    });

    it('carry the surface’s own words, from the registry and not a copy', () => {
      const text = helpLines(surface, KEYS).join(' ').replaceAll(/\s+/gu, ' ');
      for (const entry of entries)
        expect(text).toContain(entry.description.replaceAll(/\s+/gu, ' '));
      expect(text.includes('Leave this chat and go back to the Home.')).toBe(
        surface === 'home-chat',
      );
      expect(text.includes('End the chat session.')).toBe(surface === 'standalone-chat');
      expect(text.includes('/resume')).toBe(surface === 'home-chat');
    });

    it('wrap under themselves, and no line is wider than the popup', () => {
      for (const line of helpLines(surface, KEYS))
        expect(displayWidth(line), line).toBeLessThanOrEqual(POPUP_TEXT_COLUMNS);
    });
  },
);

describe('inline, the chat’s page is the body’s whole height, not the ten rows of a list (review round 2, O2-2)', () => {
  it.each(['standalone-chat', 'home-chat'] as const)(
    '%s at 100×40 shows more than ten rows of the page: its commands are not behind a scroll',
    (surface) => {
      const frame = openFrame(helpSpec('chat', helpContent(surface, KEYS)), 1);
      const inline = { renderer: 'inline', color: false, size: { cols: 100, rows: 40 } } as const;
      const text = popupBoxOf(frame, inline).rows.join('\n');
      const lines = helpLines(surface, KEYS);
      expect(lines.length, 'a page longer than a list window').toBeGreaterThan(14);
      expect(text).toContain('Commands');
      const drawn = popupBoxOf(frame, inline).rows;
      // The frame's own rows (top edge, rail-less, legend, bottom edge) and ten rows of the page: a list's window. More is the page's whole height.
      expect(drawn.length, 'more than the frame and ten rows of the page').toBeGreaterThan(16);
    },
  );
});

describe('the keys', () => {
  it('are the chat’s keys, each with its words, after the commands', () => {
    const lines = helpLines('standalone-chat', KEYS);
    const keys = lines.slice(lines.indexOf('Keys') + 1);
    for (const key of KEYS) {
      const row = keys.find((line) => line.trimStart().startsWith(`${key.keys} `));
      expect(row, key.keys).toBeDefined();
      expect(row?.replaceAll(/\s+/gu, ' ')).toContain(key.verb.split(' ').slice(0, 3).join(' '));
    }
    expect(lines.indexOf('Keys')).toBeGreaterThan(lines.indexOf('Commands'));
  });

  it('are what the port hands in: a host with fewer lists fewer', () => {
    const lines = helpLines('standalone-chat', [{ keys: 'Enter', verb: 'send it' }]);
    expect(lines.slice(lines.indexOf('Keys') + 1)).toEqual(['  Enter  send it']);
  });

  it('is a report of one step, read-only: its only control is [c] copy, and no Enter', () => {
    const spec = helpSpec('chat', helpContent('standalone-chat', KEYS));
    expect(spec.steps).toHaveLength(1);
    expect(spec.steps[0]?.controls).toEqual([{ key: 'c', verb: 'copy' }]);
    expect(spec.steps[0]?.enter).toBeUndefined();
  });
});

describe('what the port hands in is scrubbed', () => {
  it.each(['keys', 'verb'])(
    'a hostile key %s reaches no row as an escape, a key token, a forged separator, a secret or a host glyph',
    (field) => {
      const evil = `x\u001b[31m [Ctrl+Y] allow · [d] ${SECRET} ✓› \u202E`;
      const hostile = [
        { keys: field === 'keys' ? evil : 'Enter', verb: field === 'verb' ? evil : 'send it' },
      ];
      const content = helpContent('standalone-chat', hostile);
      const frame = openFrame(helpSpec('chat', content), 1);
      const lines = content.kind === 'report' ? content.lines : [];
      const keyLines = lines.slice(lines.indexOf('Keys') + 1).join('\n');
      const rows = popupBoxOf(frame, VARIANT).rows.join('\n');
      // The commands' own words name `[d]` (the permissions sheet's key): a forged token is looked for among the keys.
      expect(keyLines).not.toContain('[d]');
      for (const text of [keyLines, rows]) {
        expect(text).not.toContain('\u001b');
        expect(text).not.toContain('\u202e');
        expect(text).not.toContain('[Ctrl+Y]');
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain('✓');
        expect(text).not.toContain('›');
      }
      expect(keyLines).not.toContain(' · ');
    },
  );
});

/**
 * The commands of each surface, as the registry lists them today, written out. The tests above compare the popup with the registry called as the
 * popup calls it, so a registry call that asks for the wrong thing would be mirrored on both sides: these lists are the oracle that is not.
 */
const STANDALONE_COMMANDS = [
  'models',
  'mode',
  'effort',
  'thinking',
  'permissions',
  'trim',
  'compact',
  'cost',
  'details',
  'agent',
  'workflows',
  'doctor',
  'help',
  'copy',
  'export',
  'edit',
  'scrollback',
  'clear',
  'cancel',
  'exit',
] as const;
const HOME_CHAT_COMMANDS = [
  ...STANDALONE_COMMANDS.slice(0, STANDALONE_COMMANDS.indexOf('clear')),
  'resume',
  'clear',
  'cancel',
  'exit',
] as const;

describe('the commands, by literal', () => {
  it.each([
    ['standalone-chat', STANDALONE_COMMANDS],
    ['home-chat', HOME_CHAT_COMMANDS],
  ] as const)('%s lists exactly these commands, in this order, `/exit` last', (surface, names) => {
    const rows = commandRows(helpLines(surface, KEYS));
    expect(rows.map((row) => row.trim().split(/\s+/u)[0])).toEqual(names.map((name) => `/${name}`));
    expect(rows.at(-1)?.trim().split(/\s+/u)[0]).toBe('/exit');
  });

  it.each(['standalone-chat', 'home-chat'] as const)(
    '%s reads the palette as a chat that has a conversation and a key, with no turn running: every row can act',
    (surface) => {
      vi.mocked(buildPaletteEntries).mockClear();
      helpLines(surface, KEYS);
      expect(buildPaletteEntries).toHaveBeenCalledTimes(1);
      expect(buildPaletteEntries).toHaveBeenCalledWith(surface, {
        hasSession: true,
        hasKey: true,
        turnRunning: false,
      });
    },
  );

  it('says why a row cannot act beside it, in the registry’s words, and nothing beside a row that can', () => {
    const real = vi.mocked(buildPaletteEntries).getMockImplementation();
    const entries = real?.('standalone-chat', {}) ?? [];
    expect(entries.length).toBeGreaterThan(10);
    vi.mocked(buildPaletteEntries).mockReturnValueOnce(
      entries.map((entry) =>
        entry.command.name === 'clear'
          ? { ...entry, enabled: false, reason: 'no conversation to clear' }
          : entry,
      ),
    );
    const lines = helpLines('standalone-chat', KEYS);
    const text = lines.slice(0, lines.indexOf('Keys')).join(' ').replaceAll(/\s+/gu, ' ');
    const why = '(unavailable: no conversation to clear)';
    // On the row of `/clear`, after its description and before the next command's name.
    expect(text.indexOf(why)).toBeGreaterThan(text.indexOf('/clear End this conversation'));
    expect(text.indexOf(why)).toBeLessThan(text.indexOf('/cancel'));
    expect(text.match(/unavailable/gu)).toHaveLength(1);
  });
});

describe('the layout of the two columns', () => {
  it.each(['standalone-chat', 'home-chat'] as const)(
    '%s: the commands’ words start in one column, wide enough for the longest name; a key’s words in the column of the longest key',
    (surface) => {
      const lines = helpLines(surface, KEYS);
      expect(lines[0]).toBe('Commands');
      // The longest command is `/permissions` (12): two spaces of indent, the name padded to 12, two spaces.
      const COMMAND_COLUMN = 2 + 12 + 2;
      const commands = commandRows(lines);
      expect(commands.length).toBeGreaterThan(10);
      for (const row of commands) {
        const name = row.trim().split(/\s+/u)[0] ?? '';
        expect(row.slice(0, COMMAND_COLUMN), row).toBe(`  ${name.padEnd(12)}  `);
        expect(row.charAt(COMMAND_COLUMN), row).not.toBe(' ');
      }
      // A section ends with one blank line, and the keys follow their heading directly.
      const keys = lines.indexOf('Keys');
      expect(lines[keys - 1]).toBe('');
      expect(lines[keys - 2]).not.toBe('');
      // The longest key is `Ctrl+A/Ctrl+E` (13).
      const KEY_COLUMN = 2 + 13 + 2;
      const rows = lines.slice(keys + 1);
      for (const key of KEYS) {
        const row = rows.find((line) => line.startsWith(`  ${key.keys.padEnd(13)}  `));
        expect(row, key.keys).toBeDefined();
        expect(row?.charAt(KEY_COLUMN), key.keys).not.toBe(' ');
      }
    },
  );

  it('the columns follow the longest name that is listed, not a width written into the popup', () => {
    const lines = helpLines('standalone-chat', [
      { keys: 'Enter', verb: 'send it' },
      { keys: 'Shift+Tab', verb: 'change the mode' },
    ]);
    expect(lines.slice(lines.indexOf('Keys') + 1)).toEqual([
      '  Enter      send it',
      '  Shift+Tab  change the mode',
    ]);
  });
});
