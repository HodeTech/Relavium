/**
 * `@relavium/core` public surface — the engine. Curated, **not** `export *`: only the engine's
 * contract is public. The `WorkflowYAMLParser` (1.L) lands first; the DAG builder (1.M), run loop
 * (1.N), checkpoint/resume (1.R), and retry extend this surface as they land. Zero platform-specific
 * imports (CLAUDE.md rule 5, ADR-0011) — the whole package runs in Node, the Tauri WebView, the VS
 * Code extension host, and Bun alike.
 */

// WorkflowYAMLParser (1.L / 1.L2) — parse + validate + static interpolation gates into a typed def.
export { parseWorkflow } from './parser.js';
export type { WorkflowDefinition, ParseWorkflowOptions } from './parser.js';

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
export type { StartInput, WorkflowEngineDeps } from './engine/engine.js';
export { RunEventBus } from './engine/event-bus.js';
export type { RunEventBusOptions, RunEventListener, RunEventDraft } from './engine/event-bus.js';
export type { RunHandle } from './engine/run-handle.js';
export {
  InMemoryRunStore,
  createInMemoryHost,
  createAbortController,
} from './engine/execution-host.js';
export type {
  ExecutionHost,
  RunStore,
  Clock,
  IdSource,
  AbortControllerLike,
  InterruptedRun,
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
  ToolDispatchOutcome,
  ToolCallPart,
  ToolResultPart,
  ToolCallEventData,
  ToolResultEventData,
  ToolResultLimits,
  FsScopeTier,
} from './tools/types.js';
