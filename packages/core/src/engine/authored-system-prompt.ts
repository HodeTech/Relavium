/**
 * The `system` role carries AUTHORED instruction and nothing else
 * ([ADR-0081](../../../../docs/decisions/0081-the-compaction-summary-is-untrusted-and-the-system-prompt-is-branded.md) §1).
 *
 * **Why a type and not a rule.** The rule already existed — `AgentTurnParams.system`'s doc comment has said
 * "authored system text ONLY … never untrusted data" since 1.O — and the rule is what ADR-0062 §1 broke: it
 * concatenated a model-written summary of untrusted input into `system`, behind an XML fence that the
 * untrusted text can close. A convention that has already failed once is not the mechanism to fix it with.
 *
 * So `system` becomes a branded string that only the constructors below can produce. Ordinary typed code
 * cannot reach the field with a dynamic value; a deliberate `as` still can, which is why the mechanism ships
 * with a `no-restricted-syntax` fence in `eslint.config.mjs` that reports exactly that assertion. The claim
 * is "a forgery is visible", not "a forgery is impossible" — see the ADR, which says so in those words.
 *
 * The brand is erased at runtime and stops at the `@relavium/llm` seam: `LlmRequest.system` is still
 * `z.string().optional()`, and nothing about the seam's shape changes (ADR-0011 is cited, not amended).
 */

import type { Agent } from '@relavium/shared';

import type { AgentPlanConfig } from '../run-plan.js';

/** The planned agent vertex, whose `system_prompt_append` is the only other authored source. */
type AgentNode = AgentPlanConfig['node'];

declare const AUTHORED: unique symbol;

/** A system prompt the ENGINE authored. Constructible only via {@link authoredSystemPrompt}. */
export type AuthoredSystemPrompt = string & { readonly [AUTHORED]: true };

/**
 * The engine's own authored prompts, named by IDENTITY rather than passed as text.
 *
 * This arm exists because the engine genuinely has a third authored producer, and the first draft of
 * ADR-0081 missed it: `compact()` passes a summariser system prompt that no agent or node can supply. An
 * arm taking an arbitrary string would be the escape hatch the whole design forbids, so it takes a closed
 * union of identities and resolves each to an engine-owned constant.
 */
export type EngineAuthoredPrompt = 'compaction';

/** Where an authored system prompt may come from — a closed set, deliberately. */
export type AuthoredSystemPromptSource =
  | { readonly kind: 'agent'; readonly agent: Agent; readonly node?: AgentNode }
  | { readonly kind: 'engine'; readonly prompt: EngineAuthoredPrompt };

/**
 * The context-compaction summariser's own system prompt (ADR-0062 §7) — authored text, and the reason the
 * `engine` arm exists. The conversation being summarised rides a USER message, never this field.
 *
 * The canonical description of what a summary must preserve lives in
 * [chat-session.md](../../../../docs/reference/cli/chat-session.md) § Context compaction; this is the prompt
 * that encodes it.
 */
const COMPACTION_SYSTEM_PROMPT =
  'You are compacting a conversation to fit a smaller context window. Produce a concise, faithful summary ' +
  'of the conversation below that PRESERVES: open tasks and their current state; decisions taken and why; ' +
  'concrete code identifiers, file paths, commands, and values in play; and the user’s stated preferences ' +
  'and constraints. Omit pleasantries and redundant back-and-forth. Write it as notes for an assistant that ' +
  'will continue the conversation — not as a message to the user. Output ONLY the summary.';

const ENGINE_PROMPTS: Readonly<Record<EngineAuthoredPrompt, string>> = {
  compaction: COMPACTION_SYSTEM_PROMPT,
};

/**
 * Build the turn's system prompt from AUTHORED sources only.
 *
 * The `agent` arm reads `agent.system_prompt` and the node's `system_prompt_append` — nothing else, and
 * there is no third parameter through which a caller could smuggle in dynamic text.
 */
export function authoredSystemPrompt(source: AuthoredSystemPromptSource): AuthoredSystemPrompt {
  if (source.kind === 'engine') {
    return brand(ENGINE_PROMPTS[source.prompt]);
  }
  const append = source.node?.system_prompt_append;
  return brand(
    append === undefined || append.length === 0
      ? source.agent.system_prompt
      : `${source.agent.system_prompt}\n\n${append}`,
  );
}

/**
 * The ONE place the brand is applied. Private on purpose: exporting it would be the second constructor the
 * design forbids, and the lint fence would have nothing to fence.
 */
function brand(text: string): AuthoredSystemPrompt {
  // The single assertion in the codebase, and the reason the fence names this type: a brand is a
  // compile-time fiction with no runtime representation, so SOME expression has to mint it. Keeping that
  // expression here — unexported, one line, next to the reasoning — is what makes every other `as
  // AuthoredSystemPrompt` in the tree a lint error rather than a judgement call.
  return text as AuthoredSystemPrompt;
}
