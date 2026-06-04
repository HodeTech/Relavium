import { z } from 'zod';

/**
 * Generic Zod primitives reused across the domain schemas. These are internal
 * building blocks — they are intentionally **not** re-exported from `index.ts`
 * (the public surface is the named domain schemas, not these helpers).
 */

/**
 * The kebab-case body pattern (lowercase alphanumerics in dash-separated segments).
 * Exported so the edge schema can build the `nodeId(:handle)?` form from the same
 * source of truth rather than duplicating the regex.
 */
export const KEBAB_PATTERN = '[a-z0-9]+(?:-[a-z0-9]+)*';

/** A kebab-case id (`workflow.id`, `node.id`, `agent.id`, `agent_ref`). */
export const kebabIdSchema = z
  .string()
  .regex(
    new RegExp(`^${KEBAB_PATTERN}$`),
    'must be kebab-case (lowercase alphanumerics, dash-separated)',
  );

/** A non-empty string. */
export const nonEmptyString = z.string().min(1);

/** A positive integer (>= 1). */
export const positiveInt = z.number().int().positive();

/** A non-negative integer (>= 0). */
export const nonNegativeInt = z.number().int().nonnegative();

/**
 * A generation temperature: a finite number in the provider-agnostic `[0, 2]` envelope
 * (no NaN/Infinity/negative). Shared by `AgentSchema` and the agent node override so the
 * bound lives in one place. Per-provider limits (e.g. Anthropic's `[0, 1]`) are enforced in
 * the `@relavium/llm` adapter, not here — the contract stays provider-agnostic.
 */
export const temperatureSchema = z.number().finite().min(0).max(2);
