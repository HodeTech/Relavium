import { lstatSync } from 'node:fs';

import type { RunStatus } from '@relavium/shared';

import { commitExport, prepareExport, type ExportPlan } from '../commands/export.js';
import { assertProjectArtifactPath } from '../config/project-directory.js';
import {
  buildDefinedModel,
  type DefinedOtherPin,
  type DefinedPin,
} from '../history/defined-model.js';
import { isCliError } from '../process/errors.js';
import type { GlobalOptions } from '../process/options.js';
import type { DisplayPathRoots } from '../render/notation.js';
import { sanitizeUntrustedInline } from '../render/sanitize.js';
import {
  type ExportAttempt,
  type ExportPort,
  type ExportPrepared,
} from '../render/tui/export-card.js';
import type { DefinedPort } from '../render/tui/tab-host-workflows.js';
import type { LaunchCatalog } from './run-launch.js';

/**
 * What the Home's Defined tab and its export card read and write, over the project the Home is in
 * ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md) §2, MVP-8 step 4).
 * Both are thin: the tab's rows are `buildDefinedModel` over the catalog and the pins, and the export is `relavium export`'s own
 * {@link prepareExport} and {@link commitExport}, so the card writes exactly the bytes and to exactly the place the command would.
 */

/** One catalog read and one pins read per tab entry, behind ports so a test needs neither a project directory nor a database. */
export interface DefinedPortDeps {
  /** The project's workflow files; the launch flow's own catalog, so the tab lists what `r` can run. May throw a CliError. */
  readonly catalog: Pick<LaunchCatalog, 'list'>;
  /** The project's workflow pins, newest first (`listPins({ kind: 'workflow', projectRoot })`). May throw. */
  readonly pins: () => readonly DefinedPin[];
  /**
   * EVERY pin the store holds, of either kind and any project (`listPins()`): the store caps the pins in total, so the tab lists the
   * workflow pins of other projects as rows it can remove, and names the stored total when a pin is refused at the cap. Absent ⇒ the tab
   * knows only this project's pins. May throw.
   */
  readonly allPins?: (() => readonly (DefinedPin & { readonly projectRoot: string })[]) | undefined;
  /** The status of each workflow's latest run in this project, by slug (`loadLatestRunPerWorkflowInProject`). May throw. Absent ⇒ none is shown. */
  readonly lastRuns?: (() => ReadonlyMap<string, RunStatus>) | undefined;
  /** What another project's root is shortened against. Absent, the root is listed as stored. */
  readonly paths?: DisplayPathRoots | undefined;
}

/** The Defined tab's read: the catalog and the pins, read now, as rows that name their entries by index. */
export function createDefinedPort(deps: DefinedPortDeps): DefinedPort {
  return {
    read: () => {
      const entries = deps.catalog.list();
      const pins = deps.pins();
      const lastRuns = deps.lastRuns?.();
      const all = deps.allPins?.();
      // A workflow pin of this project is already listed; any other workflow pin belongs to another project (or to one that is gone).
      const mine = new Set(pins.map((pin) => pin.rowid));
      const otherPins: readonly DefinedOtherPin[] =
        all?.filter((pin) => pin.kind === 'workflow' && !mine.has(pin.rowid)) ?? [];
      const model = buildDefinedModel({
        entries,
        pins,
        otherPins,
        ...(deps.paths === undefined ? {} : { paths: deps.paths }),
        ...(lastRuns === undefined ? {} : { lastRuns }),
      });
      // The entries are held by the read, so a row's index names the entry that was listed and not whatever sits there later.
      return {
        model,
        slugOf: (entryIndex) => entries[entryIndex]?.slug,
        pathOf: (entryIndex) => entries[entryIndex]?.path,
        ...(all === undefined
          ? {}
          : {
              stored: {
                total: all.length,
                elsewhere: all.length - pins.length,
              },
            }),
      };
    },
  };
}

export interface ExportPortDeps {
  readonly global: GlobalOptions;
  /** The operator home the path rules read; the Home's own, so nothing falls back to the process's. */
  readonly homeDir: string;
}

/** The longest reason a refusal shows, in code units: a CliError's message can quote a path. */
const REASON_LIMIT = 240;

/** The sentence for a refusal the command itself raised (a `CliError`), bounded and sanitized; none for any other fault. Shared with the import card's port. */
export function reasonOf(cause: unknown): string | undefined {
  if (!isCliError(cause)) return undefined;
  const text = sanitizeUntrustedInline(cause.message);
  return text.length <= REASON_LIMIT ? text : `${text.slice(0, REASON_LIMIT - 1)}…`;
}

/** Whether something already sits at the destination, whatever it is (a link included). A path that cannot be read counts as not there. */
function occupied(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * What the Home says for a write the file system refused, by the errno the write failed with. The sentences are fixed: a raw errno's
 * message quotes the path it failed on, and the card must neither echo that path nor leave a person's home on a cause they cannot act
 * on. `relavium export` keeps its own behaviour (it lets these propagate); only the card turns them into a refusal.
 */
const WRITE_FAULT_REASONS: ReadonlyMap<string, string> = new Map([
  ['EACCES', 'The file could not be written: permission denied.'],
  ['EPERM', 'The file could not be written: permission denied.'],
  ['EROFS', 'The file could not be written: the file system is read-only.'],
  ['ENOSPC', 'The file could not be written: no space is left on the device.'],
  ['EDQUOT', 'The file could not be written: no space is left on the device.'],
  ['EMFILE', 'The file could not be written: too many files are open.'],
  ['ENFILE', 'The file could not be written: too many files are open.'],
  ['EIO', 'The file could not be written: the write failed (I/O error).'],
]);

/** The fixed sentence for a write that failed with one of the file system's own refusals; none for any other fault (a bug ends the Home). Shared with the import card's port. */
export function writeFaultReasonOf(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return undefined;
  const code: unknown = cause.code;
  return typeof code === 'string' ? WRITE_FAULT_REASONS.get(code) : undefined;
}

function commitOf(plan: ExportPlan, deps: ExportPortDeps): () => ExportAttempt {
  return () => {
    try {
      // The rule about global state, asked again now as the import card's commit asks it: the card stayed open for as long as a person
      // took, and a link put in the working directory since would send the write into home or global configuration. The shell's
      // check-to-write gap is microseconds; this one is not, so it is closed here by looking again right before the write. (The card's
      // destination is always the default one, never `--out`, so the rule the shell applies to it applies here.)
      assertProjectArtifactPath(plan.target, deps.homeDir);
      commitExport(plan);
    } catch (cause) {
      // A fault the person can act on is a refusal, not the end of the Home: an unwritable directory is the destination's, not ours.
      const reason = reasonOf(cause) ?? writeFaultReasonOf(cause);
      // Anything else is a defect, and an unclassified fault ends the Home (ADR-0139).
      if (reason === undefined) throw cause;
      return { ok: false, reason };
    }
    return {
      ok: true,
      written: `Exported ${plan.kind} '${sanitizeUntrustedInline(plan.slug)}' to ${sanitizeUntrustedInline(plan.targetDisplay)}.`,
    };
  };
}

/**
 * The export card's port. `prepare` is the command's own prepare step with `--force` off, so a refusal is the command's refusal, in
 * its words; and it refuses a destination that already exists before the card asks, since the card never overwrites.
 */
export function createExportPort(deps: ExportPortDeps): ExportPort {
  return {
    prepare: (slug): ExportPrepared => {
      let plan: ExportPlan;
      try {
        plan = prepareExport(
          { id: slug, force: false },
          { global: deps.global, homeDir: deps.homeDir },
        );
      } catch (cause) {
        const reason = reasonOf(cause);
        if (reason === undefined) throw cause;
        return { ok: false, reason };
      }
      const destination = sanitizeUntrustedInline(plan.targetDisplay);
      if (occupied(plan.target))
        return {
          ok: false,
          reason: `${destination} already exists, and this card never overwrites. Use relavium export ${sanitizeUntrustedInline(plan.slug)} --force to replace it.`,
        };
      return {
        ok: true,
        offer: { kind: plan.kind, slug: plan.slug, destination, bytes: plan.bytes },
        commit: commitOf(plan, deps),
      };
    },
  };
}
