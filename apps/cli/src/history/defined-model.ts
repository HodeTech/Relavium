import type { RunStatus } from '@relavium/shared';

import type { DisplayPathRoots } from '../render/notation.js';
import type { CatalogEntry } from '../workflows/catalog.js';
import { RUN_STATUS_GLYPH, storedPlace } from './history-model.js';
import { scrubbedBounded } from './run-detail-model.js';

/**
 * The pure view model of the Home's Defined tab (ADR-0140 §2, "Defined"; MVP-8 step 4): the workflows the project
 * declares on disk, with the pins the operator made on them. Nothing is read or written here. The caller reads the
 * catalog (`discoverCatalog`), the project's workflow pins (`listPins({ kind: 'workflow', projectRoot })`, which
 * the store keys by the project's real path) and the latest run per workflow, and hands them in; every free-form
 * string leaves through the sanitize floor.
 *
 * - **Pinned rows first**, in the order the pins came (newest pin first, as the store lists them); then the rest in
 *   the catalog's own order, each marked `unpinned`. Every state has a word as well as a glyph, never colour alone.
 * - **A pin whose slug is no longer in the catalog stays**, as a row marked "not in catalog": the file was renamed,
 *   moved or deleted, and a pin that vanished from the list with it could never be removed. Its pin row id is the
 *   handle that removes it.
 * - **A pin of another project stays too**, as a row marked "other project" after this project's pins: the store caps pins
 *   in total, across every project, so a pin this tab did not list would hold one of the fifty slots with no way to remove
 *   it from here. It can be neither run nor exported, and `p` on its row removes it by its row id.
 * - **Bounded**: at most {@link DEFINED_ROWS_MAX} rows, pinned rows first so a cut never takes a pin, with the rest
 *   counted as "N more".
 * - **A ref is text and nothing else.** It comes from `history.db`, which accepts any string, so it is a label to
 *   show: it is never joined into a path, never looked up on disk and never a key to anything but the catalog map.
 *   A catalog row's path is the one `discoverCatalog` read it from, passed through; a pin that matches no entry has none.
 */

/** The most rows the tab holds; the rest are counted, not drawn. */
export const DEFINED_ROWS_MAX = 200;

/** What a pin whose workflow is not in the catalog says. */
export const NOT_IN_CATALOG = 'not in catalog';

/** What a pin of another project (or of a project that is gone) says. */
export const OTHER_PROJECT = 'pinned in another project';

/** The longest catalog file path or error a row shows, in code points. */
const MAX_DETAIL_CHARS = 256;

/** The pin word of a row: always spoken, because a row that is not pinned must say so as plainly as one that is. */
export type DefinedPinWord = 'pinned' | 'unpinned';

/**
 * `ready`: a catalog entry that parsed. `invalid`: a catalog file that did not (shown, never hidden). `not-in-catalog`:
 * a pin whose slug no entry carries. `other-project`: a workflow pin keyed by a project this Home is not in.
 */
export type DefinedRowState = 'ready' | 'invalid' | 'not-in-catalog' | 'other-project';

/** The catalog fields the tab reads. A {@link CatalogEntry} satisfies it. */
export type DefinedEntry = Pick<
  CatalogEntry,
  'slug' | 'name' | 'nodeCount' | 'path' | 'valid' | 'error'
>;

/**
 * The pin fields the tab reads, so the model does not depend on the store's own type: a `PinRecord` satisfies it.
 * A pin whose `oversized` is true carries a PREVIEW of its ref, which is not a key and matches no catalog slug.
 */
export interface DefinedPin {
  readonly kind: 'run' | 'workflow';
  readonly ref: string;
  /** The store's row id, the handle `unpinByRow` removes the pin by. */
  readonly rowid: number;
  readonly oversized: boolean;
}

/** A workflow pin of another project: a {@link DefinedPin} with the project it is keyed by (a preview when `oversized`). */
export interface DefinedOtherPin extends DefinedPin {
  readonly projectRoot: string;
}

export interface DefinedRow {
  readonly state: DefinedRowState;
  /** The slug as a label: the sanitize floor and a bound, never a key and never a path. */
  readonly slug: string;
  /**
   * Where the row's entry sits in {@link DefinedModelInput.entries}: present only on a catalog row. It is a number on
   * purpose, so no row carries a raw slug (the key that pins or runs the entry, which is text from a file in the
   * project): the caller reads `entries[entryIndex].slug` for the key and every string of a row stays sanitized.
   */
  readonly entryIndex?: number;
  readonly name?: string;
  /** Present on a `ready` row whose entry carried a count. */
  readonly nodeCount?: number;
  /** The status of the workflow's latest run in this project, when one is known. */
  readonly lastRunStatus?: RunStatus;
  readonly lastRunGlyph?: string;
  /** When that latest run was last written (an ISO time, the store's `updated_at`): its age, and for a parked run how long it has waited. */
  readonly lastRunAt?: string;
  /** The catalog file the entry was read from, as `discoverCatalog` returned it; absent on a `not-in-catalog` row. */
  readonly path?: string;
  /** Why the row is not plain: the parse error of an `invalid` row, {@link NOT_IN_CATALOG} for a pin with no entry, {@link OTHER_PROJECT}. */
  readonly note?: string;
  /** The project an `other-project` row's pin is keyed by, sanitized and bounded; absent on every other row. */
  readonly projectRoot?: string;
  readonly pinned: boolean;
  readonly pinWord: DefinedPinWord;
  /** The pin's row id: the way to remove the pin, present exactly when the row is pinned. */
  readonly pinRowid?: number;
  /** `true` when the pin's text was over its bound, so {@link DefinedRow.slug} is a preview that ends with `…`. */
  readonly pinOversized?: boolean;
}

/** What the host reads when `/workflows` opens: the rows, and the slug and the path each catalog row stands for. */
export interface DefinedRead {
  readonly model: DefinedModel;
  /** The slug of the catalog entry a row's `entryIndex` names, or `undefined` when no entry sits at that index. */
  readonly slugOf: (entryIndex: number) => string | undefined;
  /**
   * The catalog path of that same entry, as the catalog read it (the raw path, not the row's sanitized label), or `undefined` when no entry
   * sits there. A `run` request carries it, so the launch can refuse when the file that holds the slug is no longer this one.
   */
  readonly pathOf: (entryIndex: number) => string | undefined;
}

/** The catalogue's read, behind a port so the popup is testable without a project or a database. May throw: the popup then says it cannot list. */
export interface DefinedPort {
  readonly read: () => DefinedRead;
}

export interface DefinedModel {
  /** At most {@link DEFINED_ROWS_MAX} rows, pinned first. */
  readonly rows: readonly DefinedRow[];
  /** How many rows the bound left out. */
  readonly more: number;
  /** `"N more"` when {@link DefinedModel.more} is above zero. */
  readonly moreText?: string;
  /** Every row there is: `rows.length + more`. */
  readonly total: number;
}

export interface DefinedModelInput {
  /** The project's catalog entries, as `discoverCatalog` returned them (sorted by slug). */
  readonly entries: readonly DefinedEntry[];
  /**
   * The project's workflow pins, newest first, as `listPins({ kind: 'workflow', projectRoot })` returns them. One pin
   * per ref is expected (the store's key allows no more under one root); a pin of another kind is ignored.
   */
  readonly pins: readonly DefinedPin[];
  /** The store's workflow pins keyed by another project, newest first: listed after this project's pins, removable by their row. */
  readonly otherPins?: readonly DefinedOtherPin[];
  /** Workflow slug to the status of its latest run in this project. */
  readonly lastRuns?: ReadonlyMap<string, RunStatus>;
  /** Workflow slug to when that latest run was last written (an ISO time); absent for a slug the map does not hold. */
  readonly lastRunTimes?: ReadonlyMap<string, string>;
  /** What another project's root is shortened against (the Home's directory and the operator's home); absent, the root is shown as stored. */
  readonly paths?: DisplayPathRoots;
}

interface Ranked {
  /** Pinned rows rank by their pin's position; the others follow, by their position in the catalog. */
  readonly rank: number;
  readonly row: DefinedRow;
}

function lastRunOf(
  slug: string,
  lastRuns: ReadonlyMap<string, RunStatus> | undefined,
  lastRunTimes?: ReadonlyMap<string, string>,
): Pick<DefinedRow, 'lastRunStatus' | 'lastRunGlyph' | 'lastRunAt'> {
  const status = lastRuns?.get(slug);
  if (status === undefined) return {};
  const at = lastRunTimes?.get(slug);
  return {
    lastRunStatus: status,
    lastRunGlyph: RUN_STATUS_GLYPH[status],
    ...(at === undefined ? {} : { lastRunAt: at }),
  };
}

function pinPart(pin: DefinedPin | undefined): Pick<DefinedRow, 'pinned' | 'pinWord' | 'pinRowid'> {
  return pin === undefined
    ? { pinned: false, pinWord: 'unpinned' }
    : { pinned: true, pinWord: 'pinned', pinRowid: pin.rowid };
}

function catalogRow(
  entry: DefinedEntry,
  entryIndex: number,
  pin: DefinedPin | undefined,
  lastRuns: ReadonlyMap<string, RunStatus> | undefined,
  lastRunTimes: ReadonlyMap<string, string> | undefined,
): DefinedRow {
  const count = entry.nodeCount;
  return {
    state: entry.valid ? 'ready' : 'invalid',
    slug: scrubbedBounded(entry.slug),
    entryIndex,
    ...(entry.name === undefined ? {} : { name: scrubbedBounded(entry.name) }),
    // A count belongs to a workflow that parsed; a refused file has no document to count.
    ...(entry.valid && count !== undefined && Number.isSafeInteger(count) && count >= 0
      ? { nodeCount: count }
      : {}),
    ...(entry.valid ? lastRunOf(entry.slug, lastRuns, lastRunTimes) : {}),
    path: scrubbedBounded(entry.path, MAX_DETAIL_CHARS),
    ...(entry.valid
      ? {}
      : { note: scrubbedBounded(entry.error ?? 'could not be read', MAX_DETAIL_CHARS) }),
    ...pinPart(pin),
  };
}

function missingRow(
  pin: DefinedPin,
  lastRuns: ReadonlyMap<string, RunStatus> | undefined,
): DefinedRow {
  return {
    state: 'not-in-catalog',
    // A preview is not the whole text, so it says so; the label is the only thing the ref is ever used for.
    slug: pin.oversized ? `${scrubbedBounded(pin.ref)}…` : scrubbedBounded(pin.ref),
    // A cut ref names no workflow, so no run is looked up under it.
    ...(pin.oversized ? {} : lastRunOf(pin.ref, lastRuns)),
    note: NOT_IN_CATALOG,
    ...pinPart(pin),
    ...(pin.oversized ? { pinOversized: true } : {}),
  };
}

function otherProjectRow(pin: DefinedOtherPin, paths: DisplayPathRoots | undefined): DefinedRow {
  return {
    state: 'other-project',
    slug: pin.oversized ? `${scrubbedBounded(pin.ref)}…` : scrubbedBounded(pin.ref),
    note: OTHER_PROJECT,
    // Named as every tab names a directory (project-relative, from ~ or in words, never an absolute path inside either), scrubbed and bounded: the root is stored text.
    projectRoot: storedPlace(pin.projectRoot, paths, MAX_DETAIL_CHARS),
    ...pinPart(pin),
    ...(pin.oversized ? { pinOversized: true } : {}),
  };
}

/**
 * The Defined tab: the catalog's rows with their pins, a row for each pin the catalog no longer carries and for each pin of
 * another project, pinned first, bounded at {@link DEFINED_ROWS_MAX}.
 */
export function buildDefinedModel(input: DefinedModelInput): DefinedModel {
  const pins = input.pins.filter((pin) => pin.kind === 'workflow');
  // Which pin a catalog slug is pinned by: the first of its ref, and never an over-long one (its ref is a preview).
  const pinIndexBySlug = new Map<string, number>();
  pins.forEach((pin, index) => {
    if (!pin.oversized && !pinIndexBySlug.has(pin.ref)) pinIndexBySlug.set(pin.ref, index);
  });
  const slugs = new Set(input.entries.map((entry) => entry.slug));
  const otherPins = (input.otherPins ?? []).filter((pin) => pin.kind === 'workflow');
  // This project's pins rank first, then the other projects' (a pin never falls behind an unpinned row), then the unpinned catalog rows.
  const unpinnedBase = pins.length + otherPins.length;

  const ranked: Ranked[] = [];
  input.entries.forEach((entry, index) => {
    const pinIndex = pinIndexBySlug.get(entry.slug);
    ranked.push({
      rank: pinIndex ?? unpinnedBase + index,
      row: catalogRow(
        entry,
        index,
        pinIndex === undefined ? undefined : pins[pinIndex],
        input.lastRuns,
        input.lastRunTimes,
      ),
    });
  });
  pins.forEach((pin, index) => {
    // A pin the catalog carries is already on its entry's row.
    if (!pin.oversized && slugs.has(pin.ref)) return;
    ranked.push({ rank: index, row: missingRow(pin, input.lastRuns) });
  });
  otherPins.forEach((pin, index) => {
    ranked.push({ rank: pins.length + index, row: otherProjectRow(pin, input.paths) });
  });
  ranked.sort((a, b) => a.rank - b.rank);

  const rows = ranked.slice(0, DEFINED_ROWS_MAX).map((item) => item.row);
  const more = ranked.length - rows.length;
  return {
    rows,
    more,
    ...(more > 0 ? { moreText: `${String(more)} more` } : {}),
    total: ranked.length,
  };
}
