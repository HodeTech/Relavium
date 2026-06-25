import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { createModelCatalogStore, type Db } from '@relavium/db';
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
  /** The `[defaults].media_cost_estimate` the command spreads into `BuildEngineOptions` (`undefined` ⇒ omit). */
  readonly mediaCostEstimate: MediaCostEstimate | undefined;
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
    mediaCostEstimate: config.mediaCostEstimate,
  };
}
