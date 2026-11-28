import { describe, expect, it } from 'vitest';

import { ALL_SURFACES } from './all-surfaces.js';
import { NOT_COVERED_YET, PRODUCT_SURFACES } from './product-surfaces.js';
import { knownFailuresOf } from './registry.js';

/**
 * The matrix is only a safety net if nothing slips past it. Every surface of the product (the hand-kept table) is mounted by the matrix or
 * is on the shrinking `NOT_COVERED_YET` list with the seam it lacks; a surface that is neither fails here, and so does one that is both, so
 * the list cannot keep a surface that is now covered. A later step registers its surfaces in the same commit that adds them.
 */
describe('the surface matrix is complete', () => {
  const productIds = PRODUCT_SURFACES.map((surface) => surface.id);
  const registered = ALL_SURFACES.map((surface) => surface.id);
  const listed = Object.keys(NOT_COVERED_YET);

  it('names every surface of the product once', () => {
    expect(productIds.length, 'no duplicate row').toBe(new Set(productIds).size);
    expect(registered.length, 'no duplicate registration').toBe(new Set(registered).size);
  });

  it('every row of the product is mounted or listed with its reason', () => {
    const neither = productIds.filter((id) => !registered.includes(id) && !listed.includes(id));
    expect(neither, 'surfaces that are neither registered nor in NOT_COVERED_YET').toEqual([]);
  });

  it('a surface that is mounted is not still on the list of those that are not', () => {
    const both = registered.filter((id) => listed.includes(id));
    expect(both, 'registered AND listed as not covered: remove it from NOT_COVERED_YET').toEqual(
      [],
    );
  });

  it('nothing is registered or listed that the product table does not name', () => {
    expect(registered.filter((id) => !productIds.includes(id))).toEqual([]);
    expect(listed.filter((id) => !productIds.includes(id))).toEqual([]);
  });

  it('every reason says which seam is missing', () => {
    for (const [id, reason] of Object.entries(NOT_COVERED_YET)) {
      expect(reason.length, id).toBeGreaterThan(30);
    }
  });

  it('every entry names its exit key and a landmark, and its id begins with its host', () => {
    for (const entry of ALL_SURFACES) {
      expect(entry.id.startsWith(`${entry.host}.`), entry.id).toBe(true);
      expect(entry.exitKey, entry.id).not.toBe('');
      expect(String(entry.landmark), entry.id).not.toBe('');
    }
  });

  it('every known failure says what is wrong and who owns it', () => {
    for (const entry of ALL_SURFACES) {
      for (const failure of knownFailuresOf(entry)) {
        expect(failure.reason.length, `${entry.id}: ${failure.property}`).toBeGreaterThan(30);
      }
    }
  });
});
