import type { Agent, ReasoningEffort } from '@relavium/shared';

import { AGENT_TOOLS_MAX, agentDetailOf, type AgentDetail } from '../history/agents-model.js';
import { scrubbedBounded } from '../history/run-detail-model.js';
import { isBuiltInChatAgent } from './default-agent.js';

/** The longest the file label may be before it is cut: the bound the `/agents` row's path takes. */
const SOURCE_LABEL_CHARS = 256;

/**
 * What a chat shows of the agent it is bound to ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §3, MVP-8 step 5): the fields of the `/agents` detail, read from the definition the SESSION holds, never from a file. A chat binds one
 * agent for its whole lifetime (ADR-0024) and a `/models` reseat builds a new session over a swapped copy of it, so the definition a session
 * holds IS the provider and the model it runs on now, and a re-read of the catalog file could say something else (the file was edited, or
 * the model was switched).
 *
 * PURE: nothing is read, written or sent. Every free-form string leaves through the one scrub-and-bound floor the `/agents` detail uses
 * ({@link agentDetailOf}), the system prompt scrubbed whole and then cut to its head, so the same agent is masked the same way on both
 * screens. Of the file only a RELATIVE label is carried ({@link BoundAgentView.sourceLabel}): no absolute path, no full prompt, no MCP server
 * reference and no fallback chain.
 */

/**
 * What the host knows of the session that the definition alone does not say, both optional: a view made without them (a unit test, an
 * embedding that does not know) simply marks nothing and names no file.
 */
export interface BoundAgentFacts {
  /**
   * The tool ids the session actually OFFERS the model: the declared grant after the host narrowed it to what it wires
   * (`BuiltChatSession.wiredTools`). Absent ⇒ the host did not say, so no tool is marked.
   */
  readonly wiredTools?: readonly string[] | undefined;
  /**
   * The label of the file the definition was read from, relative to the working directory (`BuiltChatSession.agentSourceLabel`); absent for the
   * built-in agent and for a definition held in memory (a `/clear` or `/models` rebind, a resumed session).
   */
  readonly sourceLabel?: string | undefined;
}

/**
 * Which of the declared tools the host does not wire. `unwired[i]` answers for `detail.tools[i]` (the shown names, in the definition's order);
 * `declared` counts every declared tool, shown or cut, and `offered` how many of those the session offers.
 */
export interface ToolOffer {
  readonly unwired: readonly boolean[];
  readonly declared: number;
  readonly offered: number;
}

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
  /**
   * Which declared tools this chat does not offer, or `undefined` when the host did not say. The grant itself stays as declared
   * ({@link AgentDetail.tools}); this only marks it.
   */
  readonly toolOffer: ToolOffer | undefined;
  /** The catalog-relative label of the file the agent was read from, sanitized and bounded; `undefined` when there is no file to name. */
  readonly sourceLabel: string | undefined;
}

/** The marks of {@link ToolOffer}: the declared names are compared RAW with the offered ids, and only the scrubbed names are ever shown. */
function toolOfferOf(agent: Agent, wiredTools: readonly string[]): ToolOffer {
  const declared = agent.tools ?? [];
  const wired = new Set(wiredTools);
  const unwired = declared.map((name) => !wired.has(name));
  return {
    unwired: unwired.slice(0, AGENT_TOOLS_MAX),
    declared: declared.length,
    offered: unwired.filter((missing) => !missing).length,
  };
}

/**
 * The view of the agent a session holds, with the tier the session is using now. Made afresh on every use: the definition never changes in a
 * session, but the tier does, and a view kept past an `/effort` would say the old one.
 */
export function boundAgentView(
  agent: Agent,
  sessionEffort: ReasoningEffort | undefined,
  facts: BoundAgentFacts = {},
): BoundAgentView {
  return {
    id: scrubbedBounded(agent.id),
    name: agent.name === undefined ? undefined : scrubbedBounded(agent.name),
    builtIn: isBuiltInChatAgent(agent),
    detail: agentDetailOf(agent),
    sessionEffort,
    toolOffer: facts.wiredTools === undefined ? undefined : toolOfferOf(agent, facts.wiredTools),
    sourceLabel:
      facts.sourceLabel === undefined || facts.sourceLabel === ''
        ? undefined
        : scrubbedBounded(facts.sourceLabel, SOURCE_LABEL_CHARS),
  };
}
