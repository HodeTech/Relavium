/**
 * The `RunPlan` — the executable plan the DAG builder (1.M) produces from a validated
 * `WorkflowDefinition`. It is a **core-only TypeScript type**, not a `@relavium/shared` Zod schema:
 * the plan is an internal, runtime-derived engine artifact (a topological order over engine vertices,
 * each carrying its dependency edges and the un-evaluated templates to resolve at dispatch), not an
 * authored or persisted wire contract (CLAUDE.md rule 8 — `@relavium/shared` owns the authored/
 * persisted contracts; the plan is reconstructed from the workflow + checkpoint on resume, never
 * serialized in Phase 1). It is consumed by the run loop (1.N) and the `AgentRunner` (1.O).
 *
 * Authored nodes map to **engine** vertices (node-types.md): `parallel` → `fan_out`, `merge` →
 * `fan_in`, `human_gate` → `human_in_the_loop`; the rest keep their authored type. The authored
 * `parallel`/`merge` pair realizes the conceptual fan_out/fan_in split-join across two vertices
 * bracketed by edges — the builder synthesizes no extra vertices (see the canonical example in
 * workflow-yaml-spec.md §Complete example).
 *
 * **A plan carries _what to resolve_, never _resolved values_.** Upstream node outputs do not exist at
 * plan time (planning is pure and runs once, before any node executes), so a vertex's `inputSites` are
 * the structured, un-evaluated `{{ … }}` templates (1.L/1.L2) that 1.N/1.O resolve at dispatch against
 * settled upstream results — not evaluated inputs.
 */

import type { Agent, FallbackChainEntry, EngineNodeType, WorkflowNode } from '@relavium/shared';

import type { ReferenceSite } from './interpolation/collect.js';

/** The authored node variants, narrowed from the shared discriminated union for per-type config. */
type AgentNode = Extract<WorkflowNode, { type: 'agent' }>;
type ConditionNode = Extract<WorkflowNode, { type: 'condition' }>;
type TransformNode = Extract<WorkflowNode, { type: 'transform' }>;
type ParallelNode = Extract<WorkflowNode, { type: 'parallel' }>;
type MergeNode = Extract<WorkflowNode, { type: 'merge' }>;
type HumanGateNode = Extract<WorkflowNode, { type: 'human_gate' }>;
type InputNode = Extract<WorkflowNode, { type: 'input' }>;
type OutputNode = Extract<WorkflowNode, { type: 'output' }>;

/** How a `merge` node's aggregation combines its inputs (the authored `merge_strategy` value). */
export type MergeStrategy = MergeNode['merge_strategy'];

/**
 * The `fan_in` *join* axis — *when* the join fires, orthogonal to `merge_strategy`'s *how to combine*
 * (node-types.md §Per-type engine config). `wait_n` is a reserved engine slot with no v1.0 authored
 * surface; the builder only ever derives `wait_all` / `wait_first`.
 */
export type JoinStrategy = 'wait_all' | 'wait_first' | 'wait_n';

/** The split half of an authored `parallel` block (node-types.md `fan_out_config`). */
export interface FanOutPlanConfig {
  readonly kind: 'fan_out';
  readonly node: ParallelNode;
  /** The concurrent branch node ids — the authored `parallel_of`, authoritative for membership. */
  readonly branchNodeIds: readonly string[];
}

/** The aggregating join half (node-types.md `fan_in_config`) — derived from an authored `merge` node. */
export interface FanInPlanConfig {
  readonly kind: 'fan_in';
  readonly node: MergeNode;
  /** *When* the join fires — `wait_first` for `merge_strategy: first`, else `wait_all`. */
  readonly joinStrategy: JoinStrategy;
  /** *How* the branches combine — the authored `merge_strategy`, carried verbatim. */
  readonly mergeStrategy: MergeStrategy;
  /** The author-supplied `js` merge expression — present only for `merge_strategy: custom`. */
  readonly mergeFn?: string;
}

/** An LLM agent vertex (node-types.md `agent_config`). */
export interface AgentPlanConfig {
  readonly kind: 'agent';
  readonly node: AgentNode;
  /**
   * The resolved agent (inline `agents:` entry, or a host-supplied resolved `$ref`/registry agent),
   * when available. Absent when no resolved-agent registry was supplied and the ref is not inline —
   * `agent_ref` resolution against the workspace registry is a host concern (workflow.ts).
   */
  readonly resolvedAgent?: Agent;
  /** The resolved agent's multi-provider fallback chain, lifted for the run loop's convenience. */
  readonly fallbackChain?: readonly FallbackChainEntry[];
}

/** A condition (branch) vertex (node-types.md `condition_config`); routing lives on `node.branches`. */
export interface ConditionPlanConfig {
  readonly kind: 'condition';
  readonly node: ConditionNode;
}

/** A `transform` vertex — a sandboxed `js` reshaping of run state (node-types.md `transform_config`). */
export interface TransformPlanConfig {
  readonly kind: 'transform';
  readonly node: TransformNode;
}

/** A human gate vertex (`human_gate` → engine `human_in_the_loop`). */
export interface HumanGatePlanConfig {
  readonly kind: 'human_in_the_loop';
  readonly node: HumanGateNode;
}

/** The workflow entry vertex. */
export interface InputPlanConfig {
  readonly kind: 'input';
  readonly node: InputNode;
}

/** A terminal output-capturing vertex. */
export interface OutputPlanConfig {
  readonly kind: 'output';
  readonly node: OutputNode;
}

/** The per-type config block on a {@link PlanVertex}, discriminated on `kind` (the engine vertex type). */
export type PlanConfig =
  | InputPlanConfig
  | AgentPlanConfig
  | ConditionPlanConfig
  | TransformPlanConfig
  | FanOutPlanConfig
  | FanInPlanConfig
  | HumanGatePlanConfig
  | OutputPlanConfig;

/** One engine vertex of the plan — an authored node mapped to its engine type, with its graph wiring. */
export interface PlanVertex {
  /** The vertex id — the authored node id (no synthetic vertices are created). */
  readonly id: string;
  /** The engine node type (node-types.md §engine enum); `parallel`→`fan_out`, `merge`→`fan_in`, etc. */
  readonly type: EngineNodeType;
  /** Vertex ids this vertex depends on (its in-edges) — drives the run loop's completion-gated readiness. */
  readonly dependencies: readonly string[];
  /** Vertex ids that depend on this one (its out-edges) — drives skip-propagation. */
  readonly dependents: readonly string[];
  /**
   * The un-evaluated `{{ … }}` template sites on this vertex's own authored fields (an agent's
   * `prompt_template`/`system_prompt_append`, a gate's `assignee`/`message_template`), resolved at
   * dispatch by 1.N/1.O — never evaluated here. Empty for nodes with no template fields.
   */
  readonly inputSites: readonly ReferenceSite[];
  /** The per-type config block. */
  readonly config: PlanConfig;
}

/**
 * The executable plan: a deterministic topological order over engine vertices, each fully wired to its
 * dependencies/dependents and carrying its un-evaluated input templates and per-type config.
 */
export interface RunPlan {
  /** The workflow id (`workflow.id`). */
  readonly workflowId: string;
  /** Kahn topological order over vertex ids; ties broken by authored order, so the plan is reproducible. */
  readonly order: readonly string[];
  /** Every engine vertex, by id. */
  readonly vertices: ReadonlyMap<string, PlanVertex>;
  /** The run-wide concurrency cap (`workflow.max_parallel`), when declared. */
  readonly maxParallel?: number;
}
