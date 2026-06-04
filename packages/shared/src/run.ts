import { z } from 'zod';

import { kebabIdSchema, nonEmptyString, nonNegativeInt } from './common.js';
import { EXECUTION_MODES } from './constants.js';
import { TriggerTypeSchema } from './workflow.js';

/**
 * The logical run record (`RunSchema`) — the **engine-/surface-facing** shape of a
 * workflow execution.
 *
 * **Boundary (logical vs persisted).** `RunSchema` is deliberately the *narrow* view.
 * The persisted row carries additional columns that are a **persistence concern owned
 * by `@relavium/db`** (workstream 0.I), modeled there as a distinct `RunRow` mirroring
 * the canonical DDL in
 * [database-schema.md](../../../docs/reference/desktop/database-schema.md): notably
 * `workflow_definition_snapshot` (the frozen graph for replay/resume — an engine
 * deliverable), `trigger_metadata`, `workflow_path`/`project_root`, and the
 * `deleted_at` soft-delete cursor. Those do not belong on the logical run view and are
 * intentionally absent here; a consumer that needs them reads the `RunRow` from
 * `@relavium/db`. Timestamps are epoch-milliseconds; money is integer micro-cents.
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
  id: z.string().uuid(), // run id (UUID, generated in application code)
  workflowId: kebabIdSchema,
  status: RunStatusSchema,
  // Which mode the run used — persisted (`runs.execution_mode`) for cost/billing
  // attribution and history, matching the `run:started` event's `executionMode`.
  executionMode: z.enum(EXECUTION_MODES),
  // What triggered this run — the canonical trigger vocabulary (the runs table sets no
  // strict CHECK on trigger_type, so all five values are valid).
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
