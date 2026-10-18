/**
 * Session **export-to-workflow** (1.Z) — the inverse of the parser (1.L is parse-only). Two pure functions:
 *
 * - {@link serializeWorkflow} emits a {@link WorkflowDefinition} as **deterministic** YAML
 *   (map keys sorted alphabetically, array order preserved). Currently admitted definitions round-trip;
 *   frozen historical agents may require deliberate author repair before current parsing.
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
 * preserved. For a currently admitted definition, `parse(serialize(def))` followed by another serialize
 * is byte-stable; a frozen historical snapshot may require deliberate author repair before parsing. Faithful: it serializes exactly what it is given. Durable session types exclude structural
 * tool values/signatures (see {@link sessionToWorkflow}); authored text/config may still be sensitive.
 */
export function serializeWorkflow(workflow: WorkflowDefinition): string {
  return stringifyYaml(workflow, { sortMapEntries: true });
}

/**
 * Emit an {@link AgentDefinition} as deterministic YAML (map keys sorted alphabetically, array order preserved),
 * so currently admitted agents have byte-stable `parse(serialize(agent))` — the `.agent.yaml` counterpart of {@link serializeWorkflow}.
 * Re-serializing the validated AST drops authored comments, but faithfully retains its values: prompts,
 * descriptions and other authored config can contain sensitive literals. Keychain custody and MCP secret
 * placeholders do not make the whole document safe to share. Review before sharing; no scrubbing occurs
 * here. Used by `relavium create` / `import` / `export` (2.J authoring).
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

const MAX_WORKFLOW_ID_LENGTH = 128;
const SESSION_ID_PREFIX = 'exported-session-';
const MAX_ENCODED_SESSION_UNITS = 24;

/**
 * Preserve ordinary session ids (including production UUIDs) verbatim. The public session schema also
 * accepts arbitrary nonempty strings: encode the first 24 UTF-16 units as fixed-width lowercase hex
 * when the id is not already a bounded kebab id. This is deterministic and platform-free, including
 * lone surrogates, but truncation and title normalization can collide. No uniqueness is promised;
 * the complete original session id remains in export metadata.
 */
function fallbackWorkflowId(sessionId: string): string {
  if (
    sessionId.length <= MAX_WORKFLOW_ID_LENGTH - SESSION_ID_PREFIX.length &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sessionId)
  ) {
    return `${SESSION_ID_PREFIX}${sessionId}`;
  }
  let encoded = '';
  for (let index = 0; index < Math.min(sessionId.length, MAX_ENCODED_SESSION_UNITS); index += 1) {
    encoded += sessionId.charCodeAt(index).toString(16).padStart(4, '0');
  }
  return `${SESSION_ID_PREFIX}id-${encoded}`;
}

/**
 * Normalize a title to a bounded ASCII kebab id: compatibility decomposition, combining-mark removal,
 * lowercase, and explicit dotless-i/sharp-s mappings. This is not universal transliteration. An absent
 * or unusable title falls back to session identity; the human-reviewed scaffold id remains renameable.
 */
function workflowIdFor(record: AgentSessionRecord): string {
  const slug = (record.title ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/ß/g, 'ss')
    .split(/[^a-z0-9]+/)
    .filter((segment) => segment.length > 0)
    .join('-')
    .slice(0, MAX_WORKFLOW_ID_LENGTH)
    .replace(/-$/, '');
  return slug.length > 0 ? slug : fallbackWorkflowId(record.id);
}

/**
 * Map a persisted session + its ordered transcript into a linear-chain scaffold `WorkflowDefinition`
 * (ADR-0026). Deterministic — the same `record` + `messages` always produce the same definition (no
 * wall-clock / randomness). Frozen agent entries are preserved; historical entries which no longer pass
 * current author admission require review/repair before the emitted YAML can round-trip. Assumes a well-formed, user-initiated
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
