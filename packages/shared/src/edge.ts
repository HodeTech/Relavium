import { z } from 'zod';

import { KEBAB_PATTERN } from './common.js';

/**
 * A directed connection between two nodes (workflow-yaml-spec.md). The contract narrows
 * the *shape* of these ids: `to` is a node id (kebab-case); `from` is a node id,
 * optionally suffixed with `:handle` (a condition branch's `when` value). The schema
 * validates that **format** at the contract boundary (reusing the shared kebab pattern);
 * node-existence and handle resolution stay the engine's job (it has the full node graph).
 */

/** `nodeId` or `nodeId:handle`. */
const fromSchema = z
  .string()
  .regex(
    new RegExp(`^${KEBAB_PATTERN}(?::.+)?$`),
    'from must be a node id, optionally "nodeId:handle"',
  );

/** `nodeId` (kebab-case). */
const toSchema = z
  .string()
  .regex(new RegExp(`^${KEBAB_PATTERN}$`), 'to must be a kebab-case node id');

export const EdgeSchema = z.object({
  from: fromSchema,
  to: toSchema,
  label: z.string().optional(),
  condition: z.string().optional(),
});
export type Edge = z.infer<typeof EdgeSchema>;
