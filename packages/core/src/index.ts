/**
 * `@relavium/core` public surface — the engine. Curated, **not** `export *`: only the engine's
 * contract is public. The `WorkflowYAMLParser` (1.L) lands first; the DAG builder (1.M), run loop
 * (1.N), checkpoint/resume (1.R), and retry extend this surface as they land. Zero platform-specific
 * imports (CLAUDE.md rule 5, ADR-0011) — the whole package runs in Node, the Tauri WebView, the VS
 * Code extension host, and Bun alike.
 */

// WorkflowYAMLParser (1.L / 1.L2) — parse + validate + static interpolation gates into a typed def.
export { parseWorkflow, MAX_SOURCE_CHARS } from './parser.js';
export type { WorkflowDefinition, ParseWorkflowOptions } from './parser.js';

// Agent parser — the `.agent.yaml` sibling of parseWorkflow (CLI catalog scan 2.I, authoring 2.J).
export { parseAgent, AgentParseError } from './agent-parser.js';
export type { AgentDefinition, ParseAgentOptions } from './agent-parser.js';

// Catalog-aware load-check (1.AF/D15) — validates each agent node's `output_modalities` against its
// resolved model's `media.outputCombinations`, using a host-provided model→capabilities catalog.
export { validateWorkflowWithCatalog, type WorkflowModelCatalog } from './validate-catalog.js';

// Typed, field-named, secret-free parse/validation errors — narrow on `code`, never on `message`.
export {
  WorkflowParseError,
  WorkflowSyntaxError,
  WorkflowValidationError,
  WorkflowSecretLeakError,
  WorkflowGraphError,
  InterpolationError,
  SandboxError,
} from './errors.js';
export type {
  WorkflowParseErrorCode,
  WorkflowIssue,
  SecretLeak,
  GraphIssue,
  GraphIssueKind,
  InterpolationErrorCode,
  SandboxErrorReason,
} from './errors.js';

// Structured, un-evaluated interpolation references — the view the DAG builder (1.M) consumes.
export { parseTemplate, templateReferences } from './interpolation/references.js';
export type {
  TemplateSegment,
  InterpolationReference,
  ReferenceKind,
  PipeFilter,
  FilterArg,
} from './interpolation/references.js';
export { collectReferences } from './interpolation/collect.js';
export type { ReferenceSite, ReferenceSiteCategory } from './interpolation/collect.js';

// Static interpolation analyses (1.L2) — also consumed by the future VS Code language server.
export {
  analyzeSecretTaint,
  analyzePreRunReferences,
  analyzeResolvedAgentTaint,
} from './interpolation/analyze.js';

// The `{{ … }}` runtime resolver (1.L2) — evaluate templates against a run scope, eager-once context.
export { resolveTemplate, resolveContext } from './interpolation/resolve.js';
export type { RunScope, ResolverCapabilities } from './interpolation/scope.js';

// DAG builder + RunPlan (1.M) — compile a validated definition into an executable, topologically
// ordered plan; the run loop (1.N) and AgentRunner (1.O) consume it.
export { buildRunPlan } from './dag.js';
export type { BuildRunPlanOptions } from './dag.js';
export type {
  RunPlan,
  PlanVertex,
  PlanConfig,
  InputPlanConfig,
  AgentPlanConfig,
  ConditionPlanConfig,
  TransformPlanConfig,
  FanOutPlanConfig,
  FanInPlanConfig,
  HumanGatePlanConfig,
  OutputPlanConfig,
  JoinStrategy,
  MergeStrategy,
} from './run-plan.js';

// Expression sandbox (1.AB) — the deterministic, resource-capped QuickJS-wasm evaluator for the bare
// JS condition / transform / merge_fn expressions (ADR-0027; expression-sandbox-spec.md). The 1.P node
// handlers create one sandbox and call `evaluate`; failures surface as the typed `SandboxError` above.
export { createExpressionSandbox, DEFAULT_SANDBOX_LIMITS } from './expression/sandbox.js';
export type {
  ExpressionSandbox,
  EvaluateInput,
  ExpressionScope,
  ExpressionKind,
  SandboxLimits,
} from './expression/sandbox.js';

// WorkflowEngine + RunEventBus (1.N) — the run loop. Walks the RunPlan, dispatches ready nodes through
// the injected NodeExecutor seam (1.O/1.P fill it), and emits the canonical RunEvent stream with the
// exactly-one-terminal-event guarantee (ADR-0036; sse-event-schema.md). Platform-free: host concerns
// (clock / ids / persistence / abort) are injected via ExecutionHost.
export { WorkflowEngine } from './engine/engine.js';
export type { StartInput, ResumeFromCheckpointInput, WorkflowEngineDeps } from './engine/engine.js';
export { RunEventBus } from './engine/event-bus.js';
export type {
  RunEventBusOptions,
  RunEventListener,
  BusEventListener,
  RunEventDraft,
  SessionEventDraft,
  BusEventDraft,
} from './engine/event-bus.js';
export type { RunHandle } from './engine/run-handle.js';
export {
  InMemoryRunStore,
  createInMemoryHost,
  createInMemoryCheckpointer,
  createAbortController,
  createManualTimerController,
} from './engine/execution-host.js';
// Checkpointer + resume (1.R) — reconstruct a run's state from its persisted event stream (no checkpoint
// table; ADR-0003). The in-memory reference ships here; the SQLite/cloud one is Phase-2/CLI.
export { reconstructCheckpointState, CHECKPOINT_SCHEMA_VERSION } from './engine/checkpoint.js';
export type {
  Checkpointer,
  CheckpointState,
  CheckpointNodeState,
  CheckpointPendingGate,
  CheckpointPendingMediaJob,
} from './engine/checkpoint.js';
export type {
  ExecutionHost,
  RunStore,
  Clock,
  IdSource,
  AbortControllerLike,
  InterruptedRun,
  SetTimer,
  ManualTimerController,
} from './engine/execution-host.js';
export type {
  NodeExecutor,
  NodeExecContext,
  NodeOutcome,
  NodeFailure,
  NodeStreamEvent,
  GateRequest,
  GateType,
} from './engine/node-executor.js';

// Typed run-loop API-boundary errors (1.N) — narrow on `code`, never on `message`.
export { EngineStateError } from './engine/errors.js';
export type { EngineStateErrorCode } from './engine/errors.js';

// Typed run-loop substrate INVARIANT breaches (the bus/stream "can never happen" asserts) — surfaced loud
// so a producer/consumer bug is caught at source rather than silently un-gapping the sequence (ADR-0036).
export { RunLoopInvariantError } from './engine/invariant-error.js';
export type { RunLoopInvariantCode } from './engine/invariant-error.js';

// AgentRunner (1.O) — the single dispatching NodeExecutor for `agent` vertices; a surface constructs
// it with host capabilities (resolveProvider + the chain's keyFor/sleep) and injects it as
// WorkflowEngineDeps.executor (ADR-0038). The correlation-agnostic turn core it wraps stays internal
// to the package — AgentSession (1.V) imports it intra-package, not from this curated surface.
export { createAgentNodeExecutor } from './engine/agent-runner.js';
export type { AgentRunnerDeps } from './engine/agent-runner.js';
export { DEFAULT_AGENT_TURN_LIMITS } from './engine/agent-turn.js';
export type { AgentTurnLimits, PreEgressHook } from './engine/agent-turn.js';

// Budget governor (1.AC) — the pre-egress cost gate a surface wires behind the `PreEgressHook` seam and
// whose typed cap errors the run/session loops classify (ADR-0028). Exported so a surface can construct the
// governor and narrow on `BudgetExceededError`/`BudgetPauseError` by class (never by message).
export {
  BudgetGovernor,
  BudgetExceededError,
  BudgetPauseError,
  DEFAULT_MAX_TOKENS_ESTIMATE,
} from './engine/budget-governor.js';
export type { BudgetCheckResult } from './engine/budget-governor.js';

// AgentSession (1.V) — the agent-first entry point: a multi-turn conversation bound to one agent,
// driving the SAME turn core a workflow `agent` node uses ([ADR-0024], agent-session-spec.md). A surface
// mints a sessionId and constructs it with host capabilities + an injected SessionEventSink; wiring that
// sink onto the shared RunEventBus (per-session sequenceNumber + gap/resync + a SessionHandle) is 1.W,
// and persistence is 1.X. The hard turn cap fails loud with `turn_limit` — never a silent stop.
export {
  AgentSession,
  DEFAULT_SESSION_MAX_TURNS,
  SessionStateError,
} from './engine/agent-session.js';
export type {
  SessionDeps,
  AgentSessionParams,
  SessionEventSink,
  SessionStreamEvent,
  SessionLifecycleEvent,
} from './engine/agent-session.js';
// Session checkpoint/resume (1.Y) — reconstruct the in-flight state from a persisted transcript (1.X) so a
// session continues after a restart; the host loads via the @relavium/db SessionStore and hands the result
// to AgentSession.resume. Directly-stored, not event-sourced (ADR-0003); reuses the 1.R idempotency principle.
export { reconstructSessionState } from './engine/session-resume.js';
export type { SessionResumeState } from './engine/session-resume.js';
// 1.W — the session:* namespace on the shared bus: the SessionEventSink→RunEventBus adapter (attaches the
// sessionId; the bus stamps the per-session sequenceNumber) and the SessionHandle (mirrors RunHandle,
// scoped to sessionId, terminal on session:cancelled). See sse-event-schema.md §"The session stream".
export { createSessionHandle, createSessionEventSink } from './engine/session-handle.js';
export type { SessionHandle, SessionStreamHandleEvent } from './engine/session-handle.js';

// Session export-to-workflow (1.Z) — the inverse of parseWorkflow (1.L is parse-only). `serializeWorkflow`
// emits a WorkflowDefinition as deterministic, round-trippable YAML; `serializeAgent` is its `.agent.yaml`
// counterpart (the CLI authoring 2.J `create`/`import`/`export` path); `sessionToWorkflow` maps a persisted
// session + transcript into a linear-chain scaffold (ADR-0026; agent-session-spec.md §"Export to workflow").
export { serializeWorkflow, serializeAgent, sessionToWorkflow } from './export/serializer.js';

// Node-type handlers (1.P) — the six non-agent NodeExecutor arms (condition / transform / fan_out /
// fan_in / input / output) plus the dispatcher that composes them (and the 1.O agent arm) into the one
// executor the engine holds. `createStandardNodeExecutor` is the convenience wirer; the per-type
// factories support custom composition. condition/transform/fan_in(custom) take the 1.AB sandbox.
export {
  createDispatchingNodeExecutor,
  createStandardNodeExecutor,
} from './engine/node-handlers/dispatcher.js';
export type {
  NodeExecutorMap,
  StandardNodeExecutorDeps,
} from './engine/node-handlers/dispatcher.js';
export { createConditionNodeExecutor } from './engine/node-handlers/condition.js';
export type { ConditionNodeExecutorDeps } from './engine/node-handlers/condition.js';
export { createTransformNodeExecutor } from './engine/node-handlers/transform.js';
export type { TransformNodeExecutorDeps } from './engine/node-handlers/transform.js';
export { createFanInNodeExecutor } from './engine/node-handlers/fan-in.js';
export type { FanInNodeExecutorDeps } from './engine/node-handlers/fan-in.js';
export { createFanOutNodeExecutor } from './engine/node-handlers/fan-out.js';
export { createHumanGateNodeExecutor } from './engine/node-handlers/human-gate.js';
export type { HumanGateNodeExecutorDeps } from './engine/node-handlers/human-gate.js';
export { createInputNodeExecutor, createOutputNodeExecutor } from './engine/node-handlers/io.js';

// Built-in ToolRegistry + dispatch (1.T) — the engine-side registry the AgentRunner (1.O) and
// AgentSession (1.V) invoke; side effects go through the injected ToolHost seam (ADR-0037;
// tool-registry.md). Pure: zero platform imports, unit-testable against a stub host.
export { createToolRegistry } from './tools/registry.js';
export { BUILTIN_TOOLS, BUILTIN_TOOL_IDS } from './tools/builtins.js';
export { DEFAULT_TOOL_RESULT_LIMITS } from './tools/types.js';
export { markUntrusted, unwrapUntrusted, isUntrusted } from './tools/untrusted.js';
export {
  ToolDispatchError,
  UnknownToolError,
  ToolPolicyError,
  ToolArgsInvalidError,
  ToolUnavailableError,
  ToolExecutionError,
  ToolCancelledError,
} from './tools/errors.js';
export type { ToolErrorCode, ToolPolicyDenyReason } from './tools/errors.js';
export type { Untrusted } from './tools/untrusted.js';
export type {
  ToolRegistry,
  CreateToolRegistryOptions,
  ToolDef,
  ToolId,
  ToolSource,
  JsonSchema,
  EgressKind,
  ToolPolicyClass,
  PolicyTarget,
  ToolHost,
  FsCapability,
  ProcessCapability,
  EgressCapability,
  OsCapability,
  McpCapability,
  ToolOutputStore,
  FileRead,
  FileWritten,
  DirEntry,
  DirListing,
  ProcessResult,
  EgressRequest,
  EgressResponse,
  SpilledResult,
  NotifyInput,
  McpCallInput,
  FsReadOpts,
  FsWriteOpts,
  FsListOpts,
  SpawnOpts,
  ToolNodeConfig,
  ToolDispatchContext,
  MediaReadAccess,
  MediaHandleInfo,
  ToolDispatchOutcome,
  ToolCallPart,
  ToolResultPart,
  ToolCallEventData,
  ToolResultEventData,
  ToolResultLimits,
  FsScopeTier,
} from './tools/types.js';
