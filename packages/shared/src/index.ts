/**
 * `@relavium/shared` — Zod schemas + inferred types, the contract source of truth
 * for every Relavium package and surface.
 *
 * …and a small number of **platform-free primitives** every package needs and none
 * of them owns: canonical JSON (`canonical.ts`), media de-inlining (`media-deinline.ts`),
 * and the deadline scope (`deadline.ts`). Each states in its own header why it landed
 * here rather than beside its first caller; the shared test is that a second package
 * needed it and the alternative was a duplicate. They are held to the same
 * platform-free bar as the schemas — `tsconfig.purity.json` compiles this package
 * with no ambient Node/DOM types.
 *
 * Each schema is driven directly from its canonical reference contract under
 * `docs/reference/contracts/` (workflow / agent YAML, the run-event stream, config)
 * and `docs/reference/shared-core/`. The schemas are a **public API**: breaking a
 * field is a versioned `schema_version` event with a migration path, never a silent
 * change. The internal Zod primitives in `common.ts` are deliberately not exported —
 * the public surface is the named domain schemas and their inferred types below.
 */

export * from './bytes.js';
export * from './canonical.js';
export * from './json-schema-compiler.js';
export * from './ordering.js';
export * from './terminal-safe.js';
export * from './constants.js';
export * from './declared-env.js';
export * from './content.js';
export * from './deadline.js';
export * from './media-deinline.js';
export * from './agent.js';
export * from './node.js';
export * from './edge.js';
export * from './workflow.js';
export * from './run-event.js';
export * from './session.js';
export * from './run.js';
export * from './config.js';
