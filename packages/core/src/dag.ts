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

import { WorkflowGraphError, WorkflowSecretLeakError, type GraphIssue } from './errors.js';
import { analyzeResolvedAgentTaint } from './interpolation/analyze.js';
import { nodeReferenceSites } from './interpolation/collect.js';
import { templateReferences } from './interpolation/references.js';
import type {
  JoinStrategy,
  PlanConfig,
  PlanVertex,
  RunPlan,
} from './run-plan.js';

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

  // 2. Resolve agents: inline `agents:` entries, then the host-supplied registry (never overriding inline).
  const agentsById = new Map<string, Agent>();
  const inlineAgentIds = new Set<string>();
  for (const agent of spec.agents ?? []) {
    if ('id' in agent) {
      inlineAgentIds.add(agent.id);
      agentsById.set(agent.id, agent);
    }
  }
  if (opts?.agents !== undefined) {
    for (const [id, agent] of opts.agents) {
      if (!agentsById.has(id)) {
        agentsById.set(id, agent);
      }
    }
  }

  // 3. Secret re-taint of resolved `$ref`/registry agent prompts that a node actually *references* via
  //    `agent_ref` (inline agents are already parser-checked; an unreferenced registry agent never reaches
  //    a model, so re-tainting it would wrongly reject a runnable workflow — scope it to referenced agents,
  //    parity with the `dangling_ref` check). Iterate in authored node order, deduping by ref, so the
  //    reported leak order is deterministic and consistent with the parser's authored-order gate —
  //    independent of the host registry's Map insertion order. The echoed `ref` is `kebabIdSchema`-valid.
  if (opts?.agents !== undefined) {
    const texts: { location: string; text: string }[] = [];
    const seenRefs = new Set<string>();
    for (const node of spec.nodes) {
      if (node.type !== 'agent' || seenRefs.has(node.agent_ref) || inlineAgentIds.has(node.agent_ref)) {
        continue;
      }
      seenRefs.add(node.agent_ref);
      const agent = opts.agents.get(node.agent_ref);
      if (agent === undefined) {
        continue; // a dangling ref — reported by the graph pass, not here
      }
      const label = SAFE_ID_LABEL.test(node.agent_ref) ? `\`${node.agent_ref}\`` : '<agent>';
      texts.push({ location: `agent ${label}.system_prompt`, text: agent.system_prompt });
    }
    const leaks = analyzeResolvedAgentTaint(def, texts);
    if (leaks.length > 0) {
      throw new WorkflowSecretLeakError(leaks, sourceOpt);
    }
  }

  // 4. Build the dependency graph (dependents = out-edges, dependencies = in-edges) over node ids, plus
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

  // 5. Kahn topological order (authored-order tie-break → reproducible plan; deep-equal-testable).
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

  // 6. Assemble the plan — one vertex per node, wired and configured deterministically.
  const vertices = new Map<string, PlanVertex>();
  const byAuthored = (a: string, b: string): number =>
    (authoredIndex.get(a) ?? 0) - (authoredIndex.get(b) ?? 0);
  for (const node of spec.nodes) {
    vertices.set(node.id, {
      id: node.id,
      type: engineType(node),
      dependencies: [...(dependencies.get(node.id) ?? [])].sort(byAuthored),
      dependents: [...(dependents.get(node.id) ?? [])].sort(byAuthored),
      inputSites: nodeReferenceSites(node),
      config: buildConfig(node, agentsById),
    });
  }

  return {
    workflowId: spec.id,
    order,
    vertices,
    ...(spec.max_parallel === undefined ? {} : { maxParallel: spec.max_parallel }),
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
  // 4a. Structural edges + handle validation.
  spec.edges.forEach((edge, i) => {
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
    if (handle !== undefined && fromNode !== undefined) {
      validateHandle(fromNode, handle, locator, i, issues);
    }
    addEdge(fromBase, edge.to);
  });

  // 4b. Per-node endpoints: parallel_of membership, condition targets, agent_ref resolution, and the
  //     materialized fan-out + data edges.
  for (const node of spec.nodes) {
    if (node.type === 'parallel') {
      node.parallel_of.forEach((member, j) => {
        if (!nodesById.has(member)) {
          issues.push({
            kind: 'unknown_edge_target',
            field: `node \`${node.id}\`.parallel_of[${j}]`,
            message: `\`${member}\` is not a node`,
          });
        }
        addEdge(node.id, member); // fan-out: each branch depends on the split
      });
    } else if (node.type === 'condition') {
      // Routing is authored on `branches[].target_node` / `default`, so it must carry a real dependency
      // edge — symmetric with `parallel_of`'s self-materialization. Without it, a cycle routed through a
      // branch (with no explicit `nodeId:handle` edge) would escape the cycle check, and the run loop's
      // completion-gating / skip-propagation (§1.N) would see empty dependents. `addEdge` is a no-op when
      // the target is missing (already flagged), so it is safe to call unconditionally after the check.
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
    } else if (node.type === 'agent') {
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

    // Data edges from this node's own template fields (`{{run.outputs["<id>"]}}` → this node depends on it).
    // A reference to a *non-existent* producer adds no edge and — by design — no diagnostic: it is left to
    // the runtime resolver, which raises `unresolved_reference` at dispatch. This is deliberate and
    // symmetric with JS-expression `run.outputs` reads in `condition`/`transform`/`merge_fn` (sandbox-
    // owned, 1.AB), which the builder also does not validate — the builder validates the authored *graph*
    // (edges, branches, `parallel_of`, `agent_ref`), not data-reference targets. Pinned by a test.
    for (const site of nodeReferenceSites(node)) {
      for (const ref of site.references) {
        if (ref.kind === 'node') {
          addEdge(ref.identifier, node.id);
        }
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
 * v1.0), a default-output node — exposes no named handle, so a handle on it is rejected.
 */
function validateHandle(
  fromNode: WorkflowNode,
  handle: string,
  locator: string,
  index: number,
  issues: GraphIssue[],
): void {
  const handleLabel = SAFE_NAME_LABEL.test(handle) ? `\`${handle}\`` : `the handle on edge #${index}`;
  if (fromNode.type !== 'condition') {
    issues.push({
      kind: 'invalid_handle',
      field: locator,
      message: `node \`${fromNode.id}\` (type \`${fromNode.type}\`) exposes no named output handle for ${handleLabel}`,
    });
    return;
  }
  // A handle matches a branch when its text equals the `when` value stringified. For a *numeric* `when`,
  // also accept a non-canonical numeric form (`gate:1.0` / `gate:0x10` for `when: 1` / `when: 16`), since
  // the spec names no canonical handle form and YAML already coerced the authored `when` to a number.
  const known = fromNode.branches.some(
    (branch) =>
      String(branch.when) === handle ||
      (typeof branch.when === 'number' && handle.trim() !== '' && Number(handle) === branch.when),
  );
  if (!known) {
    issues.push({
      kind: 'invalid_handle',
      field: locator,
      message: `condition \`${fromNode.id}\` has no branch handle matching ${handleLabel}`,
    });
  }
}

/** Kahn's algorithm over the dependency graph; ties broken by authored order for a reproducible plan. */
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
  // Seed roots in authored order (we iterate `nodes` in authored order, so `queue` starts ordered).
  const queue: string[] = [];
  for (const node of nodes) {
    if ((remaining.get(node.id) ?? 0) === 0) {
      queue.push(node.id);
    }
  }
  const order: string[] = [];
  let head = 0;
  while (head < queue.length) {
    const id = queue[head];
    head += 1;
    if (id === undefined) {
      break;
    }
    order.push(id);
    const outs = dependents.get(id);
    if (outs === undefined) {
      continue;
    }
    for (const consumer of [...outs].sort(byAuthored)) {
      const next = (remaining.get(consumer) ?? 0) - 1;
      remaining.set(consumer, next);
      if (next === 0) {
        queue.push(consumer);
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

/** Build the per-type config block for a vertex, deriving engine-only fields (join strategy, fallback). */
function buildConfig(node: WorkflowNode, agentsById: ReadonlyMap<string, Agent>): PlanConfig {
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
      const joinStrategy: JoinStrategy = node.merge_strategy === 'first' ? 'wait_first' : 'wait_all';
      return {
        kind: 'fan_in',
        node,
        joinStrategy,
        mergeStrategy: node.merge_strategy,
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
