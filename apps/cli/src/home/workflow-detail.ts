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

/**
 * How many edges lead to each node, and which nodes each node leads to, both by the node's position in the document (an edge that names a node
 * the document does not declare is ignored). Linear in the nodes and the edges: the adjacency is appended in place.
 */
function edgeIndex(
  ids: readonly string[],
  edges: readonly { readonly from: string; readonly to: string }[],
): { readonly waiting: number[]; readonly following: number[][] } {
  const position = new Map(ids.map((id, at) => [id, at] as const));
  const waiting = ids.map(() => 0);
  const following = ids.map((): number[] => []);
  for (const edge of edges) {
    const from = position.get(edge.from);
    const to = position.get(edge.to);
    if (from === undefined || to === undefined) continue;
    waiting[to] = (waiting[to] ?? 0) + 1;
    following[from]?.push(to);
  }
  return { waiting, following };
}

/** `value` into a binary min-heap of node positions: of the nodes that are ready, the next one a run reaches is the one the document declares first. */
function pushPosition(heap: number[], value: number): void {
  let at = heap.push(value) - 1;
  while (at > 0) {
    const parent = (at - 1) >> 1;
    const above = heap[parent] ?? 0;
    if (above <= value) break;
    heap[at] = above;
    at = parent;
  }
  heap[at] = value;
}

/** The smallest position of the heap, taken out of it; `undefined` when it is empty. */
function popPosition(heap: number[]): number | undefined {
  const top = heap[0];
  const last = heap.pop();
  if (top === undefined || last === undefined || heap.length === 0) return top;
  let at = 0;
  for (;;) {
    const left = 2 * at + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    const child = right < heap.length && (heap[right] ?? 0) < (heap[left] ?? 0) ? right : left;
    if ((heap[child] ?? 0) >= last) break;
    heap[at] = heap[child] ?? last;
    at = child;
  }
  heap[at] = last;
  return top;
}

/**
 * The first `limit` nodes in the order the edges lead to them: each node comes after the nodes that point at it (Kahn's algorithm, ties broken by
 * the order the document declares them in), and a node left over by a cycle (the parser refuses one, but this reads a parsed document, not a
 * promise) follows in declared order. The document is the workflow author's and may be enormous, so the work is `O((nodes + edges) log nodes)` and
 * the walk stops as soon as `limit` nodes are placed.
 */
function chainOrder(
  ids: readonly string[],
  edges: readonly { readonly from: string; readonly to: string }[],
  limit: number,
): readonly string[] {
  const { waiting, following } = edgeIndex(ids, edges);
  const ready: number[] = [];
  waiting.forEach((count, at) => {
    if (count === 0) pushPosition(ready, at);
  });
  const order: number[] = [];
  for (let next = popPosition(ready); next !== undefined; next = popPosition(ready)) {
    order.push(next);
    if (order.length >= limit) break;
    for (const after of following[next] ?? []) {
      const left = (waiting[after] ?? 0) - 1;
      waiting[after] = left;
      if (left === 0) pushPosition(ready, after);
    }
  }
  const placed = new Set(order);
  for (let at = 0; at < ids.length && order.length < limit; at += 1)
    if (!placed.has(at)) order.push(at);
  return order.map((at) => ids[at] ?? '');
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
  const ids = [...byId.keys()];
  const order = chainOrder(ids, workflow.edges, WORKFLOW_DETAIL_ITEMS_MAX);
  return {
    description: workflow.description,
    inputs: declared.slice(0, WORKFLOW_DETAIL_ITEMS_MAX).map((input) => ({
      name: input.name,
      type: input.type,
      required: input.required === true && input.default === undefined,
    })),
    inputsMore: Math.max(0, declared.length - WORKFLOW_DETAIL_ITEMS_MAX),
    nodes: order.map((id) => {
      const node = byId.get(id);
      const note = node === undefined ? undefined : noteOf(node);
      return { id, ...(note === undefined ? {} : { note }) };
    }),
    nodesMore: Math.max(0, ids.length - order.length),
  };
}
