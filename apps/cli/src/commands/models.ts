import type { ModelCatalogListing } from '@relavium/db';

import type {
  ModelRefreshService,
  RefreshProviderResult,
  RefreshReport,
} from '../engine/model-refresh.js';
import type { CatalogRefreshResult } from '../engine/catalog-refresh.js';
import { CliError } from '../process/errors.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { writeRecordLines } from '../render/records.js';
import { stripTerminalControls } from '../render/tui/chat-projection.js';

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
  /**
   * Which axis to refresh (ADR-0071 §4a). Absent ⇒ **BOTH**, because *"refresh what I know about models"* is one
   * user intent, not two: the provider lists say what you can CALL, the catalog says what it COSTS, and a user who
   * types `models refresh` wants both to be current.
   *
   * `'providers'` is ADR-0064's original behaviour, kept addressable for a script that only wants availability;
   * `'catalog'` is metadata only, and is the one form that works with no provider key at all.
   */
  readonly axis?: 'providers' | 'catalog';
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
  /**
   * Fetch models.dev and install it (ADR-0071 §4a). Injected so the command stays testable without a network — and
   * so the pure `@relavium/llm` catalog keeps taking data as an argument rather than reaching for a socket.
   */
  readonly refreshCatalog: () => Promise<CatalogRefreshResult>;
  /**
   * `[catalog] auto_refresh` (ADR-0071 §4) — DEFAULT `false`, and the default is the design. Absent/`false` ⇒ a bare
   * `models` never touches the network for metadata; the shipped snapshot answers. `true` ⇒ the list refreshes the
   * catalog first, because a user who opted in wants the prices to be current where they can see them.
   */
  readonly autoRefreshCatalog?: boolean;
  /**
   * Translate an internal `llm_providers` UUID (the FK `ModelCatalogListing.providerId` carries) → its provider
   * SLUG (e.g. `anthropic`) for the human table + the `--json` `provider` field, so the list path matches the
   * `models refresh` report and the documented `{ provider }` contract (commands.md). Falls back to the uuid
   * itself when unmapped — NEVER throws.
   */
  readonly providerSlug: (uuid: string) => string;
}

export async function modelsCommand(
  args: ModelsCommandArgs,
  deps: ModelsCommandDeps,
): Promise<ExitCode> {
  if (args.refresh) {
    return runRefresh(deps, args.axis);
  }
  return runList(deps);
}

/**
 * `models refresh` — re-fetch, and report per-SOURCE outcomes (ADR-0071 §4a).
 *
 * Two axes, one command. The provider lists say which models a key can REACH; the catalog says what they COST and
 * which reasoning tiers they take. A bare `models refresh` does both, because that is the intent behind the words.
 *
 * The two fail INDEPENDENTLY, and neither failure fails the other: an offline models.dev does not stop a provider
 * refresh, and a keyless install can still refresh the catalog — which is the whole reason `--catalog` is separately
 * addressable. Each is reported for what it did.
 */
async function runRefresh(
  deps: ModelsCommandDeps,
  axis: 'providers' | 'catalog' | undefined,
): Promise<ExitCode> {
  const wantProviders = axis !== 'catalog';
  const wantCatalog = axis !== 'providers';

  // The two axes are independent I/O (models.dev vs the provider list APIs) and neither rejects — each captures its
  // faults into its own result type — so start both and await together rather than serializing the round-trips.
  const [catalogResult, report] = await Promise.all([
    wantCatalog ? deps.refreshCatalog() : Promise.resolve(undefined),
    wantProviders ? deps.refreshService.refresh() : Promise.resolve(undefined),
  ]);

  assertProviderRefreshInvocable(report, catalogResult);

  if (deps.global.json) {
    writeRecordLines(deps.io, toRefreshRecords(report, catalogResult));
    return EXIT_CODES.success;
  }

  if (report !== undefined) renderRefreshReport(deps.io, report);
  if (catalogResult !== undefined) renderCatalogRefresh(deps.io, catalogResult);
  return EXIT_CODES.success;
}

/**
 * A `models refresh` that reaches ZERO providers (no key at all) is an invocation fault — there was nothing it
 * could fetch — UNLESS the catalog was also asked for and delivered: a keyless user running `models refresh` to
 * see what things cost has been served, and calling that a failure would be a lie. No-op when providers were not
 * refreshed at all (`--catalog`).
 */
function assertProviderRefreshInvocable(
  report: RefreshReport | undefined,
  catalogResult: CatalogRefreshResult | undefined,
): void {
  if (report === undefined) return;
  const connected = report.providers.filter((p) => p.status !== 'skipped-no-key');
  if (connected.length === 0 && catalogResult?.status !== 'refreshed') {
    throw new CliError(
      'invalid_invocation',
      'no provider key configured — store one with `relavium provider set-key <name>`, or set RELAVIUM_<PROVIDER>_API_KEY.',
    );
  }
}

/** One `--json` record per SOURCE — the providers, then the catalog — so a script can tell which half worked. */
function toRefreshRecords(
  report: RefreshReport | undefined,
  catalogResult: CatalogRefreshResult | undefined,
): unknown[] {
  const records: unknown[] = report === undefined ? [] : report.providers.map(toRefreshJson);
  if (catalogResult !== undefined) {
    records.push({
      source: 'catalog',
      status: catalogResult.status,
      models: catalogResult.models,
      added: catalogResult.added,
      ...(catalogResult.reason === undefined ? {} : { reason: catalogResult.reason }),
    });
  }
  return records;
}

/** The catalog half of the refresh report — a failure is a NOTE, never an error: the shipped snapshot still answers. */
function renderCatalogRefresh(io: CliIo, result: CatalogRefreshResult): void {
  if (result.status === 'failed') {
    io.writeErr(
      `catalog: ${result.reason ?? 'refresh failed'} — keeping the shipped catalog (prices and limits are unchanged, not lost).\n`,
    );
    return;
  }
  const added = result.added === 0 ? '' : `, ${result.added} new`;
  io.writeOut(`catalog: ${result.models} models from models.dev${added}.\n`);
}

/** `models` (no sub) — list the cached catalog, refreshing first only when it is empty (first-run, ADR-0064 §5a). */
async function runList(deps: ModelsCommandDeps): Promise<ExitCode> {
  // `[catalog] auto_refresh` (ADR-0071 §4), DEFAULT OFF. When a user turns it on, THIS is where it fires: a command
  // that is about to show prices, where a stale one would be the thing they came to look at. Never at boot, never on
  // a `--help`, never behind a chat turn — a standing background fetch to a third party is what the default-OFF
  // exists to refuse, and a user who opts in should still be able to see when it happens.
  //
  // A failure is silent here: the shipped snapshot answers, the list renders, and the user did not ask about the
  // network. `models refresh --catalog` is the form that reports.
  if (deps.autoRefreshCatalog === true) {
    await deps.refreshCatalog();
  }
  let listings = deps.catalog.listAll();
  let firstRunReport: RefreshReport | undefined;
  if (listings.length === 0) {
    // First-run: a minimal blocking refresh so the very first `models` shows a real catalog, then re-read. A
    // provider with no key is skipped inside `refresh`, so this stays a no-op (still exit 0) when no key is set.
    firstRunReport = await deps.refreshService.refresh();
    listings = deps.catalog.listAll();
  }
  if (deps.global.json) {
    writeRecordLines(
      deps.io,
      listings.map((m) => toModelJson(m, deps.providerSlug)),
    );
    return EXIT_CODES.success;
  }
  // Human mode only (FIX 4/6): when the catalog is STILL empty after a first-run refresh because a CONNECTED
  // provider either FAILED its refresh OR does not support listing (`skipped-unsupported`) — NOT merely because no
  // key was set — print a status-aware line. The plain `renderModelList` "add a provider key" guidance would
  // mislead in both cases (a key IS set). `skipped-no-key` is genuinely keyless, so it falls through to that
  // default guidance as before.
  if (listings.length === 0 && firstRunReport !== undefined) {
    const failed = firstRunReport.providers.filter((p) => p.status === 'failed');
    if (failed.length > 0) {
      const names = failed.map((p) => p.provider).join(', ');
      deps.io.writeOut(
        `Model refresh failed for ${names}; showing no models — run \`relavium models refresh\` or check \`relavium doctor\`.\n`,
      );
      return EXIT_CODES.success;
    }
    const unsupported = firstRunReport.providers.filter((p) => p.status === 'skipped-unsupported');
    if (unsupported.length > 0) {
      const names = unsupported.map((p) => p.provider).join(', ');
      deps.io.writeOut(
        `No models to list for ${names} — the provider does not support listing models (a key is set, so this is not a missing-key issue).\n`,
      );
      return EXIT_CODES.success;
    }
  }
  renderModelList(deps.io, listings, deps.providerSlug);
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

function toModelJson(m: ModelCatalogListing, providerSlug: (uuid: string) => string): unknown {
  return {
    // The SLUG (e.g. `anthropic`), not the internal `llm_providers` UUID the catalog row carries — matching the
    // `models refresh` report + the documented `{ provider }` contract. `--json` is unchanged otherwise
    // (JSON.stringify escapes any control byte on its own, so the slug is not terminal-sanitized here).
    provider: providerSlug(m.providerId),
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

/**
 * Sanitize a PROVIDER-supplied string for one-line terminal display (FIX 2, CWE-150): first strip ANSI/OSC/C0/C1
 * control bytes via the canonical {@link stripTerminalControls} — so a rogue/custom-endpoint model id, display
 * name, or refresh error can't inject a cursor jump / clear-line / `\r` line-overwrite (`ModelListingSchema` only
 * requires `min(1)`, so it never guarantees a clean id) — then collapse the remaining whitespace so it can never
 * break the one-line-per-row table. RENDER boundary only: the stored rows and the `--json` payload are untouched.
 */
function oneLine(text: string): string {
  return stripTerminalControls(text).replace(/\s+/gu, ' ').trim();
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

function renderModelList(
  io: CliIo,
  listings: readonly ModelCatalogListing[],
  providerSlug: (uuid: string) => string,
): void {
  if (listings.length === 0) {
    io.writeOut(
      'No models cached. Add a provider key (`relavium provider set-key <name>`) and run `relavium models refresh`.\n',
    );
    return;
  }
  io.writeOut(`Models (${listings.length}):\n`);
  for (const m of listings) {
    const ctx = m.contextWindowTokens === undefined ? '' : `\tctx=${m.contextWindowTokens}`;
    // `m.modelId` (and `m.displayName`, were it shown) is provider-supplied → terminal-sanitized (FIX 2). The
    // provider column is the SLUG, never the internal UUID (FIX 1); it too passes through `oneLine` in case a
    // custom-provider slug carries a control byte, and falls back to the (safe) uuid when unmapped.
    io.writeOut(
      `  ${oneLine(m.modelId)}\t${oneLine(providerSlug(m.providerId))}${ctx}\t[${m.source}]\n`,
    );
  }
}
