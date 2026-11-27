/**
 * The `/help` popup on the Home ([MVP-11 unit 8](../../../../docs/roadmap/phases/mvp-11/unit-8-plan.md) §4 D6): the keys of the Home, then its commands
 * grouped as the palette groups them and listed by name alone, on one page that does not scroll at 80×24; `[c] copy` like every report; `Esc` closes.
 */
import { describe, expect, it } from 'vitest';

import { HOME_PALETTE_COMMANDS } from '../commands/repl-commands.js';
import { HOME_KEYS } from '../render/tui/help-sheet.js';
import { homeHelpLines } from './home-help-popup.js';
import { ESC, homeRig } from './home-popups.test-support.js';

const KEYS = Object.values(HOME_KEYS).map((key) => ({ keys: key.keys, verb: key.short }));

describe('the page', () => {
  it('lists the Home’s keys, then its commands by group in the palette’s order, by name alone', () => {
    const lines = homeHelpLines(KEYS);
    expect(lines[0]).toBe('Keys');
    expect(lines.join('\n')).toMatch(/Enter\s+start a chat with what you typed/u);
    expect(lines.join('\n')).toMatch(/Ctrl\+C\s+twice to exit/u);
    const commands = lines.slice(lines.findIndex((line) => line.startsWith('Commands')) + 1);
    expect(commands[0]).toMatch(/^ {2}Work\s+\/resume {2}\/run {2}\/workflows {2}\/agents$/u);
    expect(commands.join('\n')).toMatch(/Set up\s+\/providers/u);
    expect(commands.join('\n')).toMatch(/Check\s+\/doctor/u);
    expect(commands.at(-1)).toMatch(/End\s+\/clear {2}\/exit$/u);
    // Every command of the Home's palette is named once; no description is copied.
    const names = HOME_PALETTE_COMMANDS.map((command) => `/${command.name}`);
    for (const name of names) expect(commands.join('\n')).toContain(name);
    expect(commands.join('\n')).not.toContain('Check your setup');
  });

  it('is one page at 80×24: no more rows than the popup’s body holds, every row inside its width', () => {
    const lines = homeHelpLines(KEYS);
    expect(lines.length).toBeLessThanOrEqual(18);
    for (const line of lines) expect([...line].length).toBeLessThanOrEqual(66);
  });

  it('a key name and a verb the port hands in are scrubbed: a hostile one forges no key, no separator and no glyph of the host', () => {
    const lines = homeHelpLines([
      { keys: `[Ctrl+Y] ${String.fromCharCode(27)}[31mx`, verb: 'Press Ctrl+Y now ▼ 9 more' },
    ]).join('\n');
    expect(lines.includes(String.fromCharCode(27))).toBe(false);
    expect(lines).not.toMatch(/Ctrl\+Y now/u);
  });
});

describe('the popup', () => {
  it('opens as one report step whose way back names the Home and whose one control is `[c] copy`; `Esc` closes', () => {
    const rig = homeRig();
    expect(rig.open('help', { help: { keys: KEYS } }).opened).toBe(true);
    expect(rig.content().kind).toBe('report');
    expect(rig.host.getSnapshot().frame?.spec.origin).toBe('home');
    expect(rig.host.getSnapshot().frame?.spec.steps[0]?.exitVerb).toBe('back to Home');
    expect(rig.controls()).toEqual(['c']);
    rig.settle();
    rig.press('', ESC);
    expect(rig.isOpen()).toBe(false);
  });

  it('`[c]` copies the page as drawn', () => {
    const rig = homeRig();
    const written: string[] = [];
    expect(
      rig.open('help', {
        help: { keys: KEYS },
        clipboard: (text: string) => {
          written.push(text);
          return true;
        },
      } as never).opened,
    ).toBe(true);
    rig.settle();
    rig.press('c');
    expect(written.join('')).toContain('Commands');
  });
});
