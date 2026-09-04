/**
 * `@relavium/mcp`'s binding of the shared JSON-Schema → Zod compiler
 * ([ADR-0092](../../../docs/decisions/0092-output-schema-is-validated-by-the-compiler-we-already-own.md) §1).
 *
 * The compiler itself moved to `@relavium/shared` because it has two callers with opposite threat models
 * and neither can reach the other: `@relavium/mcp` depends on `@relavium/core`, so core could not import
 * from here. **What did NOT move is the threat model.** This file keeps MCP's hostile-ingress bounds and
 * its public surface, so a server-reported `inputSchema` is compiled under exactly the limits it was
 * before — the promotion is a relocation, not a relaxation, and `schema-compiler.test.ts` still exercises
 * it through this door to prove that.
 */

import {
  compileJsonSchemaToZod as compileWithBounds,
  type CompileResult,
  type SchemaBounds,
} from '@relavium/shared';

import { INGRESS_BOUNDS } from './ingress-bounds.js';

/** Maximum nesting depth of the compiled schema — a deeper schema fails closed. */
export const MAX_DEPTH = 16;
/** Maximum total schema nodes visited — a larger schema fails closed (DoS guard). */
export const MAX_NODES = 2000;
/** Maximum `enum` members compiled — a larger enum fails closed. */
export const MAX_ENUM_MEMBERS = 1000;
/** Maximum `object` properties compiled — a wider object fails closed. */
export const MAX_PROPERTIES = 500;

/**
 * The bounds a **hostile** MCP server's schema is compiled under. Sized for ingress, not for authoring:
 * the byte limits come from {@link INGRESS_BOUNDS}, which the rest of the MCP boundary already shares
 * ([ADR-0088](../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md)).
 */
export const MCP_SCHEMA_BOUNDS: SchemaBounds = {
  maxDepth: MAX_DEPTH,
  maxNodes: MAX_NODES,
  maxEnumMembers: MAX_ENUM_MEMBERS,
  maxProperties: MAX_PROPERTIES,
  maxStringBytes: INGRESS_BOUNDS.schemaStringBytes,
  maxPropertyNameBytes: INGRESS_BOUNDS.schemaPropertyNameBytes,
};

export type { CompileResult };

/**
 * Compile an untrusted MCP `inputSchema` into a Zod validator under {@link MCP_SCHEMA_BOUNDS}. Never
 * throws — any unsupported construct, malformed shape, or budget overrun returns `{ ok: false, reason }`
 * so the caller drops the tool at discovery rather than admitting it unvalidated.
 */
export function compileJsonSchemaToZod(input: unknown): CompileResult {
  return compileWithBounds(input, MCP_SCHEMA_BOUNDS);
}
