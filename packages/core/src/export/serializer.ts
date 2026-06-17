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
 * and writes the file; this module never touches the DB or the filesystem. A `secret` value can never
 * appear (secrets never reach a message, ADR-0029) and a reasoning `signature` can never appear (the
 * transcript is `DurableContentPart`, which structurally omits it, ADR-0030).
 */

import {
  SCHEMA_VERSION,
  type AgentSessionRecord,
  type DurableContentPart,
  type SessionMessage,
} from '@relavium/shared';
import { stringify as stringifyYaml } from 'yaml';

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

/** The concatenated `text` parts of a durable content array (non-text parts are dropped). */
function textOf(content: readonly DurableContentPart[]): string {
  return content
    .filter((part): part is Extract<DurableContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n');
}

/** The tool names invoked in a turn — the `tool_call` parts of an assistant message's content. */
function toolsUsedIn(content: readonly DurableContentPart[]): string[] {
  return content
    .filter(
      (part): part is Extract<DurableContentPart, { type: 'tool_call' }> =>
        part.type === 'tool_call',
    )
    .map((part) => part.name);
}

/** The text of the contiguous `user` message(s) immediately preceding an assistant turn — its prompt. */
function precedingUserText(ordered: readonly SessionMessage[], assistantIndex: number): string {
  const segments: string[] = [];
  for (let j = assistantIndex - 1; j >= 0; j -= 1) {
    const message = ordered[j];
    if (message === undefined || message.role !== 'user') {
      break;
    }
    const text = textOf(message.content);
    if (text.length > 0) {
      segments.unshift(text);
    }
  }
  return segments.join('\n\n');
}

/** A kebab-case workflow id derived deterministically from the session (its title, else a fixed default). */
function workflowIdFor(record: AgentSessionRecord): string {
  const slug = (record.title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'exported-session';
}

/**
 * Map a persisted session + its ordered transcript into a linear-chain scaffold `WorkflowDefinition`
 * (ADR-0026). Deterministic — the same `record` + `messages` always produce the same definition (no
 * wall-clock / randomness), so the emitted YAML round-trips.
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

  ordered.forEach((message, i) => {
    if (message.role !== 'assistant') {
      return;
    }
    turnIndex += 1;
    const nodeId = `turn-${turnIndex}`;
    const prompt = precedingUserText(ordered, i);
    const tools = toolsUsedIn(message.content);
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
  });

  nodes.push({ id: 'output', type: 'output' });
  edges.push({ from: previousNodeId, to: 'output' });

  // The full transcript under one reserved metadata key (agent-session-spec.md §"Precise mapping").
  const metadata: Record<string, unknown> = {
    relaviumExport: {
      source: 'session',
      sessionId: record.id,
      agentSlug: record.agentSlug,
      ...(record.title !== undefined ? { title: record.title } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      messages: ordered,
    },
  };

  const spec: WorkflowSpec = {
    id: workflowIdFor(record),
    ...(record.title !== undefined ? { name: record.title } : {}),
    ...(record.agentSnapshot !== undefined ? { agents: [record.agentSnapshot] } : {}),
    nodes,
    edges,
    metadata,
  };

  return { schema_version: SCHEMA_VERSION, workflow: spec };
}
