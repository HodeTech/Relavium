import type { Agent, ReasoningEffort } from '@relavium/shared';

import { agentDetailOf, type AgentDetail } from '../history/agents-model.js';
import { scrubbedBounded } from '../history/run-detail-model.js';
import { isBuiltInChatAgent } from './default-agent.js';

/**
 * What a chat shows of the agent it is bound to ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §3, MVP-8 step 5): the fields of the `/agents` detail, read from the definition the SESSION holds, never from a file. A chat binds one
 * agent for its whole lifetime (ADR-0024) and a `/models` reseat builds a new session over a swapped copy of it, so the definition a session
 * holds IS the provider and the model it runs on now, and a re-read of the catalog file could say something else (the file was edited, or
 * the model was switched).
 *
 * PURE: nothing is read, written or sent. Every free-form string leaves through the one scrub-and-bound floor the `/agents` detail uses
 * ({@link agentDetailOf}), the system prompt scrubbed whole and then cut to its head, so the same agent is masked the same way on both
 * screens. Nothing of the file is carried: no path, no full prompt, no MCP server reference and no fallback chain.
 */

export interface BoundAgentView {
  /** The agent's id, sanitized and bounded. */
  readonly id: string;
  /** The agent's own name, sanitized and bounded; absent when it declares none. */
  readonly name: string | undefined;
  /** The definition is the built-in default chat agent ({@link isBuiltInChatAgent}), not an authored one. */
  readonly builtIn: boolean;
  /**
   * The provider and model the session runs on, the tool grant as declared, the temperature and the prompt's head. Its `reasoningEffort`
   * is the tier the DEFINITION declares; the tier the session is using is {@link BoundAgentView.sessionEffort}.
   */
  readonly detail: AgentDetail;
  /**
   * The reasoning-effort tier the session is using at the moment the view was made: the one the chat's footer shows (`/effort` and the
   * `/models` effort step change it on the session only, never on the definition), or `undefined` where the footer shows none (a model that
   * takes no tier). It can differ from {@link AgentDetail.reasoningEffort}, which is what the definition declares.
   */
  readonly sessionEffort: ReasoningEffort | undefined;
}

/**
 * The view of the agent a session holds, with the tier the session is using now. Made afresh on every use: the definition never changes in a
 * session, but the tier does, and a view kept past an `/effort` would say the old one.
 */
export function boundAgentView(
  agent: Agent,
  sessionEffort: ReasoningEffort | undefined,
): BoundAgentView {
  return {
    id: scrubbedBounded(agent.id),
    name: agent.name === undefined ? undefined : scrubbedBounded(agent.name),
    builtIn: isBuiltInChatAgent(agent),
    detail: agentDetailOf(agent),
    sessionEffort,
  };
}
