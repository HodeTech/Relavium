/**
 * The DAG builder (1.M) — turns a validated `WorkflowDefinition` (the output of `parseWorkflow`,
 * 1.L/1.L2) into an executable {@link RunPlan}: a deterministic topological order over engine vertices,
 * each wired to its dependencies/dependents and carrying its un-evaluated input templates and per-type
 * config. The run loop (1.N) and `AgentRunner` (1.O) consume the plan; the builder evaluates nothing.
 *
 * Pure and **synchronous** — like the parser it reads structure only, touches no filesystem, no
 * environment, and holds no state, so it runs identically in Node, the Tauri WebView, the VS Code
 * host, and Bun (CLAUDE.md rule 5). A `$ref`/registry agent must be resolved by the host (file I/O is
 * a host concern, workflow.ts) and passed in via {@link BuildRunPlanOptions.agents}; the builder only
 * reads the resolved data.
 *
 * What the builder owns (deferred from 1.L/1.L2): node-existence for every edge / branch / `parallel_of`
 * endpoint; `nodeId:handle` validity for `condition` sources; `agent_ref` resolution (when a registry is
 * supplied); the cycle check; and re-taint of resolved `$ref` agent prompts (ADR-0029(c)). A graph fault
 * throws {@link WorkflowGraphError} (field-named, secret-free); a secret hiding behind a resolved ref
 * throws {@link WorkflowSecretLeakError} — both reject before a run, like the parser's errors.
 *
 * Engine mapping (node-types.md): `parallel` → `fan_out`, `merge` → `fan_in`, `human_gate` →
 * `human_in_the_loop`; the rest keep their authored type. The authored `parallel`/`merge` pair realizes
 * the conceptual fan_out/fan_in split-join across two vertices bracketed by edges (workflow-yaml-spec.md
 * §Complete example) — no extra vertex is synthesized.
 */

import type { Agent, EngineNodeType, Workflow, WorkflowNode } from '@relavium/shared';

import {
  WorkflowGraphError,
  WorkflowSecretLeakError,
  type GraphIssue,
  type SecretLeak,
} from './errors.js';
import { analyzeResolvedAgentTaint } from './interpolation/analyze.js';
import { nodeReferenceSites } from './interpolation/collect.js';
import { templateReferences } from './interpolation/references.js';
import type { JoinStrategy, PlanConfig, PlanVertex, RunPlan } from './run-plan.js';

/** Authored node variants, narrowed from the shared union for the per-type wiring helpers. */
type ParallelNode = Extract<WorkflowNode, { type: 'parallel' }>;
type ConditionNode = Extract<WorkflowNode, { type: 'condition' }>;
type AgentNode = Extract<WorkflowNode, { type: 'agent' }>;
type WorkflowSpec = Workflow['workflow'];
type AddEdge = (producer: string, consumer: string) => void;

/** Options for {@link buildRunPlan}. */
export interface BuildRunPlanOptions {
  /** A workspace-relative source label, used ONLY in error messages (never read) — mirrors the parser. */
  readonly source?: string;
  /**
   * Resolved agents by id — the host reads each `$ref`/workspace `.agent.yaml`, validates it with
   * `AgentSchema`, and supplies the result here (the pure builder never touches the filesystem). Inline
   * `agents:` entries are auto-included. When supplied, an `agent_ref` that resolves to nothing is a
   * `dangling_ref`, and every resolved-but-not-inline agent's `system_prompt` is re-run through the
   * secret-taint gate. When omitted, `agent_ref` resolution is deferred (no dangling check).
   */
  readonly agents?: ReadonlyMap<string, Agent>;
}

/** Mirrors parser.ts: only a value matching its field's schema charset is echoed into an error. */
const SAFE_ID_LABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/; // kebab ids (mirrors kebabIdSchema)
const SAFE_NAME_LABEL = /^[A-Za-z0-9_-]+$/; // condition handles / interpolation names

/**
 * Build the {@link RunPlan} from a validated workflow. Throws {@link WorkflowGraphError} on a graph
 * fault (cycle, missing endpoint, invalid handle, dangling ref) or {@link WorkflowSecretLeakError} when
 * a resolved `$ref` agent's prompt leaks a secret — so a run never starts on an unrunnable plan.
 */
export function buildRunPlan(def: Workflow, opts?: BuildRunPlanOptions): RunPlan {
  const spec = def.workflow;
  const source = opts?.source;
  const sourceOpt = source === undefined ? undefined : { source };

  // 1. Index authored nodes (ids are schema-guaranteed unique) and their authored position.
  const nodesById = new Map<string, WorkflowNode>();
  const authoredIndex = new Map<string, number>();
  spec.nodes.forEach((node, i) => {
    nodesById.set(node.id, node);
    authoredIndex.set(node.id, i);
  });

  // 2. Resolve agents (inline + host registry), then re-taint the prompts a node actually references.
  const { agentsById, inlineAgentIds } = resolveAgents(spec, opts?.agents);
  const leaks = referencedAgentLeaks(def, spec, opts?.agents, inlineAgentIds);
  if (leaks.length > 0) {
    throw new WorkflowSecretLeakError(leaks, sourceOpt);
  }

  // 3. Build the dependency graph (dependents = out-edges, dependencies = in-edges) over node ids, plus
  //    collect field-named issues. Edges with a missing endpoint are skipped from the graph (the missing
  //    endpoint is reported separately), so the cycle check runs over the well-formed subgraph.
  const dependents = new Map<string, Set<string>>();
  const dependencies = new Map<string, Set<string>>();
  for (const id of nodesById.keys()) {
    dependents.set(id, new Set());
    dependencies.set(id, new Set());
  }
  const addEdge = (producer: string, consumer: string): void => {
    const outs = dependents.get(producer);
    const ins = dependencies.get(consumer);
    if (outs === undefined || ins === undefined) {
      return; // an endpoint is not a node — reported as its own issue, never silently graphed
    }
    outs.add(consumer);
    ins.add(producer);
  };

  const issues: GraphIssue[] = [];
  validateAndWireEdges(spec, nodesById, agentsById, opts?.agents !== undefined, addEdge, issues);

  // 4. Kahn topological order (authored-order tie-break → reproducible plan; deep-equal-testable).
  const order = kahnOrder(spec.nodes, dependents, dependencies, authoredIndex);
  if (order.length < spec.nodes.length) {
    const cycle = extractCycle(spec.nodes, order, dependencies, authoredIndex);
    issues.push({
      kind: 'cycle',
      field: cycle.length > 0 ? cycle.join(' → ') : 'workflow.nodes',
      message:
        cycle.length > 0
          ? `the workflow has a dependency cycle: ${cycle.join(' → ')}`
          : 'the workflow has a dependency cycle',
    });
  }

  if (issues.length > 0) {
    throw new WorkflowGraphError(issues, sourceOpt);
  }

  // 5. Assemble the plan — one vertex per node, wired and configured deterministically.
  const vertices = new Map<string, PlanVertex>();
  const byAuthored = (a: string, b: string): number =>
    (authoredIndex.get(a) ?? 0) - (authoredIndex.get(b) ?? 0);
  const mergeBranchOrder = computeMergeBranchOrder(spec, dependencies, authoredIndex);
  for (const node of spec.nodes) {
    vertices.set(node.id, {
      id: node.id,
      type: engineType(node),
      dependencies: [...(dependencies.get(node.id) ?? [])].sort(byAuthored),
      dependents: [...(dependents.get(node.id) ?? [])].sort(byAuthored),
      inputSites: nodeReferenceSites(node),
      config: buildConfig(node, agentsById, mergeBranchOrder),
    });
  }

  return {
    workflowId: spec.id,
    order,
    vertices,
    ...(spec.max_parallel === undefined ? {} : { maxParallel: spec.max_parallel }),
    ...(spec.budget === undefined ? {} : { budget: spec.budget }),
    ...(spec.timeout_ms === undefined ? {} : { timeoutMs: spec.timeout_ms }),
  };
}

/**
 * Validate every endpoint, wire the dependency edges, and collect issues. Edge sources, in order:
 * structural `edges[]`, the materialized fan-out edge per `parallel_of` member, and the data edges a
 * `{{run.outputs["<id>"]}}` reference creates from a producer node into the field that reads it (so a
 * consumer is ordered after its referenced producer even with no explicit edge).
 */
function validateAndWireEdges(
  spec: Workflow['workflow'],
  nodesById: ReadonlyMap<string, WorkflowNode>,
  agentsById: ReadonlyMap<string, Agent>,
  registrySupplied: boolean,
  addEdge: (producer: string, consumer: string) => void,
  issues: GraphIssue[],
): void {
  // 3a. Structural edges + handle validation.
  spec.edges.forEach((edge, i) => validateStructuralEdge(edge, i, nodesById, addEdge, issues));

  // 3b. Per-node endpoints (membership/targets/agent_ref) + materialized routing + own data edges.
  for (const node of spec.nodes) {
    if (node.type === 'parallel') {
      wireParallelNode(node, nodesById, addEdge, issues);
    } else if (node.type === 'condition') {
      wireConditionNode(node, nodesById, addEdge, issues);
    } else if (node.type === 'agent') {
      validateAgentNode(node, agentsById, registrySupplied, nodesById, addEdge, issues);
    }
    wireOwnDataEdges(node, addEdge);
  }
}

/** Resolve agents from the inline `agents:` entries plus the host-supplied registry (inline wins). */
function resolveAgents(
  spec: WorkflowSpec,
  registry: ReadonlyMap<string, Agent> | undefined,
): { agentsById: Map<string, Agent>; inlineAgentIds: Set<string> } {
  const agentsById = new Map<string, Agent>();
  const inlineAgentIds = new Set<string>();
  for (const agent of spec.agents ?? []) {
    if ('id' in agent) {
      inlineAgentIds.add(agent.id);
      agentsById.set(agent.id, agent);
    }
  }
  if (registry !== undefined) {
    for (const [id, agent] of registry) {
      if (!agentsById.has(id)) {
        agentsById.set(id, agent);
      }
    }
  }
  return { agentsById, inlineAgentIds };
}

/**
 * Re-taint the resolved `$ref`/registry agent prompts a node actually *references* via `agent_ref`
 * (inline agents are already parser-checked; an unreferenced registry agent never reaches a model, so
 * re-tainting it would wrongly reject a runnable workflow — scope it to referenced agents, parity with
 * the `dangling_ref` check). Iterate in authored node order, deduping by ref, so the reported leak order
 * is deterministic and consistent with the parser's authored-order gate — independent of the host
 * registry's Map insertion order. The echoed `ref` is `kebabIdSchema`-valid.
 */
function referencedAgentLeaks(
  def: Workflow,
  spec: WorkflowSpec,
  registry: ReadonlyMap<string, Agent> | undefined,
  inlineAgentIds: ReadonlySet<string>,
): readonly SecretLeak[] {
  if (registry === undefined) {
    return [];
  }
  const texts: { location: string; text: string }[] = [];
  const seenRefs = new Set<string>();
  for (const node of spec.nodes) {
    if (
      node.type !== 'agent' ||
      seenRefs.has(node.agent_ref) ||
      inlineAgentIds.has(node.agent_ref)
    ) {
      continue;
    }
    seenRefs.add(node.agent_ref);
    const agent = registry.get(node.agent_ref);
    if (agent === undefined) {
      continue; // a dangling ref — reported by the graph pass, not here
    }
    const label = SAFE_ID_LABEL.test(node.agent_ref) ? `\`${node.agent_ref}\`` : '<agent>';
    texts.push({ location: `agent ${label}.system_prompt`, text: agent.system_prompt });
  }
  return analyzeResolvedAgentTaint(def, texts);
}

/**
 * Validate one structural edge and wire its dependency. A `nodeId:handle` edge only routes a `condition`
 * branch; its dependency is materialized from `branches[].target_node` ({@link wireConditionNode}), so a
 * handled edge adds NO second (possibly contradictory) structural edge here — it is only validated
 * (handle exists, and its `to` agrees with the branch's target). A plain edge wires `from → to`.
 */
function validateStructuralEdge(
  edge: WorkflowSpec['edges'][number],
  index: number,
  nodesById: ReadonlyMap<string, WorkflowNode>,
  addEdge: AddEdge,
  issues: GraphIssue[],
): void {
  const colon = edge.from.indexOf(':');
  const fromBase = colon === -1 ? edge.from : edge.from.slice(0, colon);
  const handle = colon === -1 ? undefined : edge.from.slice(colon + 1);
  const fromNode = nodesById.get(fromBase);
  const locator = `edge \`${fromBase}\`→\`${edge.to}\``;

  if (fromNode === undefined) {
    issues.push({
      kind: 'unknown_edge_target',
      field: locator,
      message: `edge source \`${fromBase}\` is not a node`,
    });
  }
  if (!nodesById.has(edge.to)) {
    issues.push({
      kind: 'unknown_edge_target',
      field: locator,
      message: `edge target \`${edge.to}\` is not a node`,
    });
  }
  if (handle !== undefined) {
    if (fromNode !== undefined) {
      validateHandle(fromNode, handle, edge.to, locator, index, issues);
    }
    return; // a handled edge's dependency comes from branch materialization, never a second edge here
  }
  // Validate condition routing only when BOTH endpoints are real nodes — a missing `from`/`to` is
  // already reported as `unknown_edge_target` above, so checking here too would double-report one edge.
  if (fromNode?.type === 'condition' && nodesById.has(edge.to)) {
    // A `condition` routes ONLY via `branches[].target_node` (materialized) + the `nodeId:when` handle
    // edge. A plain (handle-less) edge from it is always rejected — either redundant with a dependency
    // already materialized from a branch target, or it wires a dependent the handler's `selected` never
    // names (a node the run loop always skips). (The condition node id is safe to echo.)
    issues.push({
      kind: 'invalid_handle',
      field: locator,
      message: `a plain edge from condition \`${fromBase}\` is not allowed — route via \`branches[].target_node\` or the \`${fromBase}:<when>\` handle form`,
    });
    return;
  }
  addEdge(fromBase, edge.to);
}

/** Wire a `parallel` node's fan-out: each `parallel_of` member depends on the split. */
function wireParallelNode(
  node: ParallelNode,
  nodesById: ReadonlyMap<string, WorkflowNode>,
  addEdge: AddEdge,
  issues: GraphIssue[],
): void {
  node.parallel_of.forEach((member, j) => {
    if (!nodesById.has(member)) {
      issues.push({
        kind: 'unknown_edge_target',
        field: `node \`${node.id}\`.parallel_of[${j}]`,
        message: `\`${member}\` is not a node`,
      });
    }
    addEdge(node.id, member);
  });
}

/**
 * Wire a `condition` node's routing from `branches[].target_node` / `default` — symmetric with
 * `parallel_of`'s self-materialization. Without it, a cycle routed through a branch (with no explicit
 * `nodeId:handle` edge) would escape the cycle check, and the run loop's completion-gating /
 * skip-propagation (§1.N) would see empty dependents. `addEdge` is a no-op when a target is missing
 * (already flagged), so it is safe to call unconditionally after the existence check.
 */
function wireConditionNode(
  node: ConditionNode,
  nodesById: ReadonlyMap<string, WorkflowNode>,
  addEdge: AddEdge,
  issues: GraphIssue[],
): void {
  node.branches.forEach((branch, j) => {
    if (!nodesById.has(branch.target_node)) {
      issues.push({
        kind: 'unknown_edge_target',
        field: `node \`${node.id}\`.branches[${j}].target_node`,
        message: `branch target \`${branch.target_node}\` is not a node`,
      });
    }
    addEdge(node.id, branch.target_node);
  });
  if (node.default !== undefined) {
    if (!nodesById.has(node.default)) {
      issues.push({
        kind: 'unknown_edge_target',
        field: `node \`${node.id}\`.default`,
        message: `default target \`${node.default}\` is not a node`,
      });
    }
    addEdge(node.id, node.default);
  }
}

/** Validate an `agent` node's `agent_ref` and wire data edges from the resolved agent's system prompt. */
function validateAgentNode(
  node: AgentNode,
  agentsById: ReadonlyMap<string, Agent>,
  registrySupplied: boolean,
  nodesById: ReadonlyMap<string, WorkflowNode>,
  addEdge: AddEdge,
  issues: GraphIssue[],
): void {
  if (registrySupplied && !agentsById.has(node.agent_ref)) {
    issues.push({
      kind: 'dangling_ref',
      field: `node \`${node.id}\`.agent_ref`,
      message: `agent_ref \`${node.agent_ref}\` resolves to no agent`,
    });
  }
  // The resolved agent's own system_prompt may reference node outputs — those order this node too.
  const agent = agentsById.get(node.agent_ref);
  if (agent !== undefined) {
    wireDataEdges(agent.system_prompt, node.id, nodesById, addEdge);
  }
}

/**
 * Wire data edges from a node's own template fields (`{{run.outputs["<id>"]}}` → this node depends on
 * it). A reference to a *non-existent* producer adds no edge and — by design — no diagnostic: a TEMPLATE
 * dangling ref is surfaced by the runtime resolver as `unresolved_reference` at dispatch. The builder
 * *likewise* does not validate `run.outputs` reads in the JS-expression fields (`condition`/`transform`/
 * `merge_fn` — sandbox-owned, 1.AB), but the symmetry is builder-non-validation only: those are NOT
 * templates and never produce `unresolved_reference` — a dangling JS-expression read evaluates to
 * `undefined` in-VM (surfacing later as a `non_serializable`/`result_type` violation, or a fatal
 * `runtime` SandboxError if dereferenced). The builder validates the authored *graph* (edges, branches,
 * `parallel_of`, `agent_ref`), not data-reference targets. Pinned by a test.
 */
function wireOwnDataEdges(node: WorkflowNode, addEdge: AddEdge): void {
  for (const site of nodeReferenceSites(node)) {
    for (const ref of site.references) {
      if (ref.kind === 'node') {
        addEdge(ref.identifier, node.id);
      }
    }
  }
}

/**
 * Add a `producer → consumer` edge for each `{{run.outputs["<producer>"]}}` reference in `text`. A
 * reference to a non-existent producer is skipped silently — like a node's own template refs, a dangling
 * node-output reference is surfaced by the runtime resolver (`unresolved_reference`), not the builder.
 */
function wireDataEdges(
  text: string,
  consumer: string,
  nodesById: ReadonlyMap<string, WorkflowNode>,
  addEdge: (producer: string, consumer: string) => void,
): void {
  for (const ref of templateReferences(text)) {
    if (ref.kind === 'node' && nodesById.has(ref.identifier)) {
      addEdge(ref.identifier, consumer);
    }
  }
}

/**
 * A `nodeId:handle` edge is valid only from a `condition` node whose `when` values include the handle
 * (workflow-yaml-spec.md §Edges). Any other source — an agent, a `parallel` fan-out (plain edges in
 * v1.0), a default-output node — exposes no named handle, so a handle on it is rejected. The edge's `to`
 * must also agree with that branch's authored `target_node` (the routing is authoritative; a contradiction
 * is rejected, symmetric with the `parallel_of` ↔ fan-out-edge agreement check).
 */
function validateHandle(
  fromNode: WorkflowNode,
  handle: string,
  edgeTo: string,
  locator: string,
  index: number,
  issues: GraphIssue[],
): void {
  // The `:handle` suffix is unconstrained authored text (`(?::.+)?`, edge.ts). On the two INVALID-handle
  // paths the handle matched no branch — naming it adds nothing and could echo an arbitrary token, so
  // they stay positional (`edge #n`), never echoing the suffix. (The base64url/identifier charset alone
  // does NOT exclude a secret-shaped token — `sk-live-…`/`ghp_…` pass it — so SAFE_NAME_LABEL is not a
  // sufficient guard here; CLAUDE.md rule 6, defense-in-depth.)
  const positional = `the handle on edge #${index}`;
  if (fromNode.type !== 'condition') {
    issues.push({
      kind: 'invalid_handle',
      field: locator,
      message: `node \`${fromNode.id}\` (type \`${fromNode.type}\`) exposes no named output handle for ${positional}`,
    });
    return;
  }
  // A handle matches a branch when its text equals the `when` value stringified. For a *numeric* `when`,
  // also accept a non-canonical numeric form (`gate:1.0` / `gate:0x10` for `when: 1` / `when: 16`), since
  // the spec names no canonical handle form and YAML already coerced the authored `when` to a number.
  const branch = fromNode.branches.find(
    (b) =>
      String(b.when) === handle ||
      (typeof b.when === 'number' && handle.trim() !== '' && Number(handle) === b.when),
  );
  if (branch === undefined) {
    issues.push({
      kind: 'invalid_handle',
      field: locator,
      message: `condition \`${fromNode.id}\` has no branch handle matching ${positional}`,
    });
    return;
  }
  if (branch.target_node !== edgeTo) {
    // Here the handle DID match an authored branch `when` (a routing label, not a credential field). Echo
    // it only when it is a short, simple label — else stay positional, so a pathological long/odd handle
    // never rides the message.
    const handleLabel =
      SAFE_NAME_LABEL.test(handle) && handle.length <= 24 ? `\`${handle}\`` : positional;
    issues.push({
      kind: 'mismatched_branch_target',
      field: locator,
      message: `condition \`${fromNode.id}\` handle ${handleLabel} routes to \`${branch.target_node}\`, but the edge targets \`${edgeTo}\``,
    });
  }
}

/**
 * Kahn's algorithm over the dependency graph. Each step emits the authored-**minimum** ready vertex, so
 * the authored-order tie-break holds across the ENTIRE ready set (not merely discovery order) — a fully
 * deterministic, reproducible plan. (`ready` is re-sorted each step; the authored graph is small.)
 */
function kahnOrder(
  nodes: Workflow['workflow']['nodes'],
  dependents: ReadonlyMap<string, ReadonlySet<string>>,
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
  authoredIndex: ReadonlyMap<string, number>,
): string[] {
  const byAuthored = (a: string, b: string): number =>
    (authoredIndex.get(a) ?? 0) - (authoredIndex.get(b) ?? 0);
  const remaining = new Map<string, number>();
  for (const [id, ins] of dependencies) {
    remaining.set(id, ins.size);
  }
  const ready: string[] = [];
  for (const node of nodes) {
    if ((remaining.get(node.id) ?? 0) === 0) {
      ready.push(node.id);
    }
  }
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort(byAuthored);
    const id = ready.shift();
    if (id === undefined) {
      break;
    }
    order.push(id);
    for (const consumer of dependents.get(id) ?? []) {
      const next = (remaining.get(consumer) ?? 0) - 1;
      remaining.set(consumer, next);
      if (next === 0) {
        ready.push(consumer);
      }
    }
  }
  return order;
}

/**
 * Name one cycle for the error message. Every node Kahn left unprocessed still has an unprocessed
 * predecessor (else its in-degree would have reached zero), so walking predecessors from any stuck node
 * is guaranteed to revisit one — that revisit closes the cycle. Returned in execution-forward order
 * (`a → b → c → a`). Bounded by node count; no recursion (stack-safe on a large authored graph).
 */
function extractCycle(
  nodes: Workflow['workflow']['nodes'],
  order: readonly string[],
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
  authoredIndex: ReadonlyMap<string, number>,
): string[] {
  const processed = new Set(order);
  const stuck = (id: string): boolean => !processed.has(id);
  const byAuthored = (a: string, b: string): number =>
    (authoredIndex.get(a) ?? 0) - (authoredIndex.get(b) ?? 0);

  let start: string | undefined;
  for (const node of nodes) {
    if (stuck(node.id)) {
      start = node.id;
      break;
    }
  }
  if (start === undefined) {
    return [];
  }

  const seenAt = new Map<string, number>();
  const path: string[] = [];
  let cur: string | undefined = start;
  while (cur !== undefined && !seenAt.has(cur)) {
    seenAt.set(cur, path.length);
    path.push(cur);
    const preds = [...(dependencies.get(cur) ?? [])].filter(stuck).sort(byAuthored);
    cur = preds[0];
  }
  if (cur === undefined) {
    return path; // unreachable (a stuck node always has a stuck predecessor), but stays total
  }
  const from = seenAt.get(cur) ?? 0;
  const loop = path.slice(from).reverse(); // predecessor chain → execution-forward order
  const head = loop[0];
  if (head !== undefined) {
    loop.push(head); // close the ring: … → head
  }
  return loop;
}

/** Map an authored node type to its engine vertex type (node-types.md §engine enum). */
function engineType(node: WorkflowNode): EngineNodeType {
  switch (node.type) {
    case 'parallel':
      return 'fan_out';
    case 'merge':
      return 'fan_in';
    case 'human_gate':
      return 'human_in_the_loop';
    case 'input':
    case 'agent':
    case 'condition':
    case 'transform':
    case 'output':
      return node.type;
  }
}

/**
 * The stable branch order a `fan_in` (merge) vertex exposes to a `custom` `merge_fn` and `concat`.
 * Order = the paired `parallel`'s `parallel_of` declaration order when this merge joins exactly the
 * branches of one parallel (the common authored shape), else the merge's incoming branches in authored
 * order. A merge's `dependencies` are authored-index-sorted, which is NOT `parallel_of` order, so the
 * run loop / sandbox cannot reconstruct it from the vertex — the builder pins it here.
 */
function computeMergeBranchOrder(
  spec: WorkflowSpec,
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
  authoredIndex: ReadonlyMap<string, number>,
): Map<string, readonly string[]> {
  const byAuthored = (a: string, b: string): number =>
    (authoredIndex.get(a) ?? 0) - (authoredIndex.get(b) ?? 0);
  const parallels = spec.nodes.filter((n): n is ParallelNode => n.type === 'parallel');
  const order = new Map<string, readonly string[]>();
  for (const node of spec.nodes) {
    if (node.type !== 'merge') {
      continue;
    }
    const preds = dependencies.get(node.id) ?? new Set<string>();
    // The paired parallel: the authored-first parallel ALL of whose `parallel_of` members feed this
    // merge directly. Then branches follow `parallel_of` order, with any extra (non-parallel) incoming
    // branches appended in authored order; with no unique pairing, fall back to authored order.
    const paired = parallels.find(
      (p) => p.parallel_of.length > 0 && p.parallel_of.every((m) => preds.has(m)),
    );
    if (paired === undefined) {
      order.set(node.id, [...preds].sort(byAuthored));
    } else {
      const members = new Set(paired.parallel_of);
      const extras = [...preds].filter((m) => !members.has(m)).sort(byAuthored);
      order.set(node.id, [...paired.parallel_of, ...extras]);
    }
  }
  return order;
}

/** Build the per-type config block for a vertex, deriving engine-only fields (join strategy, fallback). */
function buildConfig(
  node: WorkflowNode,
  agentsById: ReadonlyMap<string, Agent>,
  mergeBranchOrder: ReadonlyMap<string, readonly string[]>,
): PlanConfig {
  switch (node.type) {
    case 'input':
      return { kind: 'input', node };
    case 'output':
      return { kind: 'output', node };
    case 'transform':
      return { kind: 'transform', node };
    case 'condition':
      return { kind: 'condition', node };
    case 'human_gate':
      return { kind: 'human_in_the_loop', node };
    case 'parallel':
      return { kind: 'fan_out', node, branchNodeIds: node.parallel_of };
    case 'merge': {
      const joinStrategy: JoinStrategy =
        node.merge_strategy === 'first' ? 'wait_first' : 'wait_all';
      return {
        kind: 'fan_in',
        node,
        joinStrategy,
        mergeStrategy: node.merge_strategy,
        branchNodeIds: mergeBranchOrder.get(node.id) ?? [],
        ...(node.merge_fn === undefined ? {} : { mergeFn: node.merge_fn }),
      };
    }
    case 'agent': {
      const resolvedAgent = agentsById.get(node.agent_ref);
      return {
        kind: 'agent',
        node,
        ...(resolvedAgent === undefined ? {} : { resolvedAgent }),
        ...(resolvedAgent?.fallback_chain === undefined
          ? {}
          : { fallbackChain: resolvedAgent.fallback_chain }),
      };
    }
  }
}
