import { plainTextRefusal } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import {
  blankHostGlyphs,
  blankMarkerGlyphs,
  GLYPH_ROLES,
  GLYPHS,
  MARKER_GLYPHS,
  TABLE_GLYPHS,
} from './glyphs.js';
import { authorLine } from './run-card-model.js';

/**
 * The host-glyph relation of [ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §5, pinned BY BEHAVIOUR: the
 * core's refusal (`plainTextRefusal`, through its public export) is the base set the CLI's set must contain, and every glyph of the table is
 * in the CLI's set too. Nothing here reads the core's pattern or the CLI's: each probe asks the real function, so a set that is edited, or a
 * table that gains a glyph the CLI function does not blank, fails here and not in a review.
 */

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

describe('the CLI blanks every glyph of the table', () => {
  it('each glyph of each role is blanked from author text, behind a card’s gutter', () => {
    for (const role of GLYPH_ROLES) {
      const { glyph } = GLYPHS[role];
      expect(
        authorLine(probe(glyph)),
        `${role} (${glyph}) is blanked by the run card`,
      ).not.toContain(glyph);
      expect(blankHostGlyphs(probe(glyph)), `${role} (${glyph}) is blanked by the set`).toBe(
        'a   b',
      );
    }
  });

  it('the markers the plan names are in the set: `› ▸ ⇄ ◉ ◐ ▲ ▼ •`, the rail and the rules', () => {
    for (const character of ['›', '▸', '⇄', '◉', '◐', '▲', '▼', '•', '╌', '━', '─']) {
      expect(TABLE_GLYPHS, character).toContain(character);
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
