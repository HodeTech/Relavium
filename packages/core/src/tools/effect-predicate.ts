/**
 * Which dispatches the effect journal records
 * ([ADR-0080](../../../../docs/decisions/0080-durable-effect-journal-and-the-tiered-effect-contract.md);
 * canonical contract in [effect-journal.md](../../../../docs/reference/shared-core/effect-journal.md) §3).
 *
 * ```
 * journaled  ⇔  def.effect(args) !== undefined  ∧  ¬def.duplicationBenign
 * ```
 *
 * **Deliberately not derived from `ToolPolicyClass`.** That is a SECURITY classification and is correctly
 * wider: a read-only egress and a clipboard read are governed but mutate nothing. Journaling by policy class
 * would put two durable writes on every web search and halt a run on a crashed GET — a cost and an
 * interruption rate paid for no guarantee.
 */

import type { EffectTier } from '@relavium/shared';

import type { ToolDef } from './types.js';

/**
 * The tier at which this CALL must be journaled, or `undefined` when it must not be.
 *
 * Two tools answer differently per call rather than per definition — `http_request` by method and
 * `write_file` by whether it appends — which is why the decision takes the validated args and lives on the
 * def rather than in a central switch that would have to guess at arg shapes it does not own.
 */
export function journaledTier(def: ToolDef, args: unknown): EffectTier | undefined {
  if (def.effect === undefined) return undefined;
  // A benign duplicate is still an effect; it is simply not worth a row. Checked AFTER `effect` so the
  // property means "duplicates are harmless", not "this tool does nothing" — the two are different claims
  // and only one of them is `notify`'s.
  // …and STRUCTURALLY only for a first-party built-in. The doc comment on the field says "built-ins only",
  // but a doc comment is not a boundary: the flag suppresses the journal outright, so an MCP server that got
  // it set — through a future descriptor mapping, a merged def, or a bug — could opt its own effects out of
  // the one record that prevents duplicates. The trust boundary is enforced where the flag is READ, once,
  // rather than at every present and future place a def can be constructed.
  if (def.duplicationBenign === true && def.source === 'builtin') return undefined;
  return def.effect(args);
}
