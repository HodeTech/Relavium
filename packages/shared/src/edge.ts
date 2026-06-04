import { z } from 'zod';

import { nonEmptyString } from './common.js';

/**
 * A directed connection between two nodes (workflow-yaml-spec.md). `from` may be a
 * bare node id or the `nodeId:handle` form (a condition branch handle); `to` is a
 * node id. Node-existence and handle resolution are the engine's job, so the schema
 * keeps these as plain non-empty strings.
 */
export const EdgeSchema = z.object({
  from: nonEmptyString,
  to: nonEmptyString,
  label: z.string().optional(),
  condition: z.string().optional(),
});
export type Edge = z.infer<typeof EdgeSchema>;
