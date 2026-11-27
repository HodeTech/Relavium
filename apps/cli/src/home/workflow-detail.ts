import type { WorkflowDefinition } from '@relavium/core';

/**
 * What the `/workflows` popup's detail step shows of one workflow ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §10 as amended 2026-11-27; [MVP-11 unit 8](../../../../docs/roadmap/phases/mvp-11/unit-8-plan.md) §4): its description, the inputs it declares and the
 * chain of its nodes. PURE: a parsed definition in, plain strings out; it reads no file, no clock and no database. The catalog port builds it from the
 * very parse a `/run` of the same file makes ({@link LaunchCatalog.describe}), so what the detail says is what the run would ask and do.
 *
 * **Every string here is the workflow author's** (a description, an input's name, a node id) and is NOT scrubbed here: the popup passes each through
 * the Home's row scrub (`popups/home-text.ts`) as it draws or copies it, the one place a stored word is made safe. What this module does bound is
 * how MUCH it hands over: the number of inputs and nodes, so a document of five hundred nodes costs the popup a handful of rows.
 */

/** The most inputs and nodes the detail lists; the rest are counted, never drawn. */
export const WORKFLOW_DETAIL_ITEMS_MAX = 24;

/** One declared input: its name, its type word, and whether the run asks for it (required, with no default). */
export interface WorkflowDetailInput {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
}

/**
 * One node of the chain: its id and, for a human gate, what the gate is and how long it waits (`approval, 10 min`), the one node kind whose
 * kind changes what a person must do (a run parks there).
 */
export interface WorkflowDetailNode {
  readonly id: string;
  readonly note?: string | undefined;
}

export interface WorkflowDetail {
  /** The authored `description`, as written (a long text, possibly several lines); absent when there is none. */
  readonly description: string | undefined;
  readonly inputs: readonly WorkflowDetailInput[];
  /** How many declared inputs {@link inputs} leaves out. */
  readonly inputsMore: number;
  /** The nodes in the order a run reaches them (edges first, then the order declared), at most {@link WORKFLOW_DETAIL_ITEMS_MAX}. */
  readonly nodes: readonly WorkflowDetailNode[];
  /** How many nodes {@link nodes} leaves out. */
  readonly nodesMore: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** A gate's wait as words: `10 min`, `2 h`, or whole seconds below a minute and between the two. */
function waitWords(ms: number): string {
  if (ms >= HOUR_MS && ms % HOUR_MS === 0) return `${String(ms / HOUR_MS)} h`;
  if (ms >= MINUTE_MS && ms % MINUTE_MS === 0) return `${String(ms / MINUTE_MS)} min`;
  return `${String(Math.max(1, Math.round(ms / 1000)))} s`;
}

/** How many edges lead to each node, and which nodes each node leads to (an edge that names a node the document does not declare is ignored). */
function edgeIndex(
  ids: readonly string[],
  edges: readonly { readonly from: string; readonly to: string }[],
): { readonly waiting: Map<string, number>; readonly following: Map<string, string[]> } {
  const known = new Set(ids);
  const waiting = new Map<string, number>(ids.map((id) => [id, 0]));
  const following = new Map<string, string[]>();
  for (const edge of edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) continue;
    waiting.set(edge.to, (waiting.get(edge.to) ?? 0) + 1);
    following.set(edge.from, [...(following.get(edge.from) ?? []), edge.to]);
  }
  return { waiting, following };
}

/**
 * The nodes in the order the edges lead to them: each node comes after the nodes that point at it (Kahn's algorithm, ties broken by the order
 * the document declares them in), and a node left over by a cycle (the parser refuses one, but this reads a parsed document, not a promise) follows
 * in declared order, so every node is listed exactly once.
 */
function chainOrder(
  nodes: readonly { readonly id: string }[],
  edges: readonly { readonly from: string; readonly to: string }[],
): readonly string[] {
  const ids = nodes.map((node) => node.id);
  const { waiting, following } = edgeIndex(ids, edges);
  const order: string[] = [];
  let ready = ids.filter((id) => waiting.get(id) === 0);
  for (let next = ready.shift(); next !== undefined; next = ready.shift()) {
    order.push(next);
    for (const after of following.get(next) ?? []) {
      const left = (waiting.get(after) ?? 0) - 1;
      waiting.set(after, left);
      if (left === 0) ready = [...ready, after].sort((a, b) => ids.indexOf(a) - ids.indexOf(b));
    }
  }
  const placed = new Set(order);
  return [...order, ...ids.filter((id) => !placed.has(id))];
}

/** The note of a node: a human gate's kind and wait. */
function noteOf(node: WorkflowDefinition['workflow']['nodes'][number]): string | undefined {
  if (node.type !== 'human_gate') return undefined;
  return node.timeout_ms === undefined
    ? node.gate_type
    : `${node.gate_type}, ${waitWords(node.timeout_ms)}`;
}

/** The detail of a parsed workflow. */
export function buildWorkflowDetail(definition: WorkflowDefinition): WorkflowDetail {
  const { workflow } = definition;
  const declared = workflow.inputs ?? [];
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  const order = chainOrder(workflow.nodes, workflow.edges);
  return {
    description: workflow.description,
    inputs: declared.slice(0, WORKFLOW_DETAIL_ITEMS_MAX).map((input) => ({
      name: input.name,
      type: input.type,
      required: input.required === true && input.default === undefined,
    })),
    inputsMore: Math.max(0, declared.length - WORKFLOW_DETAIL_ITEMS_MAX),
    nodes: order.slice(0, WORKFLOW_DETAIL_ITEMS_MAX).map((id) => {
      const node = byId.get(id);
      const note = node === undefined ? undefined : noteOf(node);
      return { id, ...(note === undefined ? {} : { note }) };
    }),
    nodesMore: Math.max(0, order.length - WORKFLOW_DETAIL_ITEMS_MAX),
  };
}
