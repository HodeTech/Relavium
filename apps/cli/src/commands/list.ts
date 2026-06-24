import type { Db, RunRecord } from '@relavium/db';

import { loadResolvedConfig } from '../config/load.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { writeRecordLines } from '../render/records.js';
import { discoverCatalog, type CatalogEntry, type CatalogKind } from '../workflows/catalog.js';
import { openHistoryReader } from '../history/reader.js';

export interface ListCommandArgs {
  /** `--agents`: list the agent catalog instead of the workflow catalog. */
  readonly agents: boolean;
}

export interface ListCommandDeps {
  readonly io: CliIo;
  readonly global: GlobalOptions;
  /** Injectable history-db opener — tests pass an in-memory db; production opens `~/.relavium/history.db`. */
  readonly openDb?: (homeDir: string) => { db: Db; close: () => void };
  /** Injectable catalog scanner — tests pass a fixture catalog without touching the filesystem. */
  readonly discoverCatalog?: typeof discoverCatalog;
}

/** The `--untagged` bucket label in the human grouping (kept distinct from any authored tag by the leading char). */
const UNTAGGED = '(untagged)';

/**
 * The `relavium list` core (**2.I**) — list the workflows (or, with `--agents`, the agents) discovered under the
 * project `.relavium/`, grouped by tag, overlaying each workflow's last-run status from durable history
 * (`loadLatestRunPerWorkflow`, the SQLite `ROW_NUMBER`-per-workflow pick). Disk is the catalog source of truth;
 * the DB only overlays status. Framework-free (no commander/ink). `--json` emits one NDJSON record per entry;
 * a project with no `.relavium/` is reported clearly (exit `0`, an empty catalog is not a fault).
 */
export function listCommand(args: ListCommandArgs, deps: ListCommandDeps): ExitCode {
  const { projectConfigDir, homeDir } = loadResolvedConfig({
    cwd: deps.global.cwd,
    configPath: deps.global.configPath,
  });
  const json = deps.global.json;

  if (projectConfigDir === undefined) {
    // Not in a project — clearly reported (2.B acceptance), not an error. stdout stays pure under --json.
    if (json) {
      deps.io.writeErr(`no .relavium/ project found from ${deps.global.cwd}\n`);
    } else {
      deps.io.writeOut(`No .relavium/ project found from ${deps.global.cwd}.\n`);
    }
    return EXIT_CODES.success;
  }

  const kind: CatalogKind = args.agents ? 'agents' : 'workflows';
  const entries = (deps.discoverCatalog ?? discoverCatalog)({
    projectConfigDir,
    cwd: deps.global.cwd,
    kind,
  });

  // Last-run overlay (workflows only — agents have no runs). Open the read seam only when there is something
  // to overlay, so listing agents (or an empty workflow catalog) never touches the history db.
  const lastBySlug = new Map<string, RunRecord>();
  if (kind === 'workflows' && entries.length > 0) {
    const { reader, close } = openHistoryReader(homeDir, deps.openDb);
    try {
      for (const summary of reader.loadLatestRunPerWorkflow()) {
        lastBySlug.set(summary.slug, summary.lastRun);
      }
    } finally {
      close();
    }
  }

  if (json) {
    writeRecordLines(
      deps.io,
      entries.map((entry) => toJson(entry, kind, lastBySlug.get(entry.slug))),
    );
    return EXIT_CODES.success;
  }

  renderHuman(deps.io, entries, kind, lastBySlug);
  return EXIT_CODES.success;
}

/** One catalog entry as a machine record: identity + path + validity, plus the last-run overlay for workflows. */
function toJson(entry: CatalogEntry, kind: CatalogKind, last: RunRecord | undefined): unknown {
  return {
    kind,
    slug: entry.slug,
    name: entry.name ?? null,
    tags: entry.tags,
    path: entry.path,
    valid: entry.valid,
    ...(entry.error === undefined ? {} : { error: entry.error }),
    ...(kind === 'workflows'
      ? {
          lastRun:
            last === undefined
              ? null
              : {
                  runId: last.id,
                  status: last.status,
                  completedAt: last.completedAt ?? null,
                },
        }
      : {}),
  };
}

/** Render the catalog grouped by tag (workflows) or flat (agents) to a terse, human-readable listing. */
function renderHuman(
  io: CliIo,
  entries: readonly CatalogEntry[],
  kind: CatalogKind,
  lastBySlug: ReadonlyMap<string, RunRecord>,
): void {
  const heading = kind === 'workflows' ? 'Workflows' : 'Agents';
  if (entries.length === 0) {
    io.writeOut(`No ${kind} found under .relavium/${kind}/.\n`);
    return;
  }
  io.writeOut(`${heading} (${entries.length}):\n`);

  if (kind === 'agents') {
    for (const entry of entries) {
      io.writeOut(`  ${entryLine(entry, undefined)}\n`);
    }
    return;
  }

  // Workflows: group by tag (an entry appears under each of its tags; untagged → one bucket), sorted.
  const byTag = new Map<string, CatalogEntry[]>();
  for (const entry of entries) {
    const tags = entry.tags.length > 0 ? entry.tags : [UNTAGGED];
    for (const tag of tags) {
      const bucket = byTag.get(tag) ?? [];
      bucket.push(entry);
      byTag.set(tag, bucket);
    }
  }
  const tags = [...byTag.keys()].sort((a, b) => {
    // Untagged sinks to the bottom; named tags sort alphabetically.
    if (a === UNTAGGED) return 1;
    if (b === UNTAGGED) return -1;
    return a.localeCompare(b);
  });
  for (const tag of tags) {
    const header = tag === UNTAGGED ? UNTAGGED : `#${tag}`;
    io.writeOut(`  ${header}\n`);
    for (const entry of byTag.get(tag) ?? []) {
      // `?? null` so a never-run workflow shows `[last: —]` (undefined would omit the label — agents only).
      io.writeOut(`    ${entryLine(entry, lastBySlug.get(entry.slug) ?? null)}\n`);
    }
  }
}

/** A single catalog line: `slug — name  [last: status]  (invalid: reason)`. `last` is omitted for agents. */
function entryLine(entry: CatalogEntry, last: RunRecord | undefined | null): string {
  const parts = [entry.slug];
  if (entry.name !== undefined && entry.name !== entry.slug) {
    parts.push(`— ${entry.name}`);
  }
  if (last !== undefined) {
    parts.push(`[last: ${last === null ? '—' : last.status}]`);
  }
  if (!entry.valid) {
    const reason = entry.error === undefined ? '' : `: ${entry.error}`;
    parts.push(`(invalid${reason})`);
  }
  return parts.join('  ');
}
