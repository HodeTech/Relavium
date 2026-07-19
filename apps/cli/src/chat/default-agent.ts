import { catalogModel, type ProviderId } from '@relavium/llm';
import type { Agent, ReasoningEffort } from '@relavium/shared';

import { CliError } from '../process/errors.js';

/**
 * The built-in **default chat agent** (the agent-first decision for 2.M): when `relavium chat` is started
 * without `--agent`, the session binds a synthesized agent over `[chat].default_model` so the REPL is a
 * zero-config first-run demo (chat-session.md, ADR-0024 "chat-mode default applies"). The grant is
 * deliberately a small **read-only, locally-safe** tool set — anything that writes, executes, or egresses
 * requires an explicit `--agent` — and even these are still gated by the session's fs-scope tier + the host
 * capabilities (secure-by-default; the host's `ToolHost` is fail-closed until tool capabilities are wired).
 */

/** The zero-config chat model when neither `--agent` nor `[chat].default_model` names one (config-spec.md). */
export const DEFAULT_CHAT_MODEL = 'claude-sonnet-4-6';

/** The default chat agent's id (kebab) — recorded on `session:started`, and exported verbatim as `agent_ref` (1.Z). */
export const DEFAULT_CHAT_AGENT_ID = 'relavium-chat';

const DEFAULT_CHAT_SYSTEM_PROMPT =
  "You are Relavium's built-in chat assistant, running locally in the user's terminal via `relavium chat`. " +
  'Be concise, accurate, and helpful. You are granted a small set of read-only local tools (reading files, ' +
  "listing directories, and git status), each subject to the session's filesystem scope and the host's " +
  'configuration — a tool may be unavailable, in which case say so plainly rather than guessing. You cannot ' +
  'modify files, run commands, or access the network unless the user binds an agent that grants those tools. ' +
  'When a request is ambiguous, ask a brief clarifying question.';

/**
 * The read-only, locally-safe built-in tools granted to the default agent. Write (`write_file`), exec
 * (`run_command`), commit (`git_commit`), and egress (`http_request` / `web_search` / `mcp_call`) tools are
 * **excluded** — a user who wants them binds an explicit `--agent`. The grant is still narrowed at dispatch
 * by the session's fs-scope tier and the host capabilities (ADR-0029 narrow-only; secure-by-default).
 */
export const DEFAULT_CHAT_TOOLS: readonly string[] = ['read_file', 'list_directory', 'git_status'];

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
        `with 'relavium chat --agent <ref>'.`,
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
