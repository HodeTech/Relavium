import { parseAgent, type AgentDefinition } from '@relavium/core';
import type { ReasoningEffort } from '@relavium/shared';

import { resolveYamlSource } from '../workflows/resolve.js';
import { buildDefaultChatAgent, DEFAULT_CHAT_MODEL } from './default-agent.js';

export interface ResolveChatAgentOptions {
  readonly cwd: string;
  readonly projectConfigDir: string | undefined;
  /** The resolved `[chat].default_model` — used only to build the default agent when no `--agent` is given. */
  readonly defaultModel: string | undefined;
  /** The resolved `[chat].reasoning_effort` (ADR-0066) — baked onto the DEFAULT agent only (an authored `--agent`
   *  owns its own `reasoning_effort`, never overridden by config). Absent ⇒ no reasoning control. */
  readonly reasoningEffort?: ReasoningEffort;
}

/**
 * Resolve the agent a `relavium chat` session binds for its whole lifetime (ADR-0024 — one agent per
 * session, no mid-session switching): an explicit `--agent <ref>` (an `.agent.yaml` path, or a bare id
 * discovered under `<projectConfigDir>/agents/`) parsed by the same strict core {@link parseAgent} a
 * workflow uses, or — when omitted — the {@link buildDefaultChatAgent built-in default agent} over
 * `[chat].default_model`. The host owns the file read ({@link resolveYamlSource}); the parser stays pure.
 * A missing ref is a clean exit-2 invocation error; an invalid `.agent.yaml` surfaces the raw, field-named
 * {@link AgentParseError} (deliberately NOT re-tagged as a CliError — see agent-source.test.ts).
 */
export function resolveChatAgent(
  agentRef: string | undefined,
  opts: ResolveChatAgentOptions,
): AgentDefinition {
  if (agentRef === undefined) {
    return buildDefaultChatAgent(opts.defaultModel ?? DEFAULT_CHAT_MODEL, opts.reasoningEffort);
  }
  const source = resolveYamlSource(agentRef, {
    cwd: opts.cwd,
    kind: 'agent',
    subdir: 'agents',
    projectConfigDir: opts.projectConfigDir,
    idSuffixes: ['.agent.yaml', '.relavium.yaml', '.yaml'],
  });
  return parseAgent(source.yaml, { source: source.path });
}
