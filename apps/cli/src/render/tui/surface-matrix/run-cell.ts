import type { DOMElement } from 'ink';

import type { PopupFrame } from '../../../popups/popup-reducer.js';

import { baselineCellsOf, baselineOf } from './popup-fixture.js';
import {
  checkBackdropDim,
  checkOverlayLayer,
  checkPopupBox,
  checkProperties,
  liveLines,
  type Observation,
  type PopupBox,
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
  /** How many of the frame's first rows Ink printed once through `<Static>` (scrollback, not the live frame); absent ⇒ none. */
  staticRows?: () => number;
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

/** What a popup's box asks of a cell: its own rows over an unchanged body (`popup-box`), and the backdrop dimmed behind it (`backdrop-dim`). */
function popupViolations(
  mount: Observable,
  observation: Observation,
  box: PopupBox,
  bodyHasNoInverse: boolean,
): Violation[] {
  const before = baselineOf(mount);
  if (before === undefined)
    return [
      {
        property: 'popup-box',
        message: 'the surface recorded no frame before it opened the popup',
      },
    ];
  const violations = checkPopupBox(observation, before, box);
  // How the body looks behind the popup: every cell of it dim (alternate screen, colour on), none dimmed by us otherwise (ADR-0148 §4).
  const cellsBefore = baselineCellsOf(mount);
  const cellsNow = mount.cells?.();
  if (cellsBefore !== undefined && cellsNow !== undefined)
    violations.push(
      ...checkBackdropDim({
        variant: mount.variant,
        before: cellsBefore,
        now: cellsNow,
        box,
        bodyHasNoInverse,
      }),
    );
  return violations;
}

/** Whether the surface is what is shown (its landmark) or, below the floor, whether the notice is. */
function shownViolations(entry: SurfaceBase, text: string, below: boolean): Violation[] {
  if (below) {
    const expected = entry.belowFloor ?? DEFAULT_BELOW_FLOOR;
    return matches(text, expected)
      ? []
      : [
          {
            property: 'surface-shown',
            message: `below the floor the frame should hold ${String(expected)}`,
          },
        ];
  }
  return matches(text, entry.landmark)
    ? []
    : [
        {
          property: 'surface-shown',
          message: `the surface is not on screen: ${String(entry.landmark)} is not in the frame`,
        },
      ];
}

/**
 * Check one cell of one surface once it is open: the five properties over what the terminal shows and was sent, and whether the surface
 * is what is shown (its landmark) or, below the floor, whether the notice is.
 */
export function observe(entry: SurfaceBase, mount: Observable): CellResult {
  const { variant } = mount;
  const observation: Observation = {
    variant,
    lines: mount.frame(),
    raw: mount.raw(),
    staticRows: mount.staticRows?.() ?? 0,
  };
  const text = observation.lines.join('\n');
  const below = isBelowFloor(variant) && entry.belowFloor !== 'renders';
  // A popup's box is read before the properties, because the legend row of a popup is read in it.
  const box =
    entry.popup !== undefined && !below
      ? entry.popup(variant, mount.popupFrame?.(), mount.popupLocked?.() === true)
      : undefined;
  const violations: Violation[] = checkProperties(observation, {
    exitKey: below ? undefined : entry.exitKey,
    selectedRow: below ? undefined : entry.selectedRow,
    legendRow: below ? undefined : entry.legendRow,
    popupBox: box,
  });
  // The overlay layer holds the popup's slot and nothing else, in every cell of every surface (ADR-0148 §2): a popup in the alternate screen
  // is the one absolutely positioned node (its notice too, below the floor); inline it is a block in the flow and nothing is absolute.
  violations.push(
    ...checkOverlayLayer(mount.root?.(), entry.popup !== undefined && variant.renderer === 'alt'),
  );
  // A declaration counts only with a reason: an empty or blank one is no declaration (`SurfaceBase.backdropHasNoInverse`).
  const declaredNoInverse = (entry.backdropHasNoInverse ?? '').trim().length > 0;
  if (box !== undefined)
    violations.push(...popupViolations(mount, observation, box, declaredNoInverse));
  violations.push(...shownViolations(entry, text, below));
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
    const lines = liveLines(result.observation).length;
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

/**
 * The frame, numbered, for the message of a failing cell. The rows Ink printed once through `<Static>` are named, so a reader knows which of
 * the numbered rows are scrollback (not counted in the height, not part of a popup's live region) and which are the live frame.
 */
export function describeFrame(result: CellResult): string {
  const { lines } = result.observation;
  const numbered = lines.map((line, index) => `${String(index + 1).padStart(2)}│${line}`);
  const scrollback = lines.length - liveLines(result.observation).length;
  return scrollback === 0
    ? numbered.join('\n')
    : [
        `(rows 1–${String(scrollback)} were printed once through <Static>: scrollback, not the live frame)`,
        ...numbered,
      ].join('\n');
}
