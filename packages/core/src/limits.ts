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

import type { Agent, Workflow } from '@relavium/shared';

import type { GraphIssue } from './errors.js';

/**
 * Every absolute ceiling, in one frozen object so a host can read the number it will be judged against
 * rather than discovering it from a rejection (ADR-0086 §9.3).
 *
 * Exported as data, not as eight loose constants, for the same reason `DEFAULT_TOOL_RESULT_LIMITS` is: a
 * caller that wants to display the limits should not have to know eight identifier names, and a future
 * host-side override has one shape to override.
 */
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
export function collectWorkflowCeilingIssues(def: Workflow, issues: GraphIssue[]): void {
  const spec = def.workflow;

  if (spec.nodes.length > ADMISSION_CEILINGS.nodes) {
    issues.push(
      ceilingIssue('workflow.nodes', spec.nodes.length, ADMISSION_CEILINGS.nodes, 'the node count'),
    );
  }

  const edges = spec.edges ?? [];
  // Same reasoning as fan-out below: `parallel_of` members become real edges in the built graph, so an
  // edge ceiling that counted only `edges[]` would let 500 parallel nodes × 500 members past a limit of
  // 2000. They are authored edges written in a different place, not compiled ones.
  // Every routing form the builder materialises, not only `edges[]`: a `parallel`'s members AND a
  // `condition`'s branch targets both become real graph edges (`wireParallelNode` / the condition wiring), so
  // an edge ceiling that counted `edges[]` alone was bypassable by authoring the same graph a different way.
  const materialisedEdges = spec.nodes.reduce((sum, node) => {
    if (node.type === 'parallel') return sum + node.parallel_of.length;
    if (node.type === 'condition')
      return sum + node.branches.length + (node.default === undefined ? 0 : 1);
    return sum;
  }, 0);
  const totalEdges = edges.length + materialisedEdges;
  if (totalEdges > ADMISSION_CEILINGS.edges) {
    issues.push(
      ceilingIssue('workflow.edges', totalEdges, ADMISSION_CEILINGS.edges, 'the edge count'),
    );
  }

  // **Fan-out width, counted over the DISTINCT targets a node routes to.** A set, not a running sum, because
  // the spec documents the redundant form — a `parallel_of` member (or a `condition` branch target) may ALSO
  // carry an explicit edge to the same node — and a sum would count that width twice, rejecting a file whose
  // graph is identical to an accepted one purely on which of two documented spellings its author chose.
  const outTargets = new Map<string, Set<string>>();
  const addTarget = (producer: string, target: string): void => {
    const set = outTargets.get(producer) ?? new Set<string>();
    set.add(target);
    outTargets.set(producer, set);
  };
  for (const node of spec.nodes) {
    if (node.type === 'parallel') {
      // Members are fan-out edges the builder materialises with no `edges[]` entry, so leaving them out made
      // the ceiling bypassable: a 200-member split read as a width of zero.
      for (const member of node.parallel_of) addTarget(node.id, member);
    }
  }
  for (const edge of edges) {
    // The authored `from` may carry a `nodeId:handle` suffix; the DEGREE belongs to the node, so strip it.
    // Counting `a:true` and `a:false` as two different sources would under-report a condition's width — and
    // over-report nothing, since a plain edge has no colon.
    const producer = edge.from.split(':')[0] ?? edge.from;
    addTarget(producer, edge.to);
  }
  // Sorted so a file with several over-wide nodes reports them in a stable order — an unstable order makes
  // a snapshot test flaky for a reason that has nothing to do with the defect it is guarding.
  for (const [nodeId, targets] of [...outTargets].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const degree = targets.size;
    if (degree > ADMISSION_CEILINGS.fanOut) {
      issues.push(
        ceilingIssue(
          `node \`${nodeId}\` out-degree`,
          degree,
          ADMISSION_CEILINGS.fanOut,
          "the node's fan-out width",
        ),
      );
    }
  }

  // **The NODE's retry budget, which is the one the engine actually spends.** `#retryConfig` reads
  // `node.retry ?? agent.retry` for an agent node and `node.retry` alone for `condition`/`transform`/`merge`
  // — so checking only the resolved agent left the ceiling bypassable by one line of YAML on the node, and
  // left the three non-agent types with no enforcement path at all. Measured before this: a `transform` with
  // `retry: { max: 100000 }` was ADMITTED, and so was an agent node overriding an at-ceiling agent.
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
