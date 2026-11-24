import './force-color.js';

import { describe, expect, it } from 'vitest';

import { runCell } from './surface-matrix/cells.js';
import { ALL_SURFACES } from './surface-matrix/all-surfaces.js';
import { cellsOf } from './surface-matrix/variants.js';
import { GLYPH_ROLES, GLYPHS } from './glyphs.js';

/**
 * With colour off, every surface of the product draws the glyph table's PLAIN forms ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md)
 * §5): the same trigger as the banner's ASCII box. The surface matrix mounts every surface in every variant; this reads the frames of the
 * colour-off cells and fails on any glyph of the table that is still drawn in its Unicode form, so a surface that forgot to ask the table
 * (or that built its rows outside `withGlyphForm`) is named here, with the row it drew.
 *
 * The Unicode glyphs are checked in the colour cells too, from the other side: the plain forms of the glyphs that are easy to mistake for
 * text (`ok`, `||`) must not leak into a frame drawn with colour on.
 */

/** Glyphs that are drawn in both forms by design: none today. A glyph added here needs a reason in the comment above it. */
const DRAWN_IN_BOTH: ReadonlySet<string> = new Set<string>();

/**
 * Surfaces whose text is written by the Home's controller, outside any view: the doctor's report is formatted when the check ends and kept as
 * the notice, so the controller is told to write it in the plain forms (`plainGlyphs`, which `driveHome` sets from the colour setting). The
 * matrix mounts the controller without that dependency, and its harness is not part of this unit; `home-controller.test.ts` pins the plain
 * forms of the report with `plainGlyphs` set.
 */
const WRITTEN_BY_THE_CONTROLLER: Readonly<Record<string, string>> = {
  'home.notice': 'the doctor report is formatted by the controller with `plainGlyphs`',
};

const UNICODE = [...new Set(GLYPH_ROLES.map((role) => GLYPHS[role].glyph))].filter(
  (glyph) => !DRAWN_IN_BOTH.has(glyph),
);

describe.each(ALL_SURFACES.filter((entry) => WRITTEN_BY_THE_CONTROLLER[entry.id] === undefined))(
  '$id draws the plain forms with colour off',
  (entry) => {
    const cells = cellsOf(entry.variants).filter((variant) => !variant.color);
    it.each(
      cells.map((variant) => ({
        name: `${variant.renderer} ${String(variant.size.cols)}x${String(variant.size.rows)}`,
        variant,
      })),
    )('$name', async ({ variant }) => {
      const { observation } = await runCell(entry, variant);
      const drawn = observation.lines.filter((line) =>
        UNICODE.some((glyph) => line.includes(glyph)),
      );
      expect(drawn, 'rows that draw a glyph of the table in its Unicode form').toEqual([]);
    });
  },
);

describe('the surfaces written by the controller are real surfaces of the matrix', () => {
  it('every exemption names a surface that exists', () => {
    const ids = new Set(ALL_SURFACES.map((entry) => entry.id));
    for (const id of Object.keys(WRITTEN_BY_THE_CONTROLLER)) expect(ids.has(id), id).toBe(true);
  });
});
