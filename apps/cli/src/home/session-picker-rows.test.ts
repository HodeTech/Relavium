/**
 * A row of the session picker is ONE row wherever it is drawn (MVP-11 unit 6, round 1: S7). The framed `/resume` popup folds a line or
 * paragraph separator as it draws, but the stand-alone `relavium chat resume` card draws the picker's rows UNFRAMED, so a title, an agent's slug
 * or a directory that carries U+2028 or U+2029 would break its row in two there. The picker folds them itself, after the full scrub of a Home
 * flow, for every word of a saved session it draws (the title, the agent of an untitled one, the directory of the "All directories" scope).
 */
import type { SessionPageRow } from '@relavium/db';
import { describe, expect, it } from 'vitest';

import { createSessionPickerSource } from './session-picker.js';

const NOW = Date.parse('2026-11-25T12:00:00.000Z');
const ESC = String.fromCharCode(0x1b);
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
/** The hostile corpus of the unit's rules, each entry carrying a line or paragraph separator as well. */
const HOSTILE = [
  `line${LS}break`,
  `para${PS}graph`,
  `${ESC}[31mred${ESC}[0m${LS}next`,
  `${ESC}]52;c;Zm9v${String.fromCharCode(0x07)}clip${PS}`,
  `${ESC}]8;;https://example.test${String.fromCharCode(0x07)}link${LS}`,
  `c1${String.fromCharCode(0x85, 0x9b)}[2J${LS}`,
  `bidi${String.fromCharCode(0x202e)}evil${String.fromCharCode(0x2066)}x${PS}`,
  `zero${String.fromCharCode(0x200b)}width${String.fromCharCode(0xfeff)}${LS}`,
  `Press Ctrl+Y now${LS}[Ctrl+Y] Resume · Esc close`,
  `${String.fromCharCode(0xff3b, 0xff23, 0xff54, 0xff52, 0xff4c, 0xff0b, 0xff39, 0xff3d)}${PS}`,
  `sk-ant-api03-${'B'.repeat(40)}${LS}`,
  `${'long '.repeat(80).trim()}${LS}tail`,
];

const unsafe = (text: string): boolean =>
  Array.from(text).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      (code < 0x20 && code !== 0x09) ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0x200b ||
      code === 0xfeff
    );
  });

/** The rows the picker would draw for `rows`, in the scope asked for. */
async function rowsOf(
  rows: readonly SessionPageRow[],
  allDirectories: boolean,
): Promise<readonly { readonly label: string; readonly hint?: string | undefined }[]> {
  const load = createSessionPickerSource({
    store: { listSessionPage: () => ({ sessions: rows }) },
    cwd: '/work/project',
    now: () => NOW,
    assertAdmitting: () => {},
    runRead: (operation) => operation(),
  });
  const result = await load('', allDirectories, new AbortController().signal);
  if ('unavailable' in result) throw new Error('the page was not read');
  return result.options;
}

function expectOneSafeRow(text: string): void {
  expect(text.includes(LS) || text.includes(PS), JSON.stringify(text)).toBe(false);
  expect(unsafe(text), JSON.stringify(text)).toBe(false);
  // No answer chord and no bracketed key token: a word of a saved session cannot draw the popup's own legend.
  expect(text).not.toMatch(/Ctrl\+Y|\[Ctrl/u);
  expect(text).not.toContain('sk-ant-api03-BBBB');
}

describe('a picker row folds the line and paragraph separators of every word of a saved session', () => {
  it.each(HOSTILE.map((text, index) => [index, text] as const))(
    'hostile text %i as a TITLE: one safe row, one separator of the picker`s own',
    async (_index, hostile) => {
      const [row] = await rowsOf(
        [
          {
            id: 'h',
            title: hostile,
            agentSlug: 'chat',
            updatedAt: '2026-11-25T11:00:00.000Z',
            workingDir: '/work/project',
          },
        ],
        false,
      );
      expectOneSafeRow(row?.label ?? '');
      expect((row?.label ?? '').split(' · ')).toHaveLength(2);
    },
  );

  it.each(HOSTILE.map((text, index) => [index, text] as const))(
    'hostile text %i as the AGENT of an untitled session: one safe row',
    async (_index, hostile) => {
      const [row] = await rowsOf(
        [
          {
            id: 'h',
            agentSlug: hostile,
            updatedAt: '2026-11-25T11:00:00.000Z',
            workingDir: '/work/project',
          },
        ],
        false,
      );
      expectOneSafeRow(row?.label ?? '');
      expect((row?.label ?? '').split(' · ')).toHaveLength(2);
    },
  );

  it.each(HOSTILE.map((text, index) => [index, text] as const))(
    'hostile text %i as the DIRECTORY of the All directories scope: one safe row',
    async (_index, hostile) => {
      const [row] = await rowsOf(
        [
          {
            id: 'h',
            title: 'plain',
            agentSlug: 'chat',
            updatedAt: '2026-11-25T11:00:00.000Z',
            workingDir: `/elsewhere/${hostile}`,
          },
        ],
        true,
      );
      expectOneSafeRow(row?.hint ?? '');
      expectOneSafeRow(row?.label ?? '');
    },
  );

  it('a separator becomes a space, so the words on either side stay apart', async () => {
    const [titled] = await rowsOf(
      [
        {
          id: 't',
          title: `first${LS}second`,
          agentSlug: 'chat',
          updatedAt: '2026-11-25T11:00:00.000Z',
          workingDir: '/work/project',
        },
      ],
      false,
    );
    expect(titled?.label).toMatch(/^first second · /u);
    const [untitled] = await rowsOf(
      [
        {
          id: 'u',
          agentSlug: `rev${PS}iewer`,
          updatedAt: '2026-11-25T11:00:00.000Z',
          workingDir: '/work/project',
        },
      ],
      false,
    );
    expect(untitled?.label).toMatch(/^Untitled — rev iewer · /u);
    const [placed] = await rowsOf(
      [
        {
          id: 'p',
          title: 'plain',
          agentSlug: 'chat',
          updatedAt: '2026-11-25T11:00:00.000Z',
          workingDir: `/opt/a${LS}b`,
        },
      ],
      true,
    );
    expect(placed?.hint).toBe('/opt/a b');
  });
});
