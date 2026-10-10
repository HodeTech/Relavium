/**
 * Session **export-to-workflow** (1.Z) — the inverse of the parser (1.L is parse-only). Two pure functions:
 *
 * - {@link serializeWorkflow} emits a {@link WorkflowDefinition} as **deterministic, round-trippable** YAML
 *   (map keys sorted alphabetically, array order preserved) so `parse → serialize` is byte-stable.
 * - {@link sessionToWorkflow} maps a persisted session (`AgentSessionRecord` + its ordered
 *   `SessionMessage[]`, 1.X) into a **linear-chain scaffold** `WorkflowDefinition`
 *   ([ADR-0026](../../../../docs/decisions/0026-session-export-to-workflow.md); the mapping contract lives
 *   in [agent-session-spec.md](../../../../docs/reference/contracts/agent-session-spec.md) §"Export to
 *   workflow" §"Precise mapping"): one `agent` node per assistant turn, `input → turn-1 → … → output`
 *   edges, the bound agent inline, and the **full transcript** under `metadata.relaviumExport`.
 *
 * Both are deterministic (no wall-clock / randomness) and platform-free — the host (CLI `relavium
 * chat-export`, the desktop "Export to Canvas") loads the session via the `@relavium/db` `SessionStore`
 * and writes the file; this module never touches the DB or the filesystem. Structural tool values and
 * reasoning signatures are excluded by `SessionContentPart`. User-authored text can still be sensitive.
 */

import {
  SCHEMA_VERSION,
  type AgentSessionRecord,
  type SessionContentPart,
  type SessionMessage,
} from '@relavium/shared';
import { stringify as stringifyYaml } from 'yaml';

import { completedSessionTurns } from '../engine/session-resume.js';

import type { AgentDefinition } from '../agent-parser.js';
import type { WorkflowDefinition } from '../parser.js';

type WorkflowSpec = WorkflowDefinition['workflow'];
type WorkflowNode = WorkflowSpec['nodes'][number];
type WorkflowEdge = WorkflowSpec['edges'][number];
type AgentNode = Extract<WorkflowNode, { type: 'agent' }>;

/**
 * Emit a {@link WorkflowDefinition} as YAML. Map keys are sorted alphabetically and array element order is
 * preserved, so the output is deterministic and `parse(serialize(def))` followed by another serialize is
 * byte-stable. Faithful: it serializes exactly what it is given — the secret/signature exclusion is upheld
 * by the durable types that feed it (see {@link sessionToWorkflow}), not by scrubbing here.
 */
export function serializeWorkflow(workflow: WorkflowDefinition): string {
  return stringifyYaml(workflow, { sortMapEntries: true });
}

/**
 * Emit an {@link AgentDefinition} as deterministic YAML (map keys sorted alphabetically, array order preserved),
 * so `parse(serialize(agent))` is byte-stable — the `.agent.yaml` counterpart of {@link serializeWorkflow}. An
 * agent document is plain config (model / provider / system_prompt / tools / mcp_servers) that carries **no
 * secret VALUES** by construction — provider keys live in the OS keychain and are never schema-representable, and
 * an MCP server's `env` references a secret only by `{{secrets.*}}` placeholder ([ADR-0006](../../../../docs/decisions/0006-os-keychain-for-api-keys.md)/[ADR-0029](../../../../docs/decisions/0029-tool-policy-hardening.md))
 * — so the emitted file is share-safe, and re-serializing from the *validated* AST additionally drops any
 * authored comments. Used by `relavium create` / `import` / `export` (2.J authoring).
 */
export function serializeAgent(agent: AgentDefinition): string {
  return stringifyYaml(agent, { sortMapEntries: true });
}

/** The concatenated `text` parts of a durable content array (non-text parts are dropped). */
function textOf(content: readonly SessionContentPart[]): string {
  return content
    .filter((part): part is Extract<SessionContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n');
}

/** The tool names invoked in a turn — the `tool_call` parts of an assistant message's content. */
function toolsUsedIn(content: readonly SessionContentPart[]): string[] {
  return content
    .filter(
      (part): part is Extract<SessionContentPart, { type: 'tool_call' }> =>
        part.type === 'tool_call',
    )
    .map((part) => part.name)
    .filter((name) => name !== 'unknown_tool');
}

/**
 * Neutralize interpolation openers in user free-text destined for `prompt_template`. The exporter copies a
 * chat message verbatim, but `prompt_template` is parsed as a **template** (workflow-yaml-spec.md), so a
 * stray `{{ secrets.X }}` a user happened to type would be rejected by the parse-time secret-taint gate
 * (ADR-0029) and break the round-trip — and `{{ inputs.X }}` would silently become a live reference, which
 * literal chat text is not. Inserting a space after each `{` that opens a `{{` digraph keeps the text
 * readable, prevents any synthetic reference, and round-trips byte-stably. The FULL verbatim text is
 * preserved untouched under `metadata.relaviumExport` (metadata is not interpolation-scanned).
 */
function neutralizeInterpolation(text: string): string {
  return text.replace(/\{(?=\{)/g, '{ ');
}

/**
 * A kebab-case workflow id derived deterministically from the session (its title, else a fixed default).
 * Built by splitting on non-alphanumeric runs and rejoining with single dashes — identical output to a
 * collapse-then-trim, but with no anchored-alternation regex (the only pattern left is one bounded char
 * class, which is linear), so it avoids the false-positive ReDoS hotspot Sonar raises on `/^-+|-+$/`.
 *
 * Only ASCII alphanumerics survive — `kebabIdSchema` (the id's contract) is ASCII, so a non-ASCII title is
 * stripped to its ASCII run(s) (e.g. Turkish "İstanbul Sohbeti" → "stanbul-sohbeti") or falls back to
 * `exported-session` when nothing ASCII remains. Unicode slugs are a separate future concern; the scaffold's
 * id is human-reviewed and renameable on the canvas.
 */
function workflowIdFor(record: AgentSessionRecord): string {
  const slug = (record.title ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((segment) => segment.length > 0)
    .join('-');
  return slug.length > 0 ? slug : 'exported-session';
}

/**
 * Map a persisted session + its ordered transcript into a linear-chain scaffold `WorkflowDefinition`
 * (ADR-0026). Deterministic — the same `record` + `messages` always produce the same definition (no
 * wall-clock / randomness), so the emitted YAML round-trips. Assumes a well-formed, user-initiated
 * transcript (each turn opens with a `user` message, as `AgentSession` emits). Orphaned assistant rows
 * remain in metadata and never become completed-turn nodes.
 */
export function sessionToWorkflow(
  record: AgentSessionRecord,
  messages: readonly SessionMessage[],
): WorkflowDefinition {
  const ordered = [...messages].sort((a, b) => a.sequenceNumber - b.sequenceNumber);

  const nodes: WorkflowNode[] = [{ id: 'input', type: 'input' }];
  const edges: WorkflowEdge[] = [];
  let previousNodeId = 'input';
  let turnIndex = 0;

  for (const turn of completedSessionTurns(ordered, false)) {
    turnIndex += 1;
    const nodeId = `turn-${turnIndex}`;
    const prompt = neutralizeInterpolation(
      [...turn.legacyUserPrefix, turn.user]
        .map((message) => textOf(message.content))
        .filter((text) => text.length > 0)
        .join('\n\n'),
    );
    const tools = [...new Set(turn.messages.flatMap((message) => toolsUsedIn(message.content)))]; // dedupe across the turn, first-seen order (determinism-safe)
    const node: AgentNode = {
      id: nodeId,
      type: 'agent',
      agent_ref: record.agentSlug,
      ...(prompt.length > 0 ? { prompt_template: prompt } : {}),
      ...(tools.length > 0 ? { tools } : {}),
    };
    nodes.push(node);
    edges.push({ from: previousNodeId, to: nodeId });
    previousNodeId = nodeId;
  }

  nodes.push({ id: 'output', type: 'output' });
  edges.push({ from: previousNodeId, to: 'output' });

  // The full transcript under one reserved metadata key (agent-session-spec.md §"Precise mapping").
  const metadata: Record<string, unknown> = {
    relaviumExport: {
      source: 'session',
      sessionId: record.id,
      agentSlug: record.agentSlug,
      ...(record.title === undefined ? {} : { title: record.title }),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      messages: ordered,
    },
  };

  const spec: WorkflowSpec = {
    id: workflowIdFor(record),
    ...(record.title === undefined ? {} : { name: record.title }),
    ...(record.agentSnapshot === undefined ? {} : { agents: [record.agentSnapshot] }),
    nodes,
    edges,
    metadata,
  };

  return { schema_version: SCHEMA_VERSION, workflow: spec };
}
