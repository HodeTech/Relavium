import { lstatSync } from 'node:fs';

import type { RunStatus } from '@relavium/shared';

import { commitExport, prepareExport, type ExportPlan } from '../commands/export.js';
import { buildDefinedModel, type DefinedPin } from '../history/defined-model.js';
import { isCliError } from '../process/errors.js';
import type { GlobalOptions } from '../process/options.js';
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
  /** The status of each workflow's latest run in this project, by slug (`loadLatestRunPerWorkflowInProject`). May throw. Absent ⇒ none is shown. */
  readonly lastRuns?: (() => ReadonlyMap<string, RunStatus>) | undefined;
}

/** The Defined tab's read: the catalog and the pins, read now, as rows that name their entries by index. */
export function createDefinedPort(deps: DefinedPortDeps): DefinedPort {
  return {
    read: () => {
      const entries = deps.catalog.list();
      const pins = deps.pins();
      const lastRuns = deps.lastRuns?.();
      const model = buildDefinedModel({
        entries,
        pins,
        ...(lastRuns === undefined ? {} : { lastRuns }),
      });
      // The entries are held by the read, so a row's index names the entry that was listed and not whatever sits there later.
      return { model, slugOf: (entryIndex) => entries[entryIndex]?.slug };
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

function reasonOf(cause: unknown): string | undefined {
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

function commitOf(plan: ExportPlan): () => ExportAttempt {
  return () => {
    try {
      commitExport(plan);
    } catch (cause) {
      const reason = reasonOf(cause);
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
        commit: commitOf(plan),
      };
    },
  };
}
