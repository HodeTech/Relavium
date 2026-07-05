import type { ModelCatalogListing } from '@relavium/db';

import type {
  ModelRefreshService,
  RefreshProviderResult,
  RefreshReport,
} from '../engine/model-refresh.js';
import { CliError } from '../process/errors.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { writeRecordLines } from '../render/records.js';

/**
 * The `relavium models` / `relavium models refresh` command core (workstream **2.5.G S5**,
 * [ADR-0064](../../../../docs/decisions/0064-live-model-catalog.md) §5/§10) — the shell surface over the S5
 * refresh orchestrator + the S4 catalog reader. Framework-free (no `commander`): parsed args + injected ports
 * in, output via {@link CliIo}; a fault throws a typed {@link CliError}. The stores/refresh service are injected,
 * so the core unit-tests with an in-memory db + a stub resolver and never touches the network.
 *
 * - `relavium models` (no sub) — LIST the cached catalog (read-only). If the cache is empty it does a minimal
 *   blocking first-run refresh (ADR-0064 §5a) and re-reads; an empty result stays a clean exit `0` (never a fault).
 * - `relavium models refresh` — force a live re-fetch (blocking) and print a per-provider outcome report. A
 *   per-provider failure is NOT a command failure (exit `0` with the report); the ONE hard fault (exit `2`) is an
 *   explicit refresh with ZERO providers connected (no key at all) — nothing could be fetched, so the user is
 *   told to add a key.
 *
 * Both honor `--json` ([ADR-0049](../../../../docs/decisions/0049-cli-machine-output-contract.md)): one NDJSON
 * record per model (list) or per provider (refresh), stdout-pure. Every emitted record is KEY-FREE by
 * construction — no provider key ever enters the catalog rows or the refresh report.
 */

export interface ModelsCommandArgs {
  /** `true` for `models refresh` (force a live re-fetch); `false` for a bare `models` (list the cache). */
  readonly refresh: boolean;
}

/** The narrow catalog reader the list path needs. */
export interface ModelsCatalogReader {
  readonly listAll: () => ModelCatalogListing[];
}

export interface ModelsCommandDeps {
  readonly io: CliIo;
  readonly global: GlobalOptions;
  readonly catalog: ModelsCatalogReader;
  readonly refreshService: ModelRefreshService;
}

export async function modelsCommand(
  args: ModelsCommandArgs,
  deps: ModelsCommandDeps,
): Promise<ExitCode> {
  if (args.refresh) {
    return runRefresh(deps);
  }
  return runList(deps);
}

/** `models refresh` — force a live re-fetch and report per-provider outcomes. */
async function runRefresh(deps: ModelsCommandDeps): Promise<ExitCode> {
  const report = await deps.refreshService.refresh();
  const connected = report.providers.filter((p) => p.status !== 'skipped-no-key');
  if (connected.length === 0) {
    // Nothing was connected — no key at all, so the refresh could fetch nothing. A clean, actionable exit-2
    // invocation fault (never echoes a key; names both ways to provide one).
    throw new CliError(
      'invalid_invocation',
      'no provider key configured — store one with `relavium provider set-key <name>`, or set RELAVIUM_<PROVIDER>_API_KEY.',
    );
  }
  if (deps.global.json) {
    writeRecordLines(deps.io, report.providers.map(toRefreshJson));
    return EXIT_CODES.success;
  }
  renderRefreshReport(deps.io, report);
  return EXIT_CODES.success;
}

/** `models` (no sub) — list the cached catalog, refreshing first only when it is empty (first-run, ADR-0064 §5a). */
async function runList(deps: ModelsCommandDeps): Promise<ExitCode> {
  let listings = deps.catalog.listAll();
  if (listings.length === 0) {
    // First-run: a minimal blocking refresh so the very first `models` shows a real catalog, then re-read. A
    // provider with no key is skipped inside `refresh`, so this stays a no-op (still exit 0) when no key is set.
    await deps.refreshService.refresh();
    listings = deps.catalog.listAll();
  }
  if (deps.global.json) {
    writeRecordLines(deps.io, listings.map(toModelJson));
    return EXIT_CODES.success;
  }
  renderModelList(deps.io, listings);
  return EXIT_CODES.success;
}

// ── --json records (key-free; `null` for an absent optional, the read-command convention) ──────────────

function toRefreshJson(p: RefreshProviderResult): unknown {
  return {
    provider: p.provider,
    status: p.status,
    added: p.added ?? null,
    updated: p.updated ?? null,
    deactivated: p.deactivated ?? null,
    error: p.error ?? null,
  };
}

function toModelJson(m: ModelCatalogListing): unknown {
  return {
    provider: m.providerId,
    modelId: m.modelId,
    displayName: m.displayName,
    contextWindowTokens: m.contextWindowTokens ?? null,
    maxOutputTokens: m.maxOutputTokens ?? null,
    source: m.source,
    lastRefreshedAt: m.lastRefreshedAt ?? null,
    deprecationDate: m.deprecationDate ?? null,
  };
}

// ── human renderers ────────────────────────────────────────────────────────────

/** Collapse whitespace so a (secret-free) provider error can never break the one-line-per-provider table. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function renderRefreshReport(io: CliIo, report: RefreshReport): void {
  io.writeOut('Model catalog refresh:\n');
  for (const p of report.providers) {
    io.writeOut(`  ${p.provider}\t${refreshDetail(p)}\n`);
  }
}

/** The per-provider detail column of the refresh report. */
function refreshDetail(p: RefreshProviderResult): string {
  switch (p.status) {
    case 'refreshed':
      return `refreshed\t+${p.added ?? 0} ~${p.updated ?? 0} -${p.deactivated ?? 0}`;
    case 'skipped-no-key':
      return 'skipped\tno key';
    case 'skipped-unsupported':
      return 'skipped\tno model-list endpoint';
    case 'failed':
      return `failed\t${oneLine(p.error ?? 'refresh failed')}`;
  }
}

function renderModelList(io: CliIo, listings: readonly ModelCatalogListing[]): void {
  if (listings.length === 0) {
    io.writeOut(
      'No models cached. Add a provider key (`relavium provider set-key <name>`) and run `relavium models refresh`.\n',
    );
    return;
  }
  io.writeOut(`Models (${listings.length}):\n`);
  for (const m of listings) {
    const ctx = m.contextWindowTokens === undefined ? '' : `\tctx=${m.contextWindowTokens}`;
    io.writeOut(`  ${m.modelId}\t${m.providerId}${ctx}\t[${m.source}]\n`);
  }
}
