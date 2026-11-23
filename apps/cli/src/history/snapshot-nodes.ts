/**
 * What the Home's run pages read from a run's frozen workflow snapshot ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2, MVP-8 step 4): the nodes in the order the workflow authored them, each with its type and, for an agent node, the agent and the model the
 * workflow named. The snapshot is `runs.workflow_definition_snapshot`, the document the engine froze when the run started, so it says what
 * the workflow WAS for this run even if the file has changed since; it is never what the node actually ran on (that is the settled model
 * calls of the log).
 *
 * **A tolerant read, not a validation.** The engine validated the document when it froze it, and the run's own record is what a page shows;
 * this reads only the few fields the pages draw, with type guards, and answers `undefined` for anything it cannot use: text that is too long
 * to be a workflow, text that is not JSON, a `nodes` list that is not a list of `{ id, type }` records, or more nodes than a page can list.
 * It never throws, and it never guesses: a page with no snapshot shows the order the run ran in and says nothing about a workflow it could
 * not read. The result holds the document's own strings, unsanitized: the pages cut and scrub them as they draw (`scrubbedBounded`).
 */

/** The longest snapshot text read: 1 MiB, the bound every stored document of the run pages is read under. */
export const MAX_SNAPSHOT_CHARS = 1_048_576;
/** The most nodes a snapshot may hold for a page to list them: a larger one is not a workflow this page can order. */
export const MAX_SNAPSHOT_NODES = 500;

/** One node of the frozen workflow, as authored. */
export interface SnapshotNode {
  readonly id: string;
  readonly type: string;
  /** The agent an agent node names (`agent_ref`). */
  readonly agent?: string;
  /** The model the workflow authored for the node: its own `model`, else the model of the inline agent it names. */
  readonly model?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The models of the workflow's inline agents, by agent id. An agent that is only a reference carries no model of its own here. */
function inlineAgentModels(agents: unknown): ReadonlyMap<string, string> {
  const models = new Map<string, string>();
  if (!Array.isArray(agents)) return models;
  const items: readonly unknown[] = agents;
  for (const agent of items) {
    if (!isRecord(agent)) continue;
    const { id, model } = agent;
    if (typeof id === 'string' && typeof model === 'string' && !models.has(id))
      models.set(id, model);
  }
  return models;
}

/**
 * The nodes of a frozen workflow snapshot, in authored order; `undefined` when the text cannot be used (see the module note). A node id the
 * document names twice is listed once, at its first place.
 */
export function readSnapshotNodes(json: string | undefined): readonly SnapshotNode[] | undefined {
  if (json === undefined || json.length > MAX_SNAPSHOT_CHARS) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const workflow = parsed['workflow'];
  if (!isRecord(workflow)) return undefined;
  const listed = workflow['nodes'];
  if (!Array.isArray(listed) || listed.length > MAX_SNAPSHOT_NODES) return undefined;
  const models = inlineAgentModels(workflow['agents']);
  const entries: readonly unknown[] = listed;
  const nodes: SnapshotNode[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry)) return undefined;
    const { id, type, agent_ref: agentRef, model } = entry;
    if (typeof id !== 'string' || id === '' || typeof type !== 'string') return undefined;
    if (seen.has(id)) continue;
    seen.add(id);
    const agent = typeof agentRef === 'string' ? agentRef : undefined;
    const authoredModel =
      typeof model === 'string' ? model : agent === undefined ? undefined : models.get(agent);
    nodes.push({
      id,
      type,
      ...(agent === undefined ? {} : { agent }),
      ...(authoredModel === undefined ? {} : { model: authoredModel }),
    });
  }
  return nodes;
}
