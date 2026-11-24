import {
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
  raw: () => string;
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
  });
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
