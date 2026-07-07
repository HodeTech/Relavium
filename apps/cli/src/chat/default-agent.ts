import type { ProviderId } from '@relavium/llm';
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
 * Infer the provider that serves a model id from its well-known prefix. Phase-1 has no model→provider
 * catalog lookup wired for the chat path, and a default agent must name a provider ({@link Agent.provider});
 * this covers the four `@relavium/llm` seam providers (ADR-0011) and returns `undefined` for an unrecognized
 * model so the caller fails with a clear "bind an explicit `--agent`" message rather than guess wrong.
 */
export function inferProviderFromModel(model: string): ProviderId | undefined {
  const m = model.toLowerCase();
  if (m.startsWith('claude')) return 'anthropic';
  // OpenAI's GPT family + the o-series reasoning models. `/^o\d/` matches the whole o-series (o1/o3/o4 and
  // future o5+) in one expression rather than enumerating each prefix. (A model→provider catalog lookup is
  // the eventual robust source; this prefix map is the deliberate Phase-1 zero-config default.)
  if (m.startsWith('gpt') || /^o\d/.test(m)) return 'openai';
  if (m.startsWith('gemini')) return 'gemini';
  if (m.startsWith('deepseek')) return 'deepseek';
  return undefined;
}

/**
 * Build the built-in default chat agent over `model` (the resolved `[chat].default_model`, or
 * {@link DEFAULT_CHAT_MODEL}). Throws a clean exit-2 {@link CliError} when the provider cannot be inferred
 * from the model id — guiding the user to set a known `[chat].default_model` or bind an explicit `--agent`.
 * `reasoningEffort` (the resolved `[chat].reasoning_effort`, ADR-0066) is baked onto the agent so the default
 * chat honors the config default; absent ⇒ no reasoning control (the provider default).
 */
export function buildDefaultChatAgent(model: string, reasoningEffort?: ReasoningEffort): Agent {
  const provider = inferProviderFromModel(model);
  if (provider === undefined) {
    throw new CliError(
      'invalid_invocation',
      `cannot infer a provider for chat model '${model}'. Set [chat].default_model to a known model ` +
        `(claude-*, gpt-*, gemini-*, deepseek-*), or bind an explicit agent with ` +
        `'relavium chat --agent <ref>'.`,
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
