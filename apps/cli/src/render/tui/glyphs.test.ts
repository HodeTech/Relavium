import { readFileSync } from 'node:fs';

import { ASK_USER_OWN_ANSWER_GLYPH } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import {
  blankStatusCell,
  blankHostGlyphs,
  blankHostMarks,
  blankHostShapes,
  blankMarkerGlyphs,
  GLYPH_ROLES,
  GLYPHS,
  glyph,
  glyphOf,
  glyphWithWord,
  HOST_BLANKED_GLYPHS,
  isStatusRole,
  markWithWord,
  MARKER_GLYPHS,
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
        'pencil',
      ] satisfies GlyphRole[]),
    );
  });

  it('is, cell by cell, the table ADR-0145 §5 and MVP-11 §4.10 give: every role’s glyph, plain form, word and colour', () => {
    // A literal: a cell that is edited (a word renamed, a form swapped, a colour changed) fails here and not in a review.
    const status = (glyph: string, ascii: string, word: string, tone: string): object => ({
      glyph,
      ascii,
      kind: 'status',
      word,
      tone,
    });
    const shape = (glyph: string, ascii: string, extra: object = {}): object => ({
      glyph,
      ascii,
      kind: 'shape',
      ...extra,
    });
    expect(Object.fromEntries(GLYPH_ROLES.map((role) => [role, { ...GLYPHS[role] }]))).toEqual({
      completed: status('✓', 'ok', 'completed', 'green'),
      failed: status('✗', 'x', 'failed', 'red'),
      paused: status('‖', '||', 'paused', 'yellow'),
      cancelled: status('⊘', '/', 'cancelled', 'gray'),
      skipped: status('⊘', '/', 'skipped', 'gray'),
      running: status('◐', '~', 'running', 'cyan'),
      starting: status('◌', '..', 'starting', 'cyan'),
      pending: status('○', 'o', 'pending', 'gray'),
      ended: status('○', 'o', 'ended', 'gray'),
      currentStep: status('◉', '@', 'current', 'cyan'),
      retrying: status('↻', 'r', 'retrying', 'yellow'),
      held: status('◇', '<>', 'held', 'yellow'),
      warning: status('⚠', '!', 'warning', 'yellow'),
      stopping: status('■', '#', 'stopping', 'yellow'),
      answered: status('●', '+', 'answered', 'green'),
      pinned: status('★', 'P', 'pinned', 'yellow'),
      railLine: shape('╌', '.'),
      heavyRule: shape('━', '='),
      thinRule: shape('─', '-'),
      selection: shape('›', '>', { guarded: true }),
      yourTurn: shape('›', '>', { guarded: true }),
      toolCall: shape('▸', '->', { guarded: true }),
      moreAbove: shape('▲', '^', { hostBlanked: false }),
      moreBelow: shape('▼', 'v', { hostBlanked: false }),
      bullet: shape('•', '*', { hostBlanked: false }),
      modelSwitch: shape('⇄', '<->', { guarded: true }),
      caret: shape('█', '_'),
      activeBar: shape('▌', '|'),
      media: shape('◆', '&'),
      pencil: shape('✎', 'e'),
    });
    // and the roles are in the order of the ADR, statuses first
    expect(GLYPH_ROLES[0]).toBe('completed');
    expect(GLYPH_ROLES.at(-1)).toBe('pencil');
  });

  it('the pencil is the core’s own own-answer glyph, so the table and the question refusal cannot drift apart', () => {
    expect(GLYPHS.pencil.glyph).toBe(ASK_USER_OWN_ANSWER_GLYPH);
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
    for (const role of GLYPH_ROLES.filter(isStatusRole)) {
      expect(displayWidth(statusCellOf(role, true)), role).toBe(2);
      expect(displayWidth(statusCellOf(role, false)), role).toBe(1);
    }
  });

  it('glyphWithWord puts the word beside the glyph', () => {
    expect(glyphWithWord('pinned')).toBe('★ pinned');
    expect(withGlyphForm(true, () => glyphWithWord('pinned'))).toBe('P pinned');
  });

  it('a mark that is the word is written once: `ok ok` is a stutter, every other pairing is the mark and the word', () => {
    expect(markWithWord('ok', 'ok')).toBe('ok');
    expect(markWithWord('✓', 'ok')).toBe('✓ ok');
    expect(markWithWord('x', 'failed')).toBe('x failed');
    expect(markWithWord('ok', 'okay')).toBe('ok okay');
    // no status of the table has its own word for a plain form, so glyphWithWord never drops one
    for (const role of GLYPH_ROLES.filter(isStatusRole)) {
      expect(
        withGlyphForm(true, () => glyphWithWord(role)),
        role,
      ).toBe(`${GLYPHS[role].ascii} ${GLYPHS[role].word}`);
    }
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
  /** The glyphs of the table that are also ordinary text, and so are not host glyphs (the roles that say `hostBlanked: false`). */
  const ORDINARY_TEXT = ['•', '▲', '▼'];

  it('blankHostGlyphs blanks every glyph of the table but the three that are ordinary text, the retired ones and the box-drawing block', () => {
    for (const character of [...TABLE_GLYPHS, '⏸', '▶', '❯', '─', '│', '╿', '╭']) {
      if (ORDINARY_TEXT.includes(character)) continue;
      expect(blankHostGlyphs(`a${character}b`), `U+${character.codePointAt(0)?.toString(16)}`).toBe(
        'a b',
      );
    }
  });

  it('a bullet and the two triangles are ordinary text: they survive, and the roles that say so are exactly those three', () => {
    for (const character of ORDINARY_TEXT) {
      expect(blankHostGlyphs(`a ${character} b`), character).toBe(`a ${character} b`);
      expect(HOST_BLANKED_GLYPHS, character).not.toContain(character);
    }
    expect(
      GLYPH_ROLES.filter((role) => 'hostBlanked' in GLYPHS[role]).sort((a, b) =>
        a.localeCompare(b),
      ),
    ).toEqual(['bullet', 'moreAbove', 'moreBelow']);
    // every other glyph of the table is in the set, and the set holds nothing the table does not
    expect([...HOST_BLANKED_GLYPHS].sort()).toEqual(
      TABLE_GLYPHS.filter((character) => !ORDINARY_TEXT.includes(character)).sort(),
    );
  });

  it('a glyph that two roles share stays blanked while either of them is', () => {
    // `⊘` (cancelled, skipped), `›` (selection, your turn) and `○` (pending, ended) are each blanked
    for (const character of ['⊘', '›', '○']) expect(HOST_BLANKED_GLYPHS).toContain(character);
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

describe('the shapes of the host’s choice marks a model could write', () => {
  const plain = (text: string): string => withGlyphForm(true, () => blankHostShapes(text));
  const unicode = (text: string): string => withGlyphForm(false, () => blankHostShapes(text));

  it('the plain form loses the parentheses of `(*)` and `( )` and the `>` that starts a text before a digit or a space', () => {
    expect(plain('Keep (*) it')).toBe('Keep  *  it');
    expect(plain('Keep ( ) it')).toBe('Keep     it');
    expect(plain('>1 (*) Delete')).toBe(' 1  *  Delete');
    expect(plain('> 1 (*) Delete')).toBe('  1  *  Delete');
    expect(plain('>')).toBe('>');
  });

  it('the Unicode form loses the parentheses of `(•)` and `( )`, and keeps `(*)` and `>`: the host draws neither there', () => {
    expect(unicode('Keep (•) it')).toBe('Keep  •  it');
    expect(unicode('Keep ( ) it')).toBe('Keep     it');
    expect(unicode('Keep (*) it')).toBe('Keep (*) it');
    expect(unicode('>1 (*) Delete')).toBe('>1 (*) Delete');
  });

  it('`(x)`, `(o)`, a call such as `f(x)`, a `>` that is not at the start and a `>` before a letter are ordinary text, in both forms', () => {
    for (const text of [
      'What should f(x) return when (o) is empty?',
      'Delete (X) (O)',
      'a > b',
      '>x then',
      'x > 1',
      'f(*x)',
      '(**)',
    ]) {
      expect(plain(text), text).toBe(text);
      expect(unicode(text), text).toBe(text);
    }
  });

  it('keeps the width of the text, so a layout measured on it does not move, and keeps two labels that differed different', () => {
    for (const text of ['Delete (*)', 'Delete ( )', '> 1 (*) x', 'Delete', 'Delete (x)']) {
      expect(displayWidth(plain(text)), text).toBe(displayWidth(text));
      expect([...plain(text)].length, text).toBe([...text].length);
    }
    expect(new Set(['Delete (x)', 'Delete (*)', 'Delete'].map(plain)).size).toBe(3);
  });

  it('blankHostMarks blanks the host glyphs FIRST, so the `( )` that `(●)` becomes is neutralised too, and a `❯` is a space', () => {
    for (const asciiForm of [true, false])
      expect(withGlyphForm(asciiForm, () => blankHostMarks('❯ 1 (●) Delete all'))).toBe(
        '  1     Delete all',
      );
    // the order is the point: shapes first would leave the `( )` that blanking creates
    expect(blankHostGlyphs('(●)')).toBe('( )');
    expect(withGlyphForm(true, () => blankHostMarks('a (●) b (›) c'))).toBe('a     b     c');
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
