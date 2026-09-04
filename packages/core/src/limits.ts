/**
 * Absolute admission ceilings on authored values
 * ([ADR-0086](../../../docs/decisions/0086-absolute-admission-ceilings-on-authored-values.md)).
 *
 * The engine used to admit anything that parsed. The only limit was a 2 MiB source-text cap
 * ({@link MAX_SOURCE_CHARS}), and 2 MiB of YAML holds tens of thousands of small nodes — so a file could
 * declare a graph, a retry budget or a fan-out the engine has no defined behaviour for. These are the
 * ceilings that end that, and the two validators that enforce them.
 *
 * **Three properties this module exists to hold, all of them decided in ADR-0086 rather than here:**
 *
 * 1. **A breach is a REJECTION, never a clamp** (§1). Silently narrowing an authored value contradicts
 *    [ADR-0023](../../../docs/decisions/0023-strict-authored-yaml-validation.md) — a committed workflow must
 *    never run as something other than what it says — and an author who wrote `max_parallel: 200` and got 8
 *    would debug the wrong thing. Every issue therefore names the field, the authored value AND the ceiling.
 * 2. **Both entry points check, through ONE validator** (§6). `relavium agent run` and `relavium chat` hand
 *    an `Agent` straight to `AgentSession` and never build a graph, so agent-scoped ceilings live
 *    in {@link collectAgentCeilingIssues} — called by the workflow compiler for every resolved agent AND by
 *    the session before its first turn. Two copies of eight numbers is how the two surfaces drift, and a
 *    drift here means the same agent file is admitted by `chat` and rejected by a workflow referencing it.
 * 3. **The graph ceilings count the AUTHORED file** (§2), before `parallel_of` expansion or any
 *    de-duplication. An author can act on "you wrote 600 nodes"; they cannot act on a number that exists
 *    only after a compile step they never see.
 *
 * The numbers are ceilings, not recommendations — nothing about a workflow improves by approaching one — and
 * they are `readonly` constants rather than Zod `.max()` refinements deliberately: a `.max()` would change
 * `WorkflowSchema`, which is a public API, and the fan-out and edge-count limits are properties of the whole
 * file rather than of any single field, so half of them have no schema expression at all (§7).
 */

import type { Agent, Workflow, WorkflowNode } from '@relavium/shared';

import type { GraphIssue } from './errors.js';
import { nodeReferenceSites } from './interpolation/collect.js';
import { templateReferences } from './interpolation/references.js';

/**
 * Every absolute ceiling, in one frozen object so a host can read the number it will be judged against
 * rather than discovering it from a rejection (ADR-0086 §9.3).
 *
 * Exported as data, not as eight loose constants, for the same reason `DEFAULT_TOOL_RESULT_LIMITS` is: a
 * caller that wants to display the limits should not have to know eight identifier names, and a future
 * host-side override has one shape to override.
 */
/**
 * The bounds an **authored** JSON Schema is compiled under
 * ([ADR-0092](../../../docs/decisions/0092-output-schema-is-validated-by-the-compiler-we-already-own.md)).
 *
 * Deliberately tighter than the MCP boundary's on shape and LOOSER on nothing. A hostile server's schema is
 * bounded to survive an attack; an authored one is bounded to catch a mistake, and an author who needs 500
 * properties in one node output has a design problem the compiler should surface rather than absorb. The
 * byte limits stay where the MCP boundary put them — a `const` string or a property name has no reason to
 * be larger in a workflow file than in a tool definition.
 */
export const AUTHORED_SCHEMA_BOUNDS = {
  maxDepth: 12,
  maxNodes: 1000,
  maxEnumMembers: 500,
  maxProperties: 200,
  maxStringBytes: 4 * 1024,
  maxPropertyNameBytes: 256,
} as const;

export const ADMISSION_CEILINGS = {
  /** Authored nodes in one workflow. */
  nodes: 500,
  /** Authored edges in one workflow. */
  edges: 2000,
  /** A single node's authored out-degree — the width that becomes concurrent work in one step. */
  fanOut: 50,
  /** Entries in one agent's `fallback_chain`; each entry carries its own attempt budget. */
  fallbackChainEntries: 5,
  /** `retry.max` — total attempts for one node, including the first. */
  retryMax: 10,
  /** `fallback_chain[].max_attempts` — attempts within one chain entry. `retryMax` multiplies this. */
  chainEntryMaxAttempts: 10,
  /** An authored `max_parallel`. Distinct from {@link DEFAULT_MAX_PARALLEL}, which applies when omitted. */
  maxParallel: 64,
  /** Tool calls in ONE model response. Not a concurrency limit — dispatch is sequential (ADR-0086 §2). */
  toolCallsPerResponse: 16,
  /** `node:started` events in one run — the runtime backstop for the multiplication the others permit. */
  nodeDispatchesPerRun: 500,
  /**
   * Media parts in ONE node output that the engine will re-host (`CR-54`). Like
   * {@link ADMISSION_CEILINGS.toolCallsPerResponse}, its subject is a RESPONSE rather than an authored
   * file, so it cannot live at admission — a provider, an authored `transform`, or an MCP tool result
   * chooses this width, not the author.
   *
   * It exists because the size bound cannot see it: `SIZE_BOUNDS.nodeOutputBytes` measures the POINTER, and
   * a url media part serialises to well under a hundred bytes, so a legal node output can carry thousands
   * of them — each becoming its own multi-megabyte download into the CAS that no admission reserved and no
   * `cost:updated` reported. Refused before the first fetch, because a bound discovered as egress is not a
   * bound.
   *
   * 32 is deliberately generous against real output (a generative node returns one part, a fan-in of media
   * nodes a handful) and still cheap in the worst case.
   */
  mediaPartsPerNodeOutput: 32,
  /**
   * Media attachments ONE model response may cause to be delivered (`CR-50`) — the sum across every tool
   * call in the response, not per call. Its subject is a response, like
   * {@link ADMISSION_CEILINGS.toolCallsPerResponse}, so it cannot live at admission.
   *
   * Without it the only backstop was `MEDIA_MESSAGE_CAPS.maxPartsPerMessage`, enforced POST-resolution at
   * the adapter — so a 17-attachment response was a `ZodError` that killed the turn after every tool had
   * run, rather than a refusal the model could correct. And the bytes are re-resolved from the store on
   * every attempt and every provider call of the turn, which is real spend the pre-egress governor cannot
   * see (it receives only model/provider/maxTokens).
   *
   * Deliberately below `maxPartsPerMessage` (16) so the engine refuses before the seam does, and the error
   * the model sees is ours.
   */
  mediaAttachmentsPerResponse: 12,
  /**
   * Media parts one RUN will re-host — the backstop for the multiplication
   * {@link ADMISSION_CEILINGS.mediaPartsPerNodeOutput} permits, exactly as `nodeDispatchesPerRun` backstops
   * retry × chain length (ADR-0086 §4).
   *
   * The per-node ceiling alone bounds nothing at the run scale: a `parallel_of` at the 50-wide `fanOut`
   * ceiling, each branch producing 32 parts, admits ~1,600 re-host fetches in ONE graph layer — the shape
   * ADR-0086 names as its whole reason for existing, applied to a ceiling that did not yet apply it to
   * itself. Generous against real work (a run producing a few dozen media outputs is already unusual) and
   * decisive against the multiplication.
   */
  mediaPartsPerRun: 256,
  /**
   * Settled runs a `WorkflowEngine` keeps addressable in memory (`CR-33`). Not an admission ceiling like
   * its siblings — nothing is rejected — but it lives here because it is the same kind of promise: a number
   * a host can read rather than a growth nobody bounded.
   */
  retainedSettledRuns: 100,
} as const;

/**
 * What an omitted `max_parallel` means (ADR-0086 §3).
 *
 * **A fixed constant on every machine, and that is the decision — not an oversight.** Deriving it from host
 * capacity was the obvious move and is refused: `workflow-yaml-spec.md` guarantees the same file "parses and
 * runs **identically** on every surface", and a CPU-derived default would run the same committed workflow
 * 4-wide on a laptop and 32-wide on a build server, with different cost and different rate-limit behaviour.
 * `packages/core` also cannot read a CPU count without breaking its zero-platform-import rule, so
 * "capacity-derived" would have bought a host seam whose only effect is to make a public-API guarantee
 * conditional.
 *
 * It replaces `Infinity`, which is the one value at which a concurrency cap governs nothing.
 */
export const DEFAULT_MAX_PARALLEL = 8;

/** Build one ceiling issue. Private so every message reads the same way — field, value, ceiling, in order. */
function ceilingIssue(field: string, actual: number, ceiling: number, what: string): GraphIssue {
  return {
    field,
    // The authored VALUE is echoed here, unlike most `GraphIssue` messages which stay to names. It is safe
    // and it is the point: these values are integers the author typed, never a string that could carry a
    // secret, and a rejection that hides the number leaves the author guessing which of their values tripped.
    message: `${what} is ${actual}, above the limit of ${ceiling}`,
    kind: 'ceiling_exceeded',
  };
}

/** Lexicographic id order, named so neither call site carries a nested ternary and both mean the same thing. */
export function byId(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * The producers a node depends on through a `{{ run.outputs["<id>"] }}` template reference.
 *
 * Mirrors `wireOwnDataEdges` in the DAG builder exactly — same source (`nodeReferenceSites`), same `'node'`
 * filter — because a ceiling counting a different set of edges than the builder wires would reject or admit
 * on a number the graph does not have. Duplicates stay in: `addTarget` de-duplicates for fan-out width,
 * while the edge TOTAL counts wiring attempts, which is what the builder does too.
 */
function agentPromptTargets(
  node: WorkflowNode,
  agentsById: ReadonlyMap<string, Agent>,
  nodeIds: ReadonlySet<string>,
): string[] {
  if (node.type !== 'agent') return [];
  const agent = agentsById.get(node.agent_ref);
  if (agent === undefined) return [];
  const producers: string[] = [];
  for (const ref of templateReferences(agent.system_prompt)) {
    if (ref.kind === 'node' && nodeIds.has(ref.identifier)) producers.push(ref.identifier);
  }
  return producers;
}

function dataEdgeTargets(node: WorkflowNode, nodeIds: ReadonlySet<string>): string[] {
  const producers: string[] = [];
  for (const site of nodeReferenceSites(node)) {
    for (const ref of site.references) {
      // **Only producers that EXIST.** `addEdge` is a no-op when an endpoint is not a node, so the builder
      // wires nothing for `{{ run.outputs["typo"] }}` — a dangling reference is the runtime resolver's
      // `unresolved_reference`, not a graph edge. Counting it would give a node that does not exist a
      // fan-out, and would inflate the edge total with edges the graph never has.
      if (ref.kind === 'node' && nodeIds.has(ref.identifier)) producers.push(ref.identifier);
    }
  }
  return producers;
}

/**
 * The agent-scoped ceilings — `retry.max`, `fallback_chain` length, per-entry `max_attempts`.
 *
 * **The shared half of ADR-0086 §6.** Called once per resolved agent by the workflow compiler, and once by
 * `AgentSession` before its first turn, so the two co-equal entry points ([ADR-0024]) cannot disagree about
 * which agent files are admissible.
 *
 * `where` prefixes the issue field so a workflow says which agent tripped (``agent `writer`.retry.max``)
 * while a standalone session says only `retry.max` — the session has one agent and naming it adds nothing.
 * Issues are APPENDED, never thrown: the caller batches them with every other admission fault, so an author
 * sees all of them at once rather than fixing one per run.
 */
export function collectAgentCeilingIssues(agent: Agent, issues: GraphIssue[], where = ''): void {
  const at = (field: string): string => `${where}${field}`;

  if (agent.retry !== undefined && agent.retry.max > ADMISSION_CEILINGS.retryMax) {
    issues.push(
      ceilingIssue(
        at('retry.max'),
        agent.retry.max,
        ADMISSION_CEILINGS.retryMax,
        'the node-retry budget',
      ),
    );
  }

  const chain = agent.fallback_chain;
  if (chain !== undefined) {
    if (chain.length > ADMISSION_CEILINGS.fallbackChainEntries) {
      issues.push(
        ceilingIssue(
          at('fallback_chain'),
          chain.length,
          ADMISSION_CEILINGS.fallbackChainEntries,
          'the fallback chain length',
        ),
      );
    }
    // Every entry, not the first offender: an author fixing one at a time is the batching this whole
    // admission path exists to avoid.
    chain.forEach((entry, i) => {
      if (entry.max_attempts > ADMISSION_CEILINGS.chainEntryMaxAttempts) {
        issues.push(
          ceilingIssue(
            at(`fallback_chain[${i}].max_attempts`),
            entry.max_attempts,
            ADMISSION_CEILINGS.chainEntryMaxAttempts,
            "the chain entry's attempt budget",
          ),
        );
      }
    });
  }
}

/**
 * The workflow-scoped ceilings — node count, edge count, per-node fan-out, and an authored `max_parallel`.
 *
 * Counted on the AUTHORED spec (ADR-0086 §2), which is also why this runs before the graph is built: a file
 * over a ceiling never reaches the compiler, so the check is cheap, order-independent, and reports the
 * numbers the author actually wrote.
 *
 * Fan-out is the authored out-degree, and it counts **both** the plain `edges[]` a node produces **and** a
 * `parallel` node's `parallel_of` members.
 *
 * **The `parallel_of` half is not an extra — it is the case the ceiling is most about, and leaving it out
 * made the ceiling bypassable by rewriting the same graph.** `parallel_of` materialises one fan-out edge per
 * member inside the builder (`wireParallelNode`) without any `edges[]` entry, so a `parallel` node with 200
 * members produced 200 concurrent branches while `edges[]` held one line. Measured before the fix: a
 * 200-member split built a plan without tripping a ceiling of 50. Members are authored — they are just
 * authored somewhere other than `edges[]` — so counting them keeps the "count the authored file" rule
 * (ADR-0086 §2) rather than bending it.
 *
 * A `condition`'s `branches` are excluded, and that asymmetry is deliberate: branches are routing
 * ALTERNATIVES — exactly one is taken — so counting them as width would reject a wide `switch` that never
 * runs more than one target. `parallel_of` members all run, concurrently, which is precisely the shape a
 * fan-out ceiling is for.
 */
/**
 * Every edge the DAG builder will materialise, counted on the authored file.
 *
 * Three routing forms, and only the first is written where a reader would look: `edges[]`, a `parallel`
 * node's `parallel_of` members, and a `{{ run.outputs["<id>"] }}` reference in a template. The last two are
 * wired inside the builder with no `edges[]` entry, so an edge ceiling that read `edges[]` alone was
 * bypassable by authoring the same graph a different way — a 500×500 fan-out past a limit of 2000.
 *
 * A `condition`'s branch targets count too: they are alternatives for ROUTING but each is a real dependency
 * edge the builder wires, and the ceiling is about the graph's size rather than its concurrency.
 */
function countMaterialisedEdges(
  spec: Workflow['workflow'],
  agentsById: ReadonlyMap<string, Agent>,
  nodeIds: ReadonlySet<string>,
): number {
  return spec.nodes.reduce((sum, node) => {
    const data =
      dataEdgeTargets(node, nodeIds).length + agentPromptTargets(node, agentsById, nodeIds).length;
    if (node.type === 'parallel') return sum + node.parallel_of.length + data;
    if (node.type === 'condition') {
      return sum + node.branches.length + (node.default === undefined ? 0 : 1) + data;
    }
    return sum + data;
  }, 0);
}

/**
 * Each node's fan-out width, as the set of DISTINCT targets it routes to.
 *
 * A set rather than a running sum, because the spec documents the redundant form — a `parallel_of` member may
 * ALSO carry an explicit edge to the same node — and a sum would count that width twice, rejecting a file
 * whose graph is identical to an accepted one purely on which of two documented spellings its author chose.
 *
 * A `condition`'s branches are deliberately EXCLUDED here while counting toward the edge total above: exactly
 * one branch is taken, so counting them as concurrent width would reject a wide `switch` that never runs more
 * than one target. `parallel_of` members all run at once, which is the shape a fan-out ceiling is for.
 */
function buildOutTargets(
  spec: Workflow['workflow'],
  edges: readonly { from: string; to: string }[],
  agentsById: ReadonlyMap<string, Agent>,
  nodeIds: ReadonlySet<string>,
): Map<string, Set<string>> {
  const outTargets = new Map<string, Set<string>>();
  const addTarget = (producer: string, target: string): void => {
    const set = outTargets.get(producer) ?? new Set<string>();
    set.add(target);
    outTargets.set(producer, set);
  };
  for (const node of spec.nodes) {
    if (node.type === 'parallel') {
      for (const member of node.parallel_of) addTarget(node.id, member);
    }
    // A data reference makes its PRODUCER wider: `{{ run.outputs["a"] }}` in 200 templates gives `a` an
    // out-degree of 200 with no `edges[]` entry anywhere.
    for (const producer of dataEdgeTargets(node, nodeIds)) addTarget(producer, node.id);
    // **A resolved agent's `system_prompt` references count too.** `validateAgentNode` wires an edge for
    // each one, so leaving them out let a single agent whose prompt names 250 producers give every one of
    // them an out-degree of 250 — measured: 62,500 materialised edges admitted against a ceiling of 2000.
    // The hole was not limited to a host registry; an inline `agents:` entry reaches the same path.
    for (const producer of agentPromptTargets(node, agentsById, nodeIds))
      addTarget(producer, node.id);
  }
  for (const edge of edges) {
    // The authored `from` may carry a `nodeId:handle` suffix; the DEGREE belongs to the node, so strip it.
    const producer = edge.from.split(':')[0] ?? edge.from;
    addTarget(producer, edge.to);
  }
  return outTargets;
}

export function collectWorkflowCeilingIssues(
  def: Workflow,
  agentsById: ReadonlyMap<string, Agent>,
  issues: GraphIssue[],
): void {
  const spec = def.workflow;
  const nodeIds = new Set(spec.nodes.map((node) => node.id));
  const edges = spec.edges ?? [];

  if (spec.nodes.length > ADMISSION_CEILINGS.nodes) {
    issues.push(
      ceilingIssue('workflow.nodes', spec.nodes.length, ADMISSION_CEILINGS.nodes, 'the node count'),
    );
  }

  const totalEdges = edges.length + countMaterialisedEdges(spec, agentsById, nodeIds);
  if (totalEdges > ADMISSION_CEILINGS.edges) {
    issues.push(
      ceilingIssue('workflow.edges', totalEdges, ADMISSION_CEILINGS.edges, 'the edge count'),
    );
  }

  // Sorted so a file with several over-wide nodes reports them in a stable order — an unstable order makes a
  // snapshot test flaky for a reason that has nothing to do with the defect it guards.
  const outTargets = [...buildOutTargets(spec, edges, agentsById, nodeIds)].sort(([a], [b]) =>
    byId(a, b),
  );
  for (const [nodeId, targets] of outTargets) {
    if (targets.size > ADMISSION_CEILINGS.fanOut) {
      issues.push(
        ceilingIssue(
          `node \`${nodeId}\` out-degree`,
          targets.size,
          ADMISSION_CEILINGS.fanOut,
          "the node's fan-out width",
        ),
      );
    }
  }

  // **The NODE's retry budget, which is the one the engine actually spends.** `#retryConfig` reads
  // `node.retry ?? agent.retry` for an agent node and `node.retry` alone for `condition`/`transform`/`merge`
  // — so checking only the resolved agent left the ceiling bypassable by one line of YAML on the node, and
  // left the three non-agent types with no enforcement path at all.
  for (const node of spec.nodes) {
    const retry = 'retry' in node ? node.retry : undefined;
    if (retry !== undefined && retry.max > ADMISSION_CEILINGS.retryMax) {
      issues.push(
        ceilingIssue(
          `node \`${node.id}\`.retry.max`,
          retry.max,
          ADMISSION_CEILINGS.retryMax,
          'the node-retry budget',
        ),
      );
    }
  }

  const maxParallel = spec.max_parallel;
  if (maxParallel !== undefined && maxParallel > ADMISSION_CEILINGS.maxParallel) {
    issues.push(
      ceilingIssue(
        'workflow.max_parallel',
        maxParallel,
        ADMISSION_CEILINGS.maxParallel,
        'the concurrency cap',
      ),
    );
  }
}
