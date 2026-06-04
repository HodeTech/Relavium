import { z } from 'zod';

/**
 * Generic Zod primitives reused across the domain schemas. These are internal
 * building blocks — they are intentionally **not** re-exported from `index.ts`
 * (the public surface is the named domain schemas, not these helpers).
 */

/** kebab-case identifier: lowercase alphanumerics in dash-separated segments. */
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A kebab-case id (`workflow.id`, `node.id`, `agent.id`, `agent_ref`). */
export const kebabIdSchema = z
  .string()
  .regex(KEBAB_CASE, 'must be kebab-case (lowercase alphanumerics, dash-separated)');

/** A non-empty string. */
export const nonEmptyString = z.string().min(1);

/** A positive integer (>= 1). */
export const positiveInt = z.number().int().positive();

/** A non-negative integer (>= 0). */
export const nonNegativeInt = z.number().int().nonnegative();
