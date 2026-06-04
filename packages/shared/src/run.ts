import { z } from 'zod';

import { kebabIdSchema, nonEmptyString, nonNegativeInt } from './common.js';
import { TriggerTypeSchema } from './workflow.js';

/**
 * The logical run record (`RunSchema`). This is the engine-/surface-facing shape of a
 * workflow execution; its persistence (column types, indexes) is the canonical
 * property of database-schema.md, which `@relavium/db` implements. Timestamps are
 * epoch-milliseconds; money is integer micro-cents.
 */

/** Run lifecycle status (matches the `runs.status` CHECK in database-schema.md). */
export const RunStatusSchema = z.enum([
  'pending',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunSchema = z.object({
  id: nonEmptyString, // run id (UUID)
  workflowId: kebabIdSchema,
  status: RunStatusSchema,
  // What triggered this run — the canonical trigger vocabulary. The runs table sets no
  // strict CHECK on trigger_type; the execution mode is carried on the `run:started`
  // event (sse-event-schema.md), not on the persisted run record, so it is not modeled here.
  triggerType: TriggerTypeSchema,
  inputs: z.record(z.unknown()),
  outputs: z.record(z.unknown()).optional(),
  error: z
    .object({ code: nonEmptyString, message: z.string(), nodeId: z.string().optional() })
    .optional(),
  startedAt: nonNegativeInt.optional(), // epoch ms
  completedAt: nonNegativeInt.optional(),
  totalInputTokens: nonNegativeInt,
  totalOutputTokens: nonNegativeInt,
  totalCostMicrocents: nonNegativeInt,
  createdAt: nonNegativeInt,
  updatedAt: nonNegativeInt,
});
export type Run = z.infer<typeof RunSchema>;
