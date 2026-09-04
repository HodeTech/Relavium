import { parseAgent, type AgentDefinition } from '@relavium/core';
import type { LlmProviderId, ReasoningEffort } from '@relavium/shared';

import { sourceLabel } from '../process/source-label.js';
import { resolveYamlSource } from '../workflows/resolve.js';
import { buildDefaultChatAgent, DEFAULT_CHAT_MODEL } from './default-agent.js';

export interface ResolveChatAgentOptions {
  readonly cwd: string;
  readonly projectConfigDir: string | undefined;
  /** The resolved `[chat].default_model` — used only to build the default agent when no `--agent` is given. */
  readonly defaultModel: string | undefined;
  /** The resolved `[chat].default_provider` (ADR-0059) — persisted at pick time, used verbatim for the DEFAULT
   *  agent so a live-discovered id whose prefix the inference cannot place still resolves. Absent ⇒ inference. */
  readonly defaultProvider?: LlmProviderId;
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
  return resolveChatAgentSource(agentRef, opts).agent;
}

/** The resolved agent together with the FILE it came from — `undefined` for the built-in default. */
export interface ResolvedChatAgent {
  readonly agent: AgentDefinition;
  /**
   * The path the agent was read from, for the MCP consent prompt.
   *
   * Not folded into `AgentDefinition`: that shape is the parsed artifact, is persisted into a session
   * snapshot, and is produced by the pure core parser, which has no business carrying a host path. It
   * travels beside the agent instead —
   * [ADR-0084](../../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §7 requires the prompt
   * to name the declaring file, and `chat --agent ./downloaded.agent.yaml` is precisely the imported-artifact
   * case the gate exists for, so "the user typed a word" is not a good enough answer there.
   */
  readonly artifact: string | undefined;
}

/** {@link resolveChatAgent}, plus the source path the consent prompt needs. */
export function resolveChatAgentSource(
  agentRef: string | undefined,
  opts: ResolveChatAgentOptions,
): ResolvedChatAgent {
  if (agentRef === undefined) {
    return {
      agent: buildDefaultChatAgent(
        opts.defaultModel ?? DEFAULT_CHAT_MODEL,
        opts.reasoningEffort,
        opts.defaultProvider,
      ),
      artifact: undefined,
    };
  }
  const source = resolveYamlSource(agentRef, {
    cwd: opts.cwd,
    kind: 'agent',
    subdir: 'agents',
    projectConfigDir: opts.projectConfigDir,
    idSuffixes: ['.agent.yaml', '.relavium.yaml', '.yaml'],
  });
  // The source label rides into `AgentParseError.message`, which the CLI now promotes to the user
  // (process/errors.ts). An absolute path there is what the error contract forbids, so it is relative
  // before it is handed over — `artifact` keeps the real path for the caller's own use.
  return {
    agent: parseAgent(source.yaml, { source: sourceLabel(opts.cwd, source.path) }),
    artifact: source.path,
  };
}
