import { plainTextRefusal } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import { CliError } from '../../process/errors.js';
import { consentCardText, CONSENT_PATH_REFUSED } from '../../home/consent-card.js';
import type { ConsentSubject } from '../../engine/mcp-consent-gate.js';
import {
  blankHostGlyphs,
  blankMarkerGlyphs,
  GLYPH_ROLES,
  GLYPHS,
  HOST_BLANKED_GLYPHS,
  MARKER_GLYPHS,
  TABLE_GLYPHS,
} from './glyphs.js';
import { authorLine } from './run-card-model.js';

/**
 * The host-glyph relation of [ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §5, pinned BY BEHAVIOUR: the
 * core's refusal (`plainTextRefusal`, through its public export) is the base set the CLI's set must contain, and so is every role of the table
 * that does not say `hostBlanked: false`: the set is the core's refusal UNION the blanked roles. The roles that say it are the shapes that are
 * also ordinary text (`•`, `▲`, `▼`), which a project path or an author's bullet list may hold (a refinement of ADR-0145 §5, which said "every
 * glyph of the table"). Nothing here reads the core's pattern or the CLI's: each probe asks the real function, so a set that is edited, or a
 * table that gains a glyph the CLI function does not blank, fails here and not in a review.
 */

/** The glyphs of the table that are ordinary text and so are not host glyphs. */
const ORDINARY_TEXT = ['•', '▲', '▼'];

/** A consent subject whose executable and directory are `path`: the card is built, or refused with fixed words. */
const subjectAt = (path: string): ConsentSubject => ({
  serverId: 'srv',
  provenance: 'inline',
  artifact: undefined,
  resolvedCommand: path,
  authoredCommand: undefined,
  args: [],
  env: [],
  cwd: path,
  digest: 'v1:00',
  total: 1,
  index: 1,
  previouslyApprovedIn: undefined,
});

const REFUSED = "must not draw the host's own glyphs, tick shapes or approval keys";

/** Every code point of the box-drawing block, U+2500 to U+257F, and the three glyphs the core refuses besides. */
const CORE_PROBES: readonly string[] = [
  ...Array.from({ length: 0x80 }, (_, offset) => String.fromCodePoint(0x2500 + offset)),
  '›',
  '✎',
  '█',
];

/** A probe is placed where no other rule of the core's refusal could fire, so the only reason to refuse it is the glyph. */
const probe = (character: string): string => `a ${character} b`;

describe('the core refuses what the CLI blanks', () => {
  it('the core refuses every box-drawing character and `›`, `✎` and `█` (the probe is sound)', () => {
    for (const character of CORE_PROBES) {
      expect(
        plainTextRefusal(probe(character), 1000),
        `U+${character.codePointAt(0)?.toString(16)}`,
      ).toBe(REFUSED);
    }
    // and a probe with no host glyph in it is not refused, so the check above is the glyph's doing
    expect(plainTextRefusal(probe('x'), 1000)).toBeUndefined();
  });

  it('the CLI’s host-glyph set contains everything the core refuses: the run card’s author text is blanked of each', () => {
    for (const character of CORE_PROBES) {
      expect(blankHostGlyphs(probe(character)), `U+${character.codePointAt(0)?.toString(16)}`).toBe(
        'a   b',
      );
      expect(
        authorLine(probe(character)),
        `authorLine, U+${character.codePointAt(0)?.toString(16)}`,
      ).not.toContain(character);
    }
  });
});

describe('the CLI blanks every glyph of the table that is not ordinary text', () => {
  it('each glyph of each role is blanked from author text, behind a card’s gutter, unless its role says it is ordinary text', () => {
    for (const role of GLYPH_ROLES) {
      const { glyph } = GLYPHS[role];
      if (ORDINARY_TEXT.includes(glyph)) continue;
      expect(
        authorLine(probe(glyph)),
        `${role} (${glyph}) is blanked by the run card`,
      ).not.toContain(glyph);
      expect(blankHostGlyphs(probe(glyph)), `${role} (${glyph}) is blanked by the set`).toBe(
        'a   b',
      );
    }
  });

  it('the relation is the core’s refusal UNION the roles with no `hostBlanked: false`: the set holds exactly those glyphs and the box-drawing block', () => {
    const blanked = new Set<string>([
      ...CORE_PROBES,
      ...GLYPH_ROLES.filter((role) => !('hostBlanked' in GLYPHS[role])).map(
        (role) => GLYPHS[role].glyph,
      ),
    ]);
    // every member of the union is blanked …
    for (const character of blanked)
      expect(blankHostGlyphs(probe(character)), character).toBe('a   b');
    // … and every glyph of the table outside it is left alone
    for (const character of TABLE_GLYPHS) {
      if (blanked.has(character)) continue;
      expect(blankHostGlyphs(probe(character)), character).toBe(probe(character));
    }
    expect([...HOST_BLANKED_GLYPHS].every((character) => blanked.has(character))).toBe(true);
  });

  it('a bullet and the two triangles survive an author’s text: `• first` lines and a `▲ ▼` rating are not turned into spaces', () => {
    expect(authorLine('• first\n• second')).toBe('• first • second');
    for (const character of ORDINARY_TEXT) {
      expect(authorLine(`${character} item`), character).toBe(`${character} item`);
      expect(blankHostGlyphs(`a ${character} b`), character).toBe(`a ${character} b`);
    }
  });

  it('the glyphs that stay blanked still blank an author’s text: `★ ↻ ◇ ⇄` lead history, active and transcript rows', () => {
    for (const character of ['★', '↻', '◇', '⇄', '✎', '◆', '▌', '█']) {
      expect(authorLine(`${character} item`), character).toBe('  item');
    }
  });

  it('a project path with a bullet or a triangle in it is shown by the MCP consent card, one with a glyph that stays blanked is refused', () => {
    for (const character of ORDINARY_TEXT) {
      const path = `/home/ada/${character}proj/srv`;
      const card = consentCardText(subjectAt(path));
      expect(card.details.join('\n'), character).toContain(path);
    }
    for (const character of ['★', '↻', '◇', '⇄', '✓', '│']) {
      expect(() => consentCardText(subjectAt(`/home/ada/${character}proj/srv`)), character).toThrow(
        CONSENT_PATH_REFUSED,
      );
    }
    expect(() => consentCardText(subjectAt('/home/ada/x\u2502y/srv'))).toThrow(CliError);
  });

  it('the markers the plan names are in the set: `› ▸ ⇄ ◉ ◐`, the rail and the rules (`▲ ▼ •` are in the table, as ordinary text)', () => {
    for (const character of ['›', '▸', '⇄', '◉', '◐', '▲', '▼', '•', '╌', '━', '─']) {
      expect(TABLE_GLYPHS, character).toContain(character);
      if (ORDINARY_TEXT.includes(character)) continue;
      expect(authorLine(probe(character)), character).not.toContain(character);
    }
  });

  it('the glyphs that left the table are still blanked: the set only ever gains', () => {
    for (const character of ['⏸', '▶', '❯']) {
      expect(authorLine(probe(character)), character).not.toContain(character);
    }
  });

  it('ordinary text is left alone by the set', () => {
    const text = 'Deploy to staging, then — check the logs and reply (yes/no)';
    expect(authorLine(text)).toBe(text);
  });
});

describe('what the transcript guard blanks in model text', () => {
  it('the marker glyphs are `›`, `▸` and `⇄`, and the guard blanks each', () => {
    expect([...MARKER_GLYPHS].sort()).toEqual(['▸', '›', '⇄'].sort());
    for (const character of MARKER_GLYPHS) {
      expect(blankMarkerGlyphs(`${character} text`)).toBe('  text');
    }
  });

  it('a check mark, a dot and a rule in a reply are left alone: blanking them would damage ordinary output', () => {
    for (const character of ['✓', '●', '─']) {
      const text = `${character} a reply that quotes one`;
      expect(blankMarkerGlyphs(text)).toBe(text);
    }
  });

  it('the guard blanks a subset of what the author text set blanks, so nothing the guard lets through is a marker', () => {
    for (const character of MARKER_GLYPHS) {
      expect(blankHostGlyphs(probe(character))).toBe('a   b');
    }
    for (const character of TABLE_GLYPHS) {
      if (MARKER_GLYPHS.includes(character)) continue;
      expect(blankMarkerGlyphs(probe(character)), character).toBe(probe(character));
    }
  });
});
