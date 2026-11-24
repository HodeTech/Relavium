import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  blankStatusCell,
  blankHostGlyphs,
  blankMarkerGlyphs,
  GLYPH_ROLES,
  GLYPHS,
  glyph,
  glyphOf,
  glyphWithWord,
  isStatusRole,
  MARKER_GLYPHS,
  padToStatusCell,
  SHARED_GLYPH_ROLES,
  statusCell,
  statusCellOf,
  STATUS_WORD_WIDTH,
  TABLE_GLYPHS,
  toneOf,
  withGlyphForm,
  wordOf,
  type GlyphRole,
} from './glyphs.js';
import { keyToken } from './legend.js';
import { displayWidth } from './viewport.js';

/** The roles that share a glyph and a plain form on purpose, keyed by the first of each group (the others are told apart by their words). */
const SHARING_PARTNER = new Map<GlyphRole, GlyphRole>(
  SHARED_GLYPH_ROLES.flatMap((group) =>
    group.slice(1).map((role): [GlyphRole, GlyphRole] => [role, group[0] as GlyphRole]),
  ),
);

const representatives = (): readonly GlyphRole[] =>
  GLYPH_ROLES.filter((role) => !SHARING_PARTNER.has(role));

describe('the glyph table', () => {
  it('has a role for every glyph ADR-0145 §5 names, and the roles the code already drew', () => {
    expect(GLYPH_ROLES).toEqual(
      expect.arrayContaining([
        'completed',
        'failed',
        'paused',
        'cancelled',
        'skipped',
        'running',
        'starting',
        'pending',
        'currentStep',
        'retrying',
        'held',
        'warning',
        'stopping',
        'ended',
        'railLine',
        'heavyRule',
        'thinRule',
        'selection',
        'yourTurn',
        'toolCall',
        'moreAbove',
        'moreBelow',
        'bullet',
        'modelSwitch',
      ] satisfies GlyphRole[]),
    );
  });

  it('draws the paused role with the double bar, and the pause sign has retired', () => {
    expect(GLYPHS.paused.glyph).toBe('‖');
    expect(TABLE_GLYPHS).not.toContain('⏸');
  });

  it('gives every ASCII form once: no two roles read alike unless the table declares that they share', () => {
    const seen = new Map<string, GlyphRole>();
    for (const role of representatives()) {
      const form = GLYPHS[role].ascii;
      expect(seen.get(form), `"${form}" is the form of ${role} and of ${seen.get(form)}`).toBe(
        undefined,
      );
      seen.set(form, role);
    }
  });

  it('gives every glyph once: no two roles draw alike unless the table declares that they share', () => {
    const seen = new Map<string, GlyphRole>();
    for (const role of representatives()) {
      const form = GLYPHS[role].glyph;
      expect(seen.get(form), `"${form}" is the glyph of ${role} and of ${seen.get(form)}`).toBe(
        undefined,
      );
      seen.set(form, role);
    }
  });

  it('a declared sharing is one glyph and one ASCII form, and the roles of a group are all statuses or all shapes', () => {
    for (const [role, first] of SHARING_PARTNER) {
      expect(GLYPHS[role].glyph, `${role} and ${first}: the glyph`).toBe(GLYPHS[first].glyph);
      expect(GLYPHS[role].ascii, `${role} and ${first}: the plain form`).toBe(GLYPHS[first].ascii);
      expect(GLYPHS[role].kind, `${role} and ${first}: the kind`).toBe(GLYPHS[first].kind);
    }
    // the selection and your turn read `>` (the selection with inverse, your turn with bold), as the ADR says
    expect(GLYPHS.selection.ascii).toBe('>');
    expect(GLYPHS.yourTurn.ascii).toBe('>');
  });

  it('every ASCII form is printable ASCII of at most three columns, by the renderer’s own width function', () => {
    for (const role of GLYPH_ROLES) {
      const { ascii } = GLYPHS[role];
      expect(ascii, `${role} is not empty`).not.toBe('');
      expect(ascii, `${role} is printable ASCII, with no space in it`).toMatch(/^[\x21-\x7e]+$/u);
      expect(displayWidth(ascii), `${role} is at most three columns`).toBeLessThanOrEqual(3);
    }
  });

  it('no ASCII form is a key label: the legend writes a letter or a chord in brackets', () => {
    const labels = new Set<string>();
    for (const letter of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') {
      labels.add(keyToken(letter));
      labels.add(`[Ctrl+${letter.toUpperCase()}]`);
    }
    for (const role of GLYPH_ROLES) {
      const { ascii } = GLYPHS[role];
      expect(labels.has(ascii), `${role} reads as the key label ${ascii}`).toBe(false);
      expect(ascii, `${role} is not a bracketed token`).not.toMatch(/^\[.*\]$/u);
    }
  });

  it('every status carries a word and a colour, and no shape carries either', () => {
    for (const role of GLYPH_ROLES) {
      const entry = GLYPHS[role];
      if (entry.kind === 'status') {
        expect(entry.word, `${role} has a word`).toMatch(/^[a-z]+$/u);
        expect(entry.tone, `${role} has a colour`).toBeDefined();
        expect(isStatusRole(role)).toBe(true);
        expect(wordOf(role as Parameters<typeof wordOf>[0])).toBe(entry.word);
      } else {
        expect(entry.word, `${role} is a shape: no word`).toBeUndefined();
        expect(entry.tone, `${role} is a shape: no colour`).toBeUndefined();
        expect(isStatusRole(role)).toBe(false);
      }
    }
  });

  it('every glyph is exactly one column wide by the width function the renderer uses', () => {
    for (const role of GLYPH_ROLES) {
      expect(displayWidth(GLYPHS[role].glyph), `${role}: ${GLYPHS[role].glyph}`).toBe(1);
    }
  });

  it('a glyph is a single code point of the symbol blocks, never an emoji', () => {
    for (const role of GLYPH_ROLES) {
      const { glyph: character } = GLYPHS[role];
      expect([...character], `${role}`).toHaveLength(1);
      expect(character.codePointAt(0) ?? 0, `${role} is in the BMP`).toBeLessThan(0x10000);
    }
  });

  it('the shared groups name roles of the table, once each', () => {
    const named = SHARED_GLYPH_ROLES.flat();
    expect(new Set(named).size).toBe(named.length);
    for (const role of named) expect(GLYPH_ROLES).toContain(role);
  });

  it('the word column is as wide as the longest status word', () => {
    const longest = Math.max(
      ...GLYPH_ROLES.filter(isStatusRole).map((role) => GLYPHS[role].word?.length ?? 0),
    );
    expect(STATUS_WORD_WIDTH).toBe(longest);
    expect(STATUS_WORD_WIDTH).toBe(9);
  });
});

describe('the two forms of a glyph', () => {
  it('glyphOf answers the Unicode glyph or the plain form by its flag, and is pure', () => {
    expect(glyphOf('completed', false)).toBe('✓');
    expect(glyphOf('completed', true)).toBe('ok');
    expect(glyphOf('paused', false)).toBe('‖');
    expect(glyphOf('paused', true)).toBe('||');
    expect(glyphOf('selection', false)).toBe('›');
    expect(glyphOf('selection', true)).toBe('>');
  });

  it('glyph() is the Unicode glyph outside withGlyphForm and the plain form inside it', () => {
    expect(glyph('failed')).toBe('✗');
    expect(withGlyphForm(true, () => glyph('failed'))).toBe('x');
    expect(withGlyphForm(false, () => glyph('failed'))).toBe('✗');
    expect(glyph('failed')).toBe('✗');
  });

  it('withGlyphForm nests, and restores the form it found even when the function throws', () => {
    const seen = withGlyphForm(true, () => [
      glyph('completed'),
      withGlyphForm(false, () => glyph('completed')),
      glyph('completed'),
    ]);
    expect(seen).toEqual(['ok', '✓', 'ok']);
    expect(() =>
      withGlyphForm(true, () => {
        throw new Error('model failed');
      }),
    ).toThrow('model failed');
    expect(glyph('completed')).toBe('✓');
  });

  it('withGlyphForm refuses a function that is asynchronous: the form would not be the one in force when it continued', () => {
    expect(() => withGlyphForm(true, () => Promise.resolve(glyph('completed')))).toThrow(TypeError);
    expect(glyph('completed')).toBe('✓');
  });

  it('a status cell is one column in the Unicode form and two in the plain form, so a list keeps its words aligned', () => {
    expect(statusCellOf('failed', false)).toBe('✗');
    expect(statusCellOf('failed', true)).toBe('x ');
    expect(statusCellOf('completed', true)).toBe('ok');
    expect(blankStatusCell(false)).toBe(' ');
    expect(blankStatusCell(true)).toBe('  ');
    expect(withGlyphForm(true, () => statusCell('failed'))).toBe('x ');
    expect(withGlyphForm(true, () => padToStatusCell('⠋'))).toBe('⠋ ');
    for (const role of GLYPH_ROLES.filter(isStatusRole)) {
      expect(displayWidth(statusCellOf(role, true)), role).toBe(2);
      expect(displayWidth(statusCellOf(role, false)), role).toBe(1);
    }
  });

  it('glyphWithWord puts the word beside the glyph', () => {
    expect(glyphWithWord('pinned')).toBe('★ pinned');
    expect(withGlyphForm(true, () => glyphWithWord('pinned'))).toBe('P pinned');
  });

  it('a status colour is the table’s: completed green, failed red, paused yellow, running cyan', () => {
    expect(toneOf('completed')).toBe('green');
    expect(toneOf('failed')).toBe('red');
    expect(toneOf('paused')).toBe('yellow');
    expect(toneOf('running')).toBe('cyan');
    expect(toneOf('skipped')).toBe('gray');
  });
});

describe('what the table does to text', () => {
  it('blankHostGlyphs blanks every glyph of the table, the retired ones and the box-drawing block', () => {
    for (const character of [...TABLE_GLYPHS, '⏸', '▶', '❯', '─', '│', '╿', '╭']) {
      expect(blankHostGlyphs(`a${character}b`), `U+${character.codePointAt(0)?.toString(16)}`).toBe(
        'a b',
      );
    }
  });

  it('blankHostGlyphs leaves ordinary text alone', () => {
    expect(blankHostGlyphs('plain text — with · and … and → and 1.2.3')).toBe(
      'plain text — with · and … and → and 1.2.3',
    );
  });

  it('the transcript guard blanks the marker glyphs only', () => {
    expect([...MARKER_GLYPHS].sort()).toEqual(['▸', '›', '⇄'].sort());
    expect(blankMarkerGlyphs('› your turn ▸ a call ⇄ a switch')).toBe(
      '  your turn   a call   a switch',
    );
    // ordinary output is untouched: blanking these would damage a reply that quotes a check mark, a dot or a rule
    expect(blankMarkerGlyphs('✓ done ● dot ─ rule ◉ ○ ‖ ⚠ ★')).toBe(
      '✓ done ● dot ─ rule ◉ ○ ‖ ⚠ ★',
    );
  });
});

describe('the table is the one place the application’s source writes a glyph', () => {
  const source = readFileSync(new URL('./glyphs.ts', import.meta.url), 'utf8');

  it('the module imports nothing from ink, react or node: (ADR-0145 §10)', () => {
    const imports = [...source.matchAll(/^\s*import\b[^;]*?from\s+['"]([^'"]+)['"]/gmu)].map(
      (match) => match[1],
    );
    expect(imports).toEqual([]);
    expect(source).not.toMatch(/from\s+['"](?:ink|react|node:)/u);
    expect(source).not.toMatch(/require\(/u);
  });
});
