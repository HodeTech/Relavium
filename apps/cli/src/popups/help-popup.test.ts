/**
 * The `/help` popup in a chat ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §10;
 * MVP-11 step 4b): the commands of the chat's own palette, in the palette's order and on the surface's own words, and the keys the chat has.
 */
import { describe, expect, it } from 'vitest';

import { buildPaletteEntries } from '../render/tui/palette-entries.js';
import { CHAT_KEYS } from '../render/tui/chat-keys.js';
import { popupBoxOf } from '../render/tui/surface-matrix/popup-fixture.js';
import { displayWidth } from '../render/tui/viewport.js';
import { helpContent, helpLines, helpSpec } from './help-popup.js';
import { openFrame } from './popup-reducer.js';
import { REPORT_TEXT_COLUMNS } from './report-text.js';
import type { ReportSurface } from './report-port.js';

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
        expect(displayWidth(line), line).toBeLessThanOrEqual(REPORT_TEXT_COLUMNS);
    });
  },
);

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

  it('is a report of one step, read-only: no control and no Enter', () => {
    const spec = helpSpec('chat', helpContent('standalone-chat', KEYS));
    expect(spec.steps).toHaveLength(1);
    expect(spec.steps[0]?.controls).toBeUndefined();
    expect(spec.steps[0]?.enter).toBeUndefined();
  });
});

describe('what the port hands in is scrubbed', () => {
  it.each(['keys', 'verb'])(
    'a hostile key %s reaches no row as an escape, a key token, a forged separator, a secret or a host glyph',
    (field) => {
      const evil = `x\u001b[31m [Ctrl+Y] allow · [d] ${SECRET} ✓› ‮`;
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
