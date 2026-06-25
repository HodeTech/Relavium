import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { WorkflowModelCatalog } from '@relavium/core';
import {
  createModelCatalogStore,
  ModelCatalogCapabilitiesError,
  type Db,
  type ModelCatalogRecord,
  type ModelCatalogStore,
} from '@relavium/db';
import { CapabilityFlagsSchema } from '@relavium/llm';
import type { MediaCostEstimate, MediaSurface } from '@relavium/shared';

import { globalConfigDir } from '../config/paths.js';
import type { ResolvedConfig } from '../config/resolve.js';
import type { CliMediaOptions } from './host.js';

/**
 * The 2.S media wiring `run` and `gate` share (ADR-0042/0044/0045): the host media-port roots + the catalog
 * routing projection + the configured per-modality cost estimate — assembled once over the durable
 * `~/.relavium/history.db` connection. Both commands build it identically; extracting it keeps the two call
 * sites from drifting (a swapped root in one but not the other).
 */
export interface MediaEngineWiring {
  /** The host media-port roots ({@link CliMediaOptions}) the command passes to `createCliHost`. */
  readonly media: CliMediaOptions;
  /** The `AgentRunnerDeps.resolveMediaSurface` projection over the `model_catalog` (ADR-0045 §1). */
  readonly resolveMediaSurface: (model: string) => MediaSurface | undefined;
  /**
   * The `WorkflowModelCatalog` the D15 load-check ({@link validateWorkflowWithCatalog}) reads — a model →
   * `CapabilityFlags` lookup over the same `model_catalog`. Used by the `run` parse path only; `gate` resume
   * trusts the original run's load-time verdict (it never re-parses the YAML), with the runtime FallbackChain
   * pre-skip as the backstop, so it leaves this field unread.
   */
  readonly workflowModelCatalog: WorkflowModelCatalog;
  /** The `[defaults].media_cost_estimate` the command spreads into `BuildEngineOptions` (`undefined` ⇒ omit). */
  readonly mediaCostEstimate: MediaCostEstimate | undefined;
}

/**
 * Project the DB `model_catalog` reader into the engine's {@link WorkflowModelCatalog} — the D15 load-check's
 * `(modelId) => CapabilityFlags | undefined` lookup (ADR-0044 §2 / ADR-0045 §1). `@relavium/db` deliberately
 * returns the raw `capabilities` JSON object (it never depends on `@relavium/llm`, the `CapabilityFlags` home);
 * the HOST validates it against `CapabilityFlagsSchema` here, keeping the engine portable (CLAUDE.md rule 5).
 *
 * Two per-model "degrade to `undefined`" (defer) paths — never a whole-catalog abort, so one bad row can't sink
 * the load-check for a valid sibling model (the runtime FallbackChain pre-skip stays the backstop):
 *   - `getByModelId` throws a typed {@link ModelCatalogCapabilitiesError} on a corrupt `capabilities` row
 *     (non-JSON / non-object); the `catch` swallows ONLY that type, isolating the corrupt row to this model. A
 *     throw of ANY OTHER kind is a genuine store/DB fault (a closed/locked connection, an IO error) — NOT a
 *     capability verdict — so it is rethrown rather than masked as a clean "unresolvable" defer that would slip
 *     an unchecked node past the load gate. (A bare `instanceof TypeError` would be wrong here — better-sqlite3
 *     itself throws a `TypeError` on a closed connection, so the typed domain error is what makes this precise.)
 *   - a row whose `capabilities` fails `CapabilityFlagsSchema` (a partial / legacy blob) — `safeParse` defers.
 */
function createWorkflowModelCatalog(catalog: ModelCatalogStore): WorkflowModelCatalog {
  return (modelId) => {
    let record: ModelCatalogRecord | undefined;
    try {
      record = catalog.getByModelId(modelId);
    } catch (err) {
      if (err instanceof ModelCatalogCapabilitiesError) {
        return undefined; // a corrupt-capabilities row — defer this one model
      }
      throw err; // a real store/DB fault is not a defer verdict — surface it
    }
    if (record === undefined) {
      return undefined;
    }
    const parsed = CapabilityFlagsSchema.safeParse(record.capabilities);
    return parsed.success ? parsed.data : undefined;
  };
}

/**
 * Build the shared media wiring from the open history `db`, the home dir (the global CAS root lives under it),
 * the run/resume `cwd` (the project-relative `save_to` root), and the resolved config (the cost estimate). The
 * CAS is global (`~/.relavium/media/`, content-addressed + deduped across runs); `save_to` is per-run-isolated
 * by the authored `{{ run.id }}` segment under `<cwd>/.relavium/runs/`; the `media_references` retention
 * junction reuses the same `db`.
 */
export function buildMediaEngineWiring(
  db: Db,
  homeDir: string,
  cwd: string,
  config: ResolvedConfig,
): MediaEngineWiring {
  const catalog = createModelCatalogStore(db, { uuid: () => randomUUID(), now: () => Date.now() });
  return {
    media: {
      casRoot: join(globalConfigDir(homeDir), 'media'),
      saveToRoot: join(cwd, '.relavium', 'runs'),
      referenceDb: db,
    },
    resolveMediaSurface: catalog.resolveMediaSurface,
    workflowModelCatalog: createWorkflowModelCatalog(catalog),
    mediaCostEstimate: config.mediaCostEstimate,
  };
}
