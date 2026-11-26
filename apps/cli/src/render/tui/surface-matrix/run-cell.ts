import type { DOMElement } from 'ink';

import type { PopupFrame } from '../../../popups/popup-reducer.js';

import { baselineCellsOf, baselineOf } from './popup-fixture.js';
import {
  checkBackdropDim,
  checkOverlayLayer,
  checkPopupBox,
  checkProperties,
  type Observation,
  type PropertyId,
  type Violation,
} from './properties.js';
import {
  DEFAULT_BELOW_FLOOR,
  knownFailuresOf,
  type KnownFailure,
  type SurfaceBase,
} from './registry.js';
import type { ScreenCell } from './terminal.js';
import { isBelowFloor, type Variant } from './variants.js';

/** What a cell found: the observation, every violation of every property, and the frame for a failure message. */
export interface CellResult {
  readonly observation: Observation;
  readonly violations: readonly Violation[];
}

/** The part of a mounted surface the checks read; every host's mount has it. */
export interface Observable {
  readonly variant: Variant;
  frame: () => string[];
  /** The rows with each cell's style, for the backdrop-dim property; absent ⇒ not asserted. */
  cells?: () => ScreenCell[][];
  raw: () => string;
  /** Ink's root node, for the overlay-layer property; absent ⇒ not asserted. */
  root?: () => DOMElement | undefined;
  /** The popup the host has open now, for a product popup's box. */
  popupFrame?: () => PopupFrame | undefined;
  /**
   * Whether the host's popup holds its answer locked now (`PopupHost.lock`): the slot draws that legend part as waiting (`(wait)`), so the
   * expected box is drawn with the same lock. Absent ⇒ open.
   */
  popupLocked?: () => boolean;
}

const matches = (text: string, pattern: string | RegExp): boolean =>
  typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);

/**
 * Check one cell of one surface once it is open: the five properties over what the terminal shows and was sent, and whether the surface
 * is what is shown (its landmark) or, below the floor, whether the notice is.
 */
export function observe(entry: SurfaceBase, mount: Observable): CellResult {
  const { variant } = mount;
  const observation: Observation = { variant, lines: mount.frame(), raw: mount.raw() };
  const text = observation.lines.join('\n');
  const below = isBelowFloor(variant) && entry.belowFloor !== 'renders';
  const violations: Violation[] = checkProperties(observation, {
    exitKey: below ? undefined : entry.exitKey,
    selectedRow: below ? undefined : entry.selectedRow,
    legendRow: below ? undefined : entry.legendRow,
  });
  // The overlay layer holds the popup's slot and nothing else, in every cell of every surface (ADR-0148 §2): a popup in the alternate screen
  // is the one absolutely positioned node (its notice too, below the floor); inline it is a block in the flow and nothing is absolute.
  violations.push(
    ...checkOverlayLayer(mount.root?.(), entry.popup !== undefined && variant.renderer === 'alt'),
  );
  if (entry.popup !== undefined && !below) {
    const before = baselineOf(mount);
    if (before === undefined)
      violations.push({
        property: 'popup-box',
        message: 'the surface recorded no frame before it opened the popup',
      });
    else {
      const box = entry.popup(variant, mount.popupFrame?.(), mount.popupLocked?.() === true);
      violations.push(...checkPopupBox(observation, before, box));
      // How the body looks behind the popup: every cell of it dim (alternate screen, colour on), none dimmed by us otherwise (ADR-0148 §4).
      const cellsBefore = baselineCellsOf(mount);
      const cellsNow = mount.cells?.();
      if (cellsBefore !== undefined && cellsNow !== undefined)
        violations.push(...checkBackdropDim({ variant, before: cellsBefore, now: cellsNow, box }));
    }
  }
  if (below) {
    const expected = entry.belowFloor ?? DEFAULT_BELOW_FLOOR;
    if (!matches(text, expected)) {
      violations.push({
        property: 'surface-shown',
        message: `below the floor the frame should hold ${String(expected)}`,
      });
    }
  } else if (!matches(text, entry.landmark)) {
    violations.push({
      property: 'surface-shown',
      message: `the surface is not on screen: ${String(entry.landmark)} is not in the frame`,
    });
  }
  return { observation, violations };
}

/**
 * The problems of one cell, as a list a test asserts empty: every violation that no known failure covers, and every known failure that did
 * not fail (it was fixed, or it never failed here, and the entry must go so it cannot rot).
 */
export function problemsOf(entry: SurfaceBase, result: CellResult): string[] {
  const { variant } = result.observation;
  const known = knownFailuresOf(entry);
  const expectedHere = (failure: KnownFailure): boolean =>
    failure.where === undefined || failure.where(variant);
  const expectedProperties = new Set<PropertyId>(known.filter(expectedHere).map((f) => f.property));
  const problems: string[] = [];
  for (const violation of result.violations) {
    if (!expectedProperties.has(violation.property)) {
      problems.push(`${violation.property}: ${violation.message}`);
    }
  }
  for (const failure of known.filter(expectedHere)) {
    const lines = result.observation.lines.length;
    if (failure.maxLines !== undefined && lines > failure.maxLines(variant)) {
      problems.push(
        `height: ${String(lines)} lines is more than the ${String(failure.maxLines(variant))} the known failure allows (${failure.reason})`,
      );
    }
    if (!result.violations.some((violation) => violation.property === failure.property)) {
      problems.push(
        `the known failure of "${failure.property}" (${failure.reason}) no longer fails here: remove it from the entry`,
      );
    }
  }
  return problems;
}

/** The frame, numbered, for the message of a failing cell. */
export function describeFrame(result: CellResult): string {
  return result.observation.lines
    .map((line, index) => `${String(index + 1).padStart(2)}│${line}`)
    .join('\n');
}
