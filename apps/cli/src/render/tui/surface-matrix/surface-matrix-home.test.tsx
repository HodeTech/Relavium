import '../force-color.js';

import { describe, expect, it } from 'vitest';

import { cellTable, checkCell } from './matrix-test-kit.js';
import { HOME_SURFACES } from './surfaces-home.js';

/**
 * The surface matrix, Home half ([ADR-0145](../../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §10): every surface of
 * the bare Home in every variant (the renderer, colour on and off, 80×24 and 100×30, and 60×20 below the floor), each cell one test so that a
 * failure names the surface and the cell and the default 5 s timeout bounds one mount, not the table.
 */
describe.each(HOME_SURFACES)('$id', (entry) => {
  it.each(cellTable(entry))('$name', async ({ variant }) => {
    const { problems, frame } = await checkCell(entry, variant);
    expect(problems, frame).toEqual([]);
  });
});
