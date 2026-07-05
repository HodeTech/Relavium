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
): ModelsCommandDeps {
  return { io, global: globalOptions(json), catalog, refreshService };
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

  it('--json emits one key-free record per model', async () => {
    const { io, out } = captureIo();
    const rowsRef = { value: [modelRow('anthropic', 'claude-x'), modelRow('openai', 'gpt-x')] };
    const refresh = stubRefresh(REFRESHED);

    await modelsCommand({ refresh: false }, deps(io, stubCatalog(rowsRef), refresh, true));
    const records = parseNdjson(out());
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      provider: 'anthropic',
      modelId: 'claude-x',
      contextWindowTokens: 200_000,
      source: 'live',
    });
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
    ]);
  });

  it('exits 2 on an explicit refresh with zero providers connected (no key at all)', async () => {
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
      await modelsCommand({ refresh: true }, deps(io, stubCatalog(rowsRef), refresh));
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
});
