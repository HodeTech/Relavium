/**
 * The landing's hosted-run row (MVP-11 unit 7, round 1: OB74; ADR-0139 §3): it named the run by its whole 36-character id
 * (`◐ 5e2f2a1b-fe68-…  ·  running  ·  Enter show it`, cut by the row), where the notice a moment earlier said `run 5e2f2a1b`. The run host's
 * snapshot carries no workflow name, so the row names the run by its short id, the first eight characters, as every other surface does; never
 * the whole id. The id is stored text: it passes the full scrub of the Home's rows (`flowLine`) before it is cut, so no control, bidirectional,
 * invisible or line-separator character, no key, no host glyph and no separator survives into the row. The glyph and word forms are as before.
 */
import { describe, expect, it } from 'vitest';

import type { RunHostSnapshot } from '../../home/run-host.js';
import { withGlyphForm } from './glyphs.js';
import { hostedEndNotice } from './home-attention.js';
import { hostedRunLabel } from './home-projection.js';
import { displayWidth } from './viewport.js';

const RUN_ID = '5e2f2a1b-fe68-4c1d-9a2e-7b3c4d5e6f70';
const live = (runId: string | undefined, cancelling = false): RunHostSnapshot => ({
  launching: runId === undefined,
  active: { leg: 'start', runId, cancelling },
  last: undefined,
});
const ch = (code: number): string => String.fromCodePoint(code);
/** The id part of a row: what stands between the glyph and the first separator. */
const idOf = (label: string | undefined): string =>
  (label ?? '').split('  ·  ')[0]?.split(' ').slice(1).join(' ') ?? '';

describe('the hosted run’s row names the run by its short id', () => {
  it('running and cancelling: the glyph, the first eight characters of the id, the word and the cue', () => {
    expect(hostedRunLabel(live(RUN_ID))).toBe('◐ 5e2f2a1b  ·  running  ·  Enter show it');
    expect(hostedRunLabel(live(RUN_ID, true))).toBe('■ 5e2f2a1b  ·  cancelling  ·  Enter show it');
    expect(hostedRunLabel(live(RUN_ID))).not.toContain(RUN_ID);
  });

  it('in the plain glyph forms without colour, and `starting` while the engine has not named the run', () => {
    expect(withGlyphForm(true, () => hostedRunLabel(live(RUN_ID)))).toBe(
      '~ 5e2f2a1b  ·  running  ·  Enter show it',
    );
    expect(hostedRunLabel(live(undefined))).toBe('◌ run  ·  starting');
  });
});

describe('the id is scrubbed before it is cut', () => {
  const HOSTILE: Readonly<Record<string, string>> = {
    'an OSC 8 link': `${ch(0x1b)}]8;;https://evil.example${ch(0x1b)}\\click${ch(0x1b)}]8;;${ch(0x1b)}\\`,
    'an OSC 52 write': `${ch(0x1b)}]52;c;ZXZpbA==${ch(7)}abc`,
    'a bidirectional override': `${ch(0x202e)}gninnur${ch(0x202c)}`,
    'zero-width characters': `a${ch(0x200b)}b${ch(0x2060)}c${ch(0xfeff)}d`,
    'line separators': `a${ch(0x2028)}b${ch(0x2029)}c`,
    'tag characters': `a${ch(0xe0041)}${ch(0xe0042)}b`,
    'host glyphs': '› ▸ ⇄ ◐ x',
    'a separator': 'a · b',
    'a key': `sk-ant-api03-${'A'.repeat(90)}`,
  };
  const BAD = new RegExp(
    `[${ch(0)}-${ch(0x1f)}${ch(0x7f)}-${ch(0x9f)}${ch(0x200b)}-${ch(0x200f)}${ch(0x202a)}-${ch(0x202e)}${ch(0x2060)}-${ch(0x2069)}${ch(0x2028)}${ch(0x2029)}${ch(0xfeff)}${ch(0xe0000)}-${ch(0xe007f)}]`,
    'u',
  );
  it.each(Object.entries(HOSTILE))('%s', (_name, id) => {
    const label = hostedRunLabel(live(id)) ?? '';
    const shown = idOf(label);
    expect(label).not.toMatch(BAD);
    expect(shown, 'no host glyph of the row’s own').not.toMatch(/[›▸⇄◐■]/u);
    expect(shown, 'no separator inside the id').not.toContain(' · ');
    expect(shown, 'no key').not.toMatch(/sk-ant/u);
    expect(Array.from(shown).length, 'eight characters at most').toBeLessThanOrEqual(8);
    expect(label.endsWith('  ·  running  ·  Enter show it')).toBe(true);
    expect(displayWidth(label)).toBeLessThanOrEqual(
      displayWidth('◐ 00000000  ·  running  ·  Enter show it') + 8,
    );
  });
});

describe('the line a chat gets when that run ends names it through the same scrub', () => {
  it('its workflow from the Attention row, or its short id: no invisible character, no separator, no key', () => {
    const slug = `deploy${ch(0x200b)}${ch(0x2028)} · auto mode`;
    const named = hostedEndNotice(
      { runId: RUN_ID, disposition: 'paused' },
      {
        runId: RUN_ID,
        kind: 'approval',
        gates: 1,
        workflow: slug,
      },
    );
    // The line separator is folded to a space and the separator made inert (` - `): one row, and no field forged.
    expect(named).toBe(
      '‖ deploy  - auto mode is waiting at a gate. Leave this chat to answer it on the Home.',
    );
    const unnamed = hostedEndNotice(
      { runId: `${ch(0x202e)}sk-ant-api03-${'A'.repeat(90)}`, disposition: 'failed' },
      undefined,
    );
    expect(unnamed).not.toMatch(/sk-ant/u);
    expect(unnamed).not.toContain(ch(0x202e));
    expect(unnamed?.endsWith('failed. Leave this chat to see it on the Home.')).toBe(true);
  });
});
