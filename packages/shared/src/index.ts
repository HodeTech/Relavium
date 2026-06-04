/**
 * `@relavium/shared` — Zod schemas + inferred types, the contract source of truth
 * for every Relavium package and surface.
 *
 * **Phase 0 scaffold.** The full schema set — `WorkflowSchema`, `AgentSchema`,
 * `NodeSchema`, `EdgeSchema`, the colon-namespaced `RunEvent` union, `CostUpdatedEvent`,
 * the human-gate events, `RunSchema`, and the config schemas — lands in Phase 0
 * workstream 0.E, driven directly from the frozen reference contracts under
 * `docs/reference/contracts/`. This entry currently exports only the schema-version
 * constant so the package is a real, buildable dependency root for the graph.
 *
 * The public surface is curated here: never `export *` of internals.
 */

/** The workflow/agent YAML schema version this package targets. */
export const SCHEMA_VERSION = '1.0' as const;

/** Inferred type of {@link SCHEMA_VERSION}. */
export type SchemaVersion = typeof SCHEMA_VERSION;
