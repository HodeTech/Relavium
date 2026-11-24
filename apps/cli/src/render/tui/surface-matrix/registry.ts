import type { PropertyId } from './properties.js';
import type { Variant } from './variants.js';

/**
 * The registry of the surface matrix ([ADR-0145](../../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §10): one entry
 * per surface of the product that can be mounted with the injection points the hosts already have, each saying how to put it on screen,
 * what marks it as shown, and which key leaves it. Every later step of MVP-11 registers its rows here.
 */

/**
 * A property a surface is KNOWN not to hold today. The matrix expects the failure and FAILS when the property starts holding, so the entry
 * cannot rot into a lie: whoever fixes the surface deletes the entry in the same commit.
 */
export interface KnownFailure {
  readonly property: PropertyId;
  /** What is wrong and where it is owned (a step of MVP-11, a register entry). */
  readonly reason: string;
  /** The cells in which it fails; absent ⇒ every cell the surface is mounted in. In the others the property must hold. */
  readonly where?: ((variant: Variant) => boolean) | undefined;
  /**
   * For a `height` failure: the most lines the surface may draw while it is known to fail. A known failure is not a licence to grow, so a
   * frame taller than this is a problem of its own.
   */
  readonly maxLines?: ((variant: Variant) => number) | undefined;
}

/** What every host's entry says, whatever the host. */
export interface SurfaceBase {
  /** `<host>.<name>`, matching a row of `PRODUCT_SURFACES`. */
  readonly id: string;
  readonly title: string;
  /**
   * The words of the key that leaves the surface and must be on screen (`Esc`, `Ctrl+C`): the least that is true today, so a rewording of
   * the legend by a later step does not break the row.
   */
  readonly exitKey: string;
  /** Text that is on screen only when THIS surface is: the guard against a surface that never opened and a frame that passes by being empty. */
  readonly landmark: string | RegExp;
  /**
   * Words that only the surface's SELECTED row has (a command's name, a model's): the matrix asserts that the last time they were written
   * to the terminal they were bold and inverse, in every cell, colour off included (ADR-0145 §5: the selection is the marker AND an inverse
   * row, because the marker alone cannot tell a selected row from the prompt). Absent for a surface that draws no selection.
   */
  readonly selectedRow?: string | undefined;
  /**
   * What the surface does below the floor (60×20): a pattern its below-floor text matches (the default is the Home's "too small" notice and
   * the sheets' "enlarge the terminal"), or `'renders'` for a surface that draws normally there and keeps every property, exit key included.
   */
  readonly belowFloor?: RegExp | 'renders' | undefined;
  /** The cells to mount in, when it is not all of them (a surface that exists in one renderer only). Absent ⇒ every cell. */
  readonly variants?: ((variant: Variant) => boolean) | undefined;
  readonly knownFailure?: KnownFailure | readonly KnownFailure[] | undefined;
  readonly notes?: string | undefined;
}

export const knownFailuresOf = (entry: SurfaceBase): readonly KnownFailure[] => {
  const known = entry.knownFailure;
  if (known === undefined) return [];
  return 'property' in known ? [known] : known;
};

/** The notice a surface is expected to show below the floor unless it says otherwise. */
export const DEFAULT_BELOW_FLOOR = /too small|nlarge the terminal/iu;
