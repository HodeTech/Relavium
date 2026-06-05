/**
 * `@relavium/shared` — Zod schemas + inferred types, the contract source of truth
 * for every Relavium package and surface.
 *
 * Each schema is driven directly from its canonical reference contract under
 * `docs/reference/contracts/` (workflow / agent YAML, the run-event stream, config)
 * and `docs/reference/shared-core/`. The schemas are a **public API**: breaking a
 * field is a versioned `schema_version` event with a migration path, never a silent
 * change. The internal Zod primitives in `common.ts` are deliberately not exported —
 * the public surface is the named domain schemas and their inferred types below.
 */

export * from './constants.js';
export * from './content.js';
export * from './agent.js';
export * from './node.js';
export * from './edge.js';
export * from './workflow.js';
export * from './run-event.js';
export * from './run.js';
export * from './config.js';
