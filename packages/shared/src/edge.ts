import { z } from 'zod';

/**
 * A directed connection between two nodes (workflow-yaml-spec.md). The contract narrows
 * the *shape* of these ids: `to` is a node id (kebab-case); `from` is a node id,
 * optionally suffixed with `:handle` (a condition branch's `when` value). The schema
 * validates that **format** at the contract boundary; node-existence and handle
 * resolution stay the engine's job (it has the full node graph).
 */
const NODE_ID = '[a-z0-9]+(?:-[a-z0-9]+)*';

/** `nodeId` or `nodeId:handle`. */
const fromSchema = z
  .string()
  .regex(new RegExp(`^${NODE_ID}(?::.+)?$`), 'from must be a node id, optionally "nodeId:handle"');

/** `nodeId` (kebab-case). */
const toSchema = z.string().regex(new RegExp(`^${NODE_ID}$`), 'to must be a kebab-case node id');

export const EdgeSchema = z.object({
  from: fromSchema,
  to: toSchema,
  label: z.string().optional(),
  condition: z.string().optional(),
});
export type Edge = z.infer<typeof EdgeSchema>;
