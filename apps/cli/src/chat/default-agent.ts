import { isDeepStrictEqual } from 'node:util';

import { catalogModel, type ProviderId } from '@relavium/llm';
import type { Agent, ReasoningEffort } from '@relavium/shared';

import { KNOWN_PROVIDERS } from '../engine/providers.js';
import { CliError } from '../process/errors.js';

/**
 * The built-in **default chat agent** (the agent-first decision for 2.M): when `relavium chat` is started
 * without `--agent`, the session binds a synthesized agent over `[chat].default_model` so the REPL is a
 * zero-config conversation (chat-session.md, ADR-0024). ADR-0116 grants local reading, discovery and
 * reviewable editing; the current mode, approval, scope and protected-path floors govern every write.
 * ADR-0118 adds `run_command`: every command is the person's decision (a card in `ask` and `accept-edits`, refused in
 * `plan`, a card in `auto` unless it was already approved), and it is not advertised at all where no one can answer.
 * Egress and ambient OS tools require an explicitly bound agent. Missing host capabilities remain fail-closed.
 */

/**
 * The zero-config chat model when neither `--agent` nor `[chat].default_model` names one and no other provider has a key (config-spec.md):
 * Anthropic's STARTER model, read from the one starter table (`KNOWN_PROVIDERS`, ADR-0146 §6), never spelled here. A deliberate, user-visible
 * default the maintainer ruled on 2026-11-24: a first chat starts on the current family (Haiku 5.5), the model a first setup also chooses.
 */
export const DEFAULT_CHAT_MODEL: string = KNOWN_PROVIDERS.anthropic.starterModel;

/** The default chat agent's id (kebab) — recorded on `session:started`, and exported verbatim as `agent_ref` (1.Z). */
export const DEFAULT_CHAT_AGENT_ID = 'relavium-chat';

const DEFAULT_CHAT_SYSTEM_PROMPT =
  "You are Relavium's built-in chat assistant, running locally in the user's terminal via `relavium chat`. " +
  'Be concise, accurate, and helpful. You can read, find and search local files, list directories, inspect git ' +
  'status, and propose precise edits or file writes. Tools are subject to the current mode, filesystem scope ' +
  "and protected-path rules. In ask mode each write needs the user's approval; plan mode is read-only; " +
  'accept-edits applies file edits without asking; auto mode approves granted ordinary actions without ' +
  'prompting, while hard path restrictions still apply. ' +
  'Before editing or appending, read the relevant current file content during the same turn. Use exact, ' +
  'unambiguous replacements and inspect tool results; never claim an edit succeeded without evidence. ' +
  'If a tool or write is unavailable or refused, explain that plainly rather than trying another way around ' +
  'the restriction. You can run a program with the run_command tool: give the executable and its arguments, ' +
  'exactly as they should be passed, because there is no shell (no pipes, redirects, globs or variables). ' +
  'Every command is shown to the user and needs their approval, except in auto mode where only a command ' +
  'they remembered or approved for the session runs without asking; plan mode cannot run commands. If a command is refused, ' +
  'explain that and ask what they would like instead of trying another way to run it. ' +
  'You have no network or ambient OS tools. ' +
  'When a request is ambiguous and the user can answer with a choice, use the ask_user tool if it is available; ' +
  'otherwise ask a brief clarifying question in plain text.';

/**
 * ADR-0116's editing/search grant, enabled after the prepared-write approval surface (ADR-0120).
 * Mode, scope and confidentiality floors still narrow this grant at dispatch.
 * `run_command` is in the grant since ADR-0118: its card shows the whole command. Egress and ambient OS tools remain opt-in
 * through an authored agent.
 */
export const DEFAULT_CHAT_TOOLS: readonly string[] = [
  'read_file',
  'list_directory',
  'git_status',
  'search_files',
  'find_files',
  'write_file',
  'edit_file',
  // ADR-0118: a program and its arguments, run without a shell. Governed (never advertised where no one can answer a card).
  'run_command',
  // ADR-0132: a structured question to the person. Not a governed action and never a permission; it is offered only
  // where the driver wired a question card, so the grant is inert on a non-interactive surface.
  'ask_user',
];

/**
 * Whether `agent` IS the built-in default chat agent: its WHOLE definition is the one {@link buildDefaultChatAgent} makes for the agent's own
 * model, provider and reasoning tier, field for field. The id alone is not the test (a repository file can be named `relavium-chat`), nor is
 * a subset of its fields (a file with the built-in prompt and grant but a name, a memory policy, an output schema, a fallback chain or a
 * token cap of its own is an authored agent, and a screen that called it built-in would vouch for fields the repository wrote). The model,
 * the provider and the reasoning tier are free, because `/models` swaps them on a session of the built-in agent and the config default
 * chooses the first. A snapshot written before the built-in definition last changed is not recognised, and is then shown as the agent it is.
 */
export function isBuiltInChatAgent(agent: Agent): boolean {
  return isDeepStrictEqual(
    agent,
    buildDefaultChatAgent(agent.model, agent.reasoning_effort, agent.provider),
  );
}

/**
 * Infer the provider that serves a model id — **catalog first** (ADR-0071), then a well-known-prefix fallback.
 *
 * A default agent must name a provider ({@link Agent.provider}). The catalog knows the provider of every model it
 * carries AUTHORITATIVELY, regardless of how the id is spelled — `chatgpt-4o-latest` has no `gpt`/`o<digit>` prefix
 * yet is unmistakably openai — so a catalog hit is trusted before the heuristic. The prefix map remains the fallback
 * for an id the catalog does not carry (a brand-new model, or a custom `base_url` endpoint), covering the four
 * `@relavium/llm` seam providers (ADR-0011). Returns `undefined` for an id neither knows, so the caller fails with a
 * clear "bind an explicit `--agent`" message rather than guess wrong.
 *
 * The truly robust source is a PERSISTED provider from pick time (the picker knows it authoritatively — the live
 * `/models` list is per-provider); {@link buildDefaultChatAgent} prefers that and only falls back to this inference.
 */
export function inferProviderFromModel(model: string): ProviderId | undefined {
  // Normalize ONCE — catalog ids are lowercase, and the prefix fallback lowercases too, so a mixed-case id
  // (`Claude-Opus-4-8`) resolves via the CATALOG (authoritative) instead of only via the prefix heuristic.
  const m = model.toLowerCase();
  const cataloged = catalogModel(m)?.provider;
  if (cataloged !== undefined) return cataloged;
  if (m.startsWith('claude')) return 'anthropic';
  // OpenAI's GPT family + the o-series reasoning models. `/^o\d/` matches the whole o-series (o1/o3/o4 and
  // future o5+) in one expression rather than enumerating each prefix.
  if (m.startsWith('gpt') || /^o\d/.test(m)) return 'openai';
  if (m.startsWith('gemini')) return 'gemini';
  if (m.startsWith('deepseek')) return 'deepseek';
  return undefined;
}

/**
 * Build the built-in default chat agent over `model` (the resolved `[chat].default_model`, or
 * {@link DEFAULT_CHAT_MODEL}).
 *
 * `knownProvider` — the provider PERSISTED alongside the model (`[chat]`/`[preferences].default_provider`, written by
 * the picker/wizard at pick time, ADR-0059's "the provider is authoritative, never re-inferred"). When present it is
 * used verbatim and inference is SKIPPED, so a model whose id the prefix map cannot place — a live-discovered
 * `chatgpt-4o-latest`, a custom-endpoint id — still starts. Only when it is absent does this fall back to
 * {@link inferProviderFromModel}; a clean exit-2 {@link CliError} then guides the user to a known model or `--agent`.
 * `reasoningEffort` (the resolved `[chat].reasoning_effort`, ADR-0066) is baked onto the agent so the default chat
 * honors the config default; absent ⇒ no reasoning control (the provider default).
 */
export function buildDefaultChatAgent(
  model: string,
  reasoningEffort?: ReasoningEffort,
  knownProvider?: ProviderId,
): Agent {
  const provider = knownProvider ?? inferProviderFromModel(model);
  if (provider === undefined) {
    throw new CliError(
      'invalid_invocation',
      `cannot infer a provider for chat model '${model}'. Set [chat].default_model to a known model ` +
        `(claude-*, gpt-*, gemini-*, deepseek-*) — or set [chat].default_provider, or bind an explicit agent ` +
        `(the --agent option when a chat is started).`,
    );
  }
  return {
    id: DEFAULT_CHAT_AGENT_ID,
    name: 'Relavium chat',
    model,
    provider,
    system_prompt: DEFAULT_CHAT_SYSTEM_PROMPT,
    tools: [...DEFAULT_CHAT_TOOLS],
    ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
  };
}
