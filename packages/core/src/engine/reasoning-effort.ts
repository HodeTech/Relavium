import type { ReasoningEffort } from '@relavium/shared';

/**
 * Gate the normalized reasoning-effort tier ([ADR-0066](../../../../docs/decisions/0066-normalized-reasoning-effort-control.md))
 * against a model's per-model capability. The tier is sent to the provider ONLY when BOTH hold: an effort was
 * resolved (authored on the agent, a `[chat]` config default baked onto the agent, or a session-level override) AND
 * the host's per-model capability projection (`resolveReasoning`, the ADR-0064 catalog capability) says THIS model
 * reasons. A non-reasoning model would reject the field, so an unknown/absent resolver (`undefined`) is treated as
 * NOT reasoning — the field is withheld (the safe default; §4).
 *
 * The one home for the gate (used by both the workflow `AgentRunner` path and the `AgentSession` per-turn build) so
 * the rule cannot drift between them. Pure — `packages/core` stays platform-free; the host injects `resolveReasoning`.
 */
export function gateReasoningEffort(
  effort: ReasoningEffort | undefined,
  model: string,
  resolveReasoning: ((model: string) => boolean | undefined) | undefined,
): ReasoningEffort | undefined {
  return effort !== undefined && resolveReasoning?.(model) === true ? effort : undefined;
}
