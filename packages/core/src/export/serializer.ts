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

/** A logical turn: the contiguous `user` message(s) plus the assistant/tool messages that answer them. */
interface TurnDraft {
  promptSegments: string[];
  toolNames: string[];
  hasAssistant: boolean;
}

/**
 * Segment an ordered transcript into logical TURNS. The spec maps one `agent` node per **turn**, not per
 * assistant message — a host may persist a single turn as split rows (`user → assistant(tool_call) → tool →
 * assistant(text)`), and emitting a node per assistant message would split that one turn into two (the second
 * losing its prompt + tools). A turn begins at a `user` message that follows an already-answered turn;
 * contiguous `user` messages merge into one prompt; `tool`/`system` messages are not delimiters and add no
 * node content (a turn's tools come from its assistant messages' `tool_call` parts). Mirrors the turn model
 * `reconstructSessionState` (1.Y) uses.
 */
function groupIntoTurns(ordered: readonly SessionMessage[]): TurnDraft[] {
  const turns: TurnDraft[] = [];
  let current: TurnDraft | null = null;
  for (const message of ordered) {
    if (message.role === 'user') {
      if (current !== null && current.hasAssistant) {
        turns.push(current);
        current = null;
      }
      current ??= { promptSegments: [], toolNames: [], hasAssistant: false };
      const text = textOf(message.content);
      if (text.length > 0) {
        current.promptSegments.push(text);
      }
    } else if (message.role === 'assistant') {
      current ??= { promptSegments: [], toolNames: [], hasAssistant: false };
      current.hasAssistant = true;
      current.toolNames.push(...toolsUsedIn(message.content));
    }
  }
  if (current !== null) {
    turns.push(current);
  }
  return turns;
}

/**
 * A kebab-case workflow id derived deterministically from the session (its title, else a fixed default).
 * Built by splitting on non-alphanumeric runs and rejoining with single dashes — identical output to a
 * collapse-then-trim, but with no anchored-alternation regex (the only pattern left is one bounded char
 * class, which is linear), so it avoids the false-positive ReDoS hotspot Sonar raises on `/^-+|-+$/`.
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

  for (const turn of groupIntoTurns(ordered)) {
    if (!turn.hasAssistant) {
      continue; // an unanswered (user-only) trailing turn is not a completed exchange
    }
    turnIndex += 1;
    const nodeId = `turn-${turnIndex}`;
    const prompt = neutralizeInterpolation(turn.promptSegments.join('\n\n'));
    const tools = [...new Set(turn.toolNames)]; // dedupe across the turn, first-seen order (determinism-safe)
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
