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

export const EdgeSchema = z
  .object({
    from: fromSchema,
    to: toSchema,
    label: z.string().optional(),
    /**
     * **Accepted by the shape, then REFUSED** — deliberately, rather than deleted from the object.
     *
     * Three canonical documents described this field as gating its edge, and nothing anywhere read it: an
     * author could write it, `.strict()` accepted it, and it did nothing. A field that silently does
     * nothing is the same defect as a condition that silently evaluates `false` — a wrong answer wearing
     * the shape of a right one ([ADR-0093](../../../docs/decisions/0093-an-expression-sees-only-what-it-is-ordered-after.md) §3).
     *
     * Keeping the key in the shape is what lets the refusal below name it and say what to use instead.
     * Removing it would leave `.strict()` to report a bare "unrecognized key", which tells an author that
     * they typed something wrong but not that the thing they meant has a different home.
     */
    condition: z.string().optional(),
  })
  .strict() // authored YAML: an unknown/typo'd key is rejected, not silently stripped (ADR-0023)
  .superRefine((edge, ctx) => {
    if (edge.condition !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['condition'],
        // The authored expression is NOT echoed: it is untrusted authored text, and error-handling.md's
        // rule is that a message never carries an authored value.
        message:
          'an edge `condition` is not supported in v1.0 — it was read by nothing, so it silently did not gate this edge; route with a `condition` node and its `branches[].target_node` instead (ADR-0093)',
      });
    }
  });
export type Edge = z.infer<typeof EdgeSchema>;
