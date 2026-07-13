import type { ModelCatalogListing } from '@relavium/db';
import { describe, expect, it } from 'vitest';

import type { ModelRefreshService, RefreshReport } from '../engine/model-refresh.js';
import { isCliError } from '../process/errors.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo, parseNdjson } from '../test-support.js';
import { modelsCommand, type ModelsCatalogReader, type ModelsCommandDeps } from './models.js';

/**
 * `relavium models` / `models refresh` command-core tests (2.5.G S5, ADR-0064 §5/§10 + ADR-0049 --json). Pure:
 * a stub catalog reader + a stub refresh service — no db, no network. Covers the list vs refresh paths, the
 * first-run refresh-if-empty, the `--json` shapes, and the zero-connected exit-2 fault.
 */

function globalOptions(json = false): GlobalOptions {
  return { json, color: false, cwd: process.cwd(), configPath: undefined, verbosity: 'normal' };
}

function modelRow(
  providerId: string,
  modelId: string,
  source: 'static' | 'live' | 'user' = 'live',
): ModelCatalogListing {
  return {
    modelId,
    providerId,
    displayName: modelId,
    contextWindowTokens: 200_000,
    inputCostPerMtokMicrocents: 0,
    outputCostPerMtokMicrocents: 0,
    cachedInputCostPerMtokMicrocents: 0,
    cachedInputStated: false,
    source,
    lastRefreshedAt: 1_700_000_000_000,
    isActive: true,
  };
}

/** A refresh-service stub: returns `report` and runs `onRefresh` (e.g. to populate the catalog on first run). */
function stubRefresh(
  report: RefreshReport,
  onRefresh?: () => void,
): ModelRefreshService & { calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    refresh: () => {
      state.calls += 1;
      onRefresh?.();
      return Promise.resolve(report);
    },
    refreshIfStale: () => Promise.resolve(report),
    refreshInBackground: () => {},
  };
}

function stubCatalog(rowsRef: { value: ModelCatalogListing[] }): ModelsCatalogReader {
  return { listAll: () => rowsRef.value };
}

function deps(
  io: ReturnType<typeof captureIo>['io'],
  catalog: ModelsCatalogReader,
  refreshService: ModelRefreshService,
  json = false,
  providerSlug: (uuid: string) => string = (uuid) => uuid,
): ModelsCommandDeps {
  return {
    io,
    global: globalOptions(json),
    catalog,
    refreshService,
    refreshCatalog: () => Promise.resolve({ status: 'refreshed' as const, models: 80, added: 0 }),
    providerSlug,
  };
}

const REFRESHED: RefreshReport = {
  providers: [
    { provider: 'anthropic', status: 'refreshed', added: 3, updated: 1, deactivated: 0 },
    { provider: 'openai', status: 'skipped-no-key' },
  ],
};

describe('modelsCommand — list', () => {
  it('lists the cached catalog without refreshing when it is non-empty', async () => {
    const { io, out } = captureIo();
    const rowsRef = { value: [modelRow('anthropic', 'claude-x')] };
    const refresh = stubRefresh(REFRESHED);

    const code = await modelsCommand({ refresh: false }, deps(io, stubCatalog(rowsRef), refresh));
    expect(code).toBe(EXIT_CODES.success);
    expect(refresh.calls).toBe(0); // non-empty ⇒ no first-run refresh
    expect(out()).toContain('claude-x');
  });

  it('does a first-run refresh when the cache is empty, then lists', async () => {
    const { io, out } = captureIo();
    const rowsRef: { value: ModelCatalogListing[] } = { value: [] };
    const refresh = stubRefresh(REFRESHED, () => {
      rowsRef.value = [modelRow('anthropic', 'claude-x')];
    });

    const code = await modelsCommand({ refresh: false }, deps(io, stubCatalog(rowsRef), refresh));
    expect(code).toBe(EXIT_CODES.success);
    expect(refresh.calls).toBe(1); // empty ⇒ one blocking first-run refresh
    expect(out()).toContain('claude-x');
  });

  it('reports an empty catalog cleanly (exit 0, no fault)', async () => {
    const { io, out } = captureIo();
    const rowsRef: { value: ModelCatalogListing[] } = { value: [] };
    const refresh = stubRefresh({ providers: [] }); // refresh finds nothing

    const code = await modelsCommand({ refresh: false }, deps(io, stubCatalog(rowsRef), refresh));
    expect(code).toBe(EXIT_CODES.success);
    expect(out()).toContain('No models cached');
  });

  it('--json emits one key-free record per model with the provider SLUG (not the internal uuid)', async () => {
    // FIX 1: the catalog row carries the internal `llm_providers` UUID; the emitted `provider` must be the slug.
    const { io, out } = captureIo();
    const anthropicUuid = '11111111-1111-1111-1111-111111111111';
    const openaiUuid = '22222222-2222-2222-2222-222222222222';
    const slug = (uuid: string): string =>
      uuid === anthropicUuid ? 'anthropic' : uuid === openaiUuid ? 'openai' : uuid;
    const rowsRef = { value: [modelRow(anthropicUuid, 'claude-x'), modelRow(openaiUuid, 'gpt-x')] };
    const refresh = stubRefresh(REFRESHED);

    await modelsCommand({ refresh: false }, deps(io, stubCatalog(rowsRef), refresh, true, slug));
    const records = parseNdjson(out());
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      provider: 'anthropic', // the SLUG, never the uuid
      modelId: 'claude-x',
      contextWindowTokens: 200_000,
      source: 'live',
    });
    expect(out()).not.toContain(anthropicUuid); // the internal uuid never reaches --json
  });

  it('renders the provider SLUG (not the internal uuid) in the human table (FIX 1)', async () => {
    const { io, out } = captureIo();
    const anthropicUuid = '11111111-1111-1111-1111-111111111111';
    const slug = (uuid: string): string => (uuid === anthropicUuid ? 'anthropic' : uuid);
    const rowsRef = { value: [modelRow(anthropicUuid, 'claude-x')] };
    const refresh = stubRefresh(REFRESHED);

    await modelsCommand({ refresh: false }, deps(io, stubCatalog(rowsRef), refresh, false, slug));
    const text = out();
    expect(text).toContain('anthropic');
    expect(text).not.toContain(anthropicUuid);
  });

  it('strips terminal control sequences from a rogue model id in the human table (FIX 2, CWE-150)', async () => {
    const { io, out } = captureIo();
    const rowsRef = { value: [modelRow('anthropic', 'gpt-x\u001b[2K\rspoof')] };
    const refresh = stubRefresh(REFRESHED);

    await modelsCommand({ refresh: false }, deps(io, stubCatalog(rowsRef), refresh));
    const text = out();
    expect(text).not.toContain('\u001b'); // ANSI ESC stripped
    expect(text).not.toContain('\r'); // CR stripped (no line-overwrite)
    expect(text).toContain('gpt-x'); // the visible id text survives
  });

  it('--json first-run failure degrades to an empty NDJSON stream + exit 0 (connected provider fetch failed) (FIX D)', async () => {
    // The list path under `--json`: an empty cache triggers one first-run refresh, but the CONNECTED provider's
    // fetch FAILED, so the catalog stays empty. The accepted machine-output degrade (ADR-0049) is an EMPTY stream
    // + exit 0 — NOT a fault, and NOT the human failure-aware line (which `--json` must never emit).
    const { io, out } = captureIo();
    const rowsRef: { value: ModelCatalogListing[] } = { value: [] };
    const refresh = stubRefresh({
      providers: [{ provider: 'anthropic', status: 'failed', error: 'bad key' }],
    });

    const code = await modelsCommand(
      { refresh: false },
      deps(io, stubCatalog(rowsRef), refresh, true),
    );
    expect(code).toBe(EXIT_CODES.success);
    expect(refresh.calls).toBe(1); // the blocking first-run refresh DID run
    expect(out()).toBe(''); // empty NDJSON — no records, and no human "Model refresh failed" message
  });

  it('reports a FAILED first-run refresh (not "add a key") when the catalog is still empty (FIX 4)', async () => {
    const { io, out } = captureIo();
    const rowsRef: { value: ModelCatalogListing[] } = { value: [] };
    // The first-run refresh runs, but a CONNECTED provider FAILED — the catalog stays empty for a reason that is
    // NOT "no key", so the plain add-a-key guidance would mislead.
    const refresh = stubRefresh({
      providers: [
        { provider: 'anthropic', status: 'failed', error: 'bad key' },
        { provider: 'openai', status: 'skipped-no-key' },
      ],
    });

    const code = await modelsCommand({ refresh: false }, deps(io, stubCatalog(rowsRef), refresh));
    expect(code).toBe(EXIT_CODES.success);
    const text = out();
    expect(text).toContain('Model refresh failed for anthropic');
    expect(text).not.toContain('No models cached'); // not the misleading add-a-key line
  });
});

describe('modelsCommand — refresh', () => {
  it('prints the per-provider report and exits 0 (a per-provider skip is not a failure)', async () => {
    const { io, out } = captureIo();
    const rowsRef: { value: ModelCatalogListing[] } = { value: [] };
    const refresh = stubRefresh(REFRESHED);

    const code = await modelsCommand({ refresh: true }, deps(io, stubCatalog(rowsRef), refresh));
    expect(code).toBe(EXIT_CODES.success);
    const text = out();
    expect(text).toContain('anthropic');
    expect(text).toContain('refreshed');
    expect(text).toContain('+3 ~1 -0');
    expect(text).toContain('openai');
  });

  it('--json emits one record per provider with status + counts', async () => {
    const { io, out } = captureIo();
    const rowsRef: { value: ModelCatalogListing[] } = { value: [] };
    const refresh = stubRefresh(REFRESHED);

    await modelsCommand({ refresh: true }, deps(io, stubCatalog(rowsRef), refresh, true));
    const records = parseNdjson(out());
    expect(records).toEqual([
      {
        provider: 'anthropic',
        status: 'refreshed',
        added: 3,
        updated: 1,
        deactivated: 0,
        error: null,
      },
      {
        provider: 'openai',
        status: 'skipped-no-key',
        added: null,
        updated: null,
        deactivated: null,
        error: null,
      },
      // One record per SOURCE (ADR-0071 §4a) — the provider lists, then the catalog. A script can tell which half
      // worked, because the two fail independently: an offline models.dev does not stop a provider refresh, and a
      // keyless install can still refresh the catalog.
      { source: 'catalog', status: 'refreshed', models: 80, added: 0 },
    ]);
  });

  it('--providers refreshes availability ONLY — no models.dev egress at all', async () => {
    const { io, out } = captureIo();
    const rowsRef: { value: ModelCatalogListing[] } = { value: [] };
    let catalogFetched = false;
    const d = deps(io, stubCatalog(rowsRef), stubRefresh(REFRESHED), true);

    await modelsCommand(
      { refresh: true, axis: 'providers' },
      {
        ...d,
        refreshCatalog: () => {
          catalogFetched = true;
          return Promise.resolve({ status: 'refreshed' as const, models: 80, added: 0 });
        },
      },
    );
    expect(catalogFetched).toBe(false); // the flag is a promise about egress, not a display preference
    expect(parseNdjson(out()).some((r) => (r as { source?: string }).source === 'catalog')).toBe(
      false,
    );
  });

  it('--catalog refreshes metadata ONLY — and works with NO provider key at all', async () => {
    // The form that makes default-OFF livable: a user with no key yet, who wants to see what things cost, types one
    // command and gets them. Asking for a provider key here would be asking for the one thing they do not have.
    const { io, out } = captureIo();
    const rowsRef: { value: ModelCatalogListing[] } = { value: [] };
    let providersFetched = false;
    const d = deps(io, stubCatalog(rowsRef), stubRefresh(REFRESHED), true);

    const code = await modelsCommand(
      { refresh: true, axis: 'catalog' },
      {
        ...d,
        refreshService: stubRefresh(REFRESHED, () => {
          providersFetched = true;
        }),
      },
    );
    expect(code).toBe(EXIT_CODES.success);
    expect(providersFetched).toBe(false);
    expect(parseNdjson(out())).toEqual([
      { source: 'catalog', status: 'refreshed', models: 80, added: 0 },
    ]);
  });

  it('[catalog] auto_refresh — a bare `models` refreshes the catalog FIRST when opted in', async () => {
    // The opt-in standing-egress surface (ADR-0071 §4). Default OFF; when a user turns it on, a bare `models` (not a
    // `refresh`) fetches the catalog before listing, because a stale price is the thing they came to look at.
    let refreshedBeforeList = false;
    let listed = false;
    const catalog: ModelsCatalogReader = {
      listAll: () => {
        listed = true;
        return [];
      },
    };
    const { io } = captureIo();
    await modelsCommand(
      { refresh: false },
      {
        ...deps(io, catalog, stubRefresh(REFRESHED)),
        autoRefreshCatalog: true,
        refreshCatalog: () => {
          refreshedBeforeList = !listed; // true iff refresh ran BEFORE the list read
          return Promise.resolve({ status: 'refreshed' as const, models: 80, added: 0 });
        },
      },
    );
    expect(refreshedBeforeList).toBe(true);
  });

  it('[catalog] auto_refresh OFF (the default) — a bare `models` touches NO network', async () => {
    const rowsRef: { value: ModelCatalogListing[] } = { value: [] };
    let fetched = false;
    const { io } = captureIo();
    await modelsCommand(
      { refresh: false },
      {
        ...deps(io, stubCatalog(rowsRef), stubRefresh(REFRESHED)),
        refreshCatalog: () => {
          fetched = true;
          return Promise.resolve({ status: 'refreshed' as const, models: 80, added: 0 });
        },
      },
    );
    expect(fetched).toBe(false); // default OFF: no standing egress
  });

  it('a FAILED catalog refresh is a NOTE, never an error — the shipped snapshot still answers', async () => {
    // ADR-0071 §4: additive only. A refresh that cannot reach models.dev must leave the product knowing exactly what
    // it knew before — never a blank catalog, never a model that was priced yesterday and is not today. The cost cap
    // is a safety control; it does not lapse because a third party had a bad deploy.
    const { io, out, err } = captureIo();
    const rowsRef: { value: ModelCatalogListing[] } = { value: [] };
    const d = deps(io, stubCatalog(rowsRef), stubRefresh(REFRESHED), false);

    const code = await modelsCommand(
      { refresh: true, axis: 'catalog' },
      {
        ...d,
        refreshCatalog: () =>
          Promise.resolve({
            status: 'failed' as const,
            models: 0,
            added: 0,
            reason: 'models.dev unreachable',
          }),
      },
    );
    expect(code).toBe(EXIT_CODES.success); // exit 0 — the command did what it could, and said so
    expect(err()).toContain('models.dev unreachable');
    expect(err()).toContain('keeping the shipped catalog');
    expect(out()).not.toContain('models from models.dev');
  });

  it('exits 2 on a PROVIDERS refresh with zero providers connected (no key at all)', async () => {
    const { io, out } = captureIo();
    const rowsRef: { value: ModelCatalogListing[] } = { value: [] };
    const refresh = stubRefresh({
      providers: [
        { provider: 'anthropic', status: 'skipped-no-key' },
        { provider: 'openai', status: 'skipped-no-key' },
      ],
    });

    let thrown: unknown;
    try {
      await modelsCommand(
        { refresh: true, axis: 'providers' },
        deps(io, stubCatalog(rowsRef), refresh),
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      thrown = err;
    }
    expect(isCliError(thrown)).toBe(true);
    if (isCliError(thrown)) {
      expect(thrown.exitCode).toBe(EXIT_CODES.invalidInvocation);
    }
    expect(out()).toBe(''); // stdout stays empty on a fault
  });

  it('a BOTH-axis refresh with no key SUCCEEDS when the catalog delivered — half a loaf is not a fault', async () => {
    // A user with no key yet, running `models refresh` to see what things cost, HAS been served: the catalog is the
    // half that does not need one. Telling them their command failed would be a lie, and it would hide the half that
    // worked behind an error about the half that could not.
    const { io, out } = captureIo();
    const rowsRef: { value: ModelCatalogListing[] } = { value: [] };
    const refresh = stubRefresh({
      providers: [
        { provider: 'anthropic', status: 'skipped-no-key' },
        { provider: 'openai', status: 'skipped-no-key' },
      ],
    });

    const code = await modelsCommand({ refresh: true }, deps(io, stubCatalog(rowsRef), refresh));
    expect(code).toBe(EXIT_CODES.success);
    expect(out()).toContain('models from models.dev');
  });

  it('exits 0 when every connected provider FAILED — a per-provider failure is not a command failure (FIX 6)', async () => {
    // Every provider is `failed` (connected, but the fetch threw) — NOT `skipped-no-key`, so it is NOT the
    // zero-connected exit-2 case; the command prints the per-provider report and exits 0.
    const { io, out } = captureIo();
    const rowsRef: { value: ModelCatalogListing[] } = { value: [] };
    const refresh = stubRefresh({
      providers: [
        { provider: 'anthropic', status: 'failed', error: 'bad key' },
        { provider: 'openai', status: 'failed', error: 'network unreachable' },
      ],
    });

    const code = await modelsCommand({ refresh: true }, deps(io, stubCatalog(rowsRef), refresh));
    expect(code).toBe(EXIT_CODES.success);
    const text = out();
    expect(text).toContain('failed');
    expect(text).toContain('anthropic');
    expect(text).toContain('openai');
  });

  it('exits 0 when every provider is skipped-unsupported (no list endpoint) (FIX 6)', async () => {
    // Connected but no `listModels` endpoint — still not the zero-connected exit-2 case.
    const { io } = captureIo();
    const rowsRef: { value: ModelCatalogListing[] } = { value: [] };
    const refresh = stubRefresh({
      providers: [
        { provider: 'anthropic', status: 'skipped-unsupported' },
        { provider: 'openai', status: 'skipped-unsupported' },
      ],
    });

    const code = await modelsCommand({ refresh: true }, deps(io, stubCatalog(rowsRef), refresh));
    expect(code).toBe(EXIT_CODES.success);
  });

  it('reports a SKIPPED-UNSUPPORTED first-run refresh (not "add a key") when the catalog is still empty (FIX 6)', async () => {
    // On the LIST path (first-run auto-refresh), a CONNECTED provider with no `listModels` leaves the catalog empty
    // for a reason that is NOT "no key" — so the plain add-a-key guidance would mislead (a key IS set).
    const { io, out } = captureIo();
    const rowsRef: { value: ModelCatalogListing[] } = { value: [] };
    const refresh = stubRefresh({
      providers: [
        { provider: 'anthropic', status: 'skipped-unsupported' },
        { provider: 'openai', status: 'skipped-no-key' },
      ],
    });

    const code = await modelsCommand({ refresh: false }, deps(io, stubCatalog(rowsRef), refresh));
    expect(code).toBe(EXIT_CODES.success);
    const text = out();
    expect(text).toContain('does not support listing models'); // the status-aware line for anthropic
    expect(text).not.toContain('No models cached'); // NOT the misleading add-a-key default
  });
});
