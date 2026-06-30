/**
 * The engine-side tool-execution contract (1.T) — the `ToolDef` registry shape, the host-injected
 * `ToolHost` capability seam, the per-dispatch context, and the dispatch outcome. The canonical home
 * for these shapes is [tool-registry.md](../../../../docs/reference/shared-core/tool-registry.md); the
 * decision is ADR-0037. The rule that shapes everything here: `@relavium/core` has zero
 * platform-specific imports (CLAUDE.md rule 5), so the engine owns tool **policy + dispatch** (pure)
 * and performs every side effect through an injected `ToolHost` — the same purity seam as
 * `ResolverCapabilities` (1.L2) and the injected HTTP transport (ADR-0018).
 */

import type {
  AbortSignalLike,
  ByteRange,
  ContentPart,
  FsScopeTier,
  MediaSource,
  Scope,
  ToolActionClass,
} from '@relavium/shared';

import type { Untrusted } from './untrusted.js';

// Re-export the canonical FS scope tier (`'sandboxed' | 'project' | 'full'`, constants.ts) rather than
// redefining it — the engine binds `ToolDispatchContext.fsScope` to the shared source of truth.
export type { FsScopeTier };

/** A canonical, engine-executed tool-call content part (the `provider_executed` arm is never dispatched). */
export type ToolCallPart = Extract<ContentPart, { type: 'tool_call' }>;
/** A canonical tool-result content part — `media` carries durable handles (ADR-0031), never raw bytes. */
export type ToolResultPart = Extract<ContentPart, { type: 'tool_result' }>;

/** Exact-match registry key. Built-ins use the fixed catalog ids; MCP/plugin tools register dynamically. */
export type ToolId = string;
/** Where a registered tool comes from (mirrors `tool_config.tool_source`, node-types.md). */
export type ToolSource = 'builtin' | 'mcp' | 'plugin';

/**
 * A JSON-Schema object carried as data — the LLM-visible projection the `ToolNormalizer` (1.E, in
 * `@relavium/llm`) lowers to each provider's wire shape. The engine never interprets it; it only
 * forwards it, so a structural record is the right carrier here (the seam types it as `JSONSchema7`).
 */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** The three outbound paths have different policies (ADR-0029(d)); the kind discriminates them. */
export type EgressKind = 'http' | 'search' | 'mcp';

/** A tool's guardrail/capability classification — drives the engine's pre-dispatch policy checks. */
export interface ToolPolicyClass {
  /** Needs the FS scope tier — `read_file`, `write_file`, `list_directory`. */
  readonly fsScoped: boolean;
  /**
   * The fs operation is a WRITE (`write_file`), not a read — `fsScoped` alone is `true` for reads AND
   * writes alike, so it cannot tell `write_file` from `read_file`. The additive discriminator the
   * per-tool approval needs to gate writes (ADR-0057 EA3) and the `fs-write` ActionClass
   * [ADR-0041](../../../../docs/decisions/0041-external-action-governance-seam.md) already proposed —
   * landed here, credited to both. Absent/false ⇒ a read-only fs tool (never governed by approval).
   */
  readonly fsWrite?: boolean;
  /** Spawns an OS process under the `allowedCommands` allowlist — `run_command`, `git_*`. */
  readonly spawnsProcess: boolean;
  /** Outbound egress, discriminated by kind — `http_request` / `web_search` / `mcp_call`. */
  readonly egress?: EgressKind;
  /** Requires a human-gate approval in an automated workflow before it may execute — `git_commit`. */
  readonly requiresGateApproval: boolean;
}

/* ------------------------------------------------------------------------------------------------ *
 * The ToolHost capability seam — the engine's only path to a side effect. Each capability is
 * OPTIONAL: a tool whose capability is absent fails with a typed `ToolUnavailableError`, never a
 * crash and never a platform import sneaking into the engine.
 * ------------------------------------------------------------------------------------------------ */

export interface FileRead {
  readonly content: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly lastModified: string;
  /** Durable media handle(s) when the file is binary/media (ADR-0031) — never inline base64 in `content`. */
  readonly media?: ToolResultPart['media'];
}
export interface FileWritten {
  readonly path: string;
  readonly bytesWritten: number;
}
export interface DirEntry {
  readonly name: string;
  readonly type: 'file' | 'directory';
  readonly sizeBytes: number;
  readonly lastModified: string;
}
export interface DirListing {
  readonly entries: readonly DirEntry[];
}
export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}
export interface EgressRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly url: string;
  // `| undefined` on the optional fields: these are forwarded from optional tool args, so the engine
  // passes the value through verbatim (the exactOptionalPropertyTypes pass-through idiom).
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | undefined;
  /**
   * An OPAQUE secret-store reference (a `web_search` provider key, an auth header value) the host
   * resolves and attaches INSIDE its trusted boundary — the ADR-0006/0018 key-reference pattern. The
   * raw secret never enters the engine / WebView.
   */
  readonly credentialRef?: string | undefined;
}
export interface EgressResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface FsCapability {
  readFile(path: string, opts: FsReadOpts, signal?: AbortSignalLike): Promise<FileRead>;
  writeFile(
    path: string,
    data: string,
    opts: FsWriteOpts,
    signal?: AbortSignalLike,
  ): Promise<FileWritten>;
  listDirectory(path: string, opts: FsListOpts, signal?: AbortSignalLike): Promise<DirListing>;
}
// `| undefined` on these forwarded-from-optional-args fields (exactOptionalPropertyTypes pass-through).
export interface FsReadOpts {
  readonly glob?: boolean | undefined;
}
export interface FsWriteOpts {
  readonly append?: boolean | undefined;
  readonly createDirs?: boolean | undefined;
}
export interface FsListOpts {
  readonly recursive?: boolean | undefined;
  readonly glob?: string | undefined;
}

export interface ProcessCapability {
  /**
   * Spawn an already-allowlist-checked command with `shell: false`. The HOST resolves the executable
   * (platform PATH lookup) and supplies the platform-minimal base env, merging ONLY `declaredEnv`
   * under an audited allowlist — never the full ambient `process.env`. The engine cannot build a
   * platform base env (it is platform-free), so env construction is the host's job; the engine
   * supplies the policy (the allowlist-checked command + the declared vars). stdout/stderr are
   * untrusted.
   */
  spawn(
    command: string,
    args: readonly string[],
    declaredEnv: Readonly<Record<string, string>>,
    opts: SpawnOpts,
    signal?: AbortSignalLike,
  ): Promise<ProcessResult>;
}
export interface SpawnOpts {
  readonly cwd?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface EgressCapability {
  /**
   * Perform an outbound HTTPS request the engine has ALREADY policy-checked (per egress kind). The
   * host MUST run the one shared SSRF range-primitive (block private/loopback/link-local/metadata/
   * CGNAT; DNS-resolve + connect-by-validated-IP + per-hop-redirect-revalidate — security-review.md)
   * and resolve any `credentialRef` host-side. Ships feature-flag-OFF until the primitive lands (1.AE).
   */
  fetch(request: EgressRequest, signal?: AbortSignalLike): Promise<EgressResponse>;
}

export interface OsCapability {
  readClipboard(signal?: AbortSignalLike): Promise<string>;
  notify(input: NotifyInput, signal?: AbortSignalLike): Promise<void>;
}
export interface NotifyInput {
  readonly title: string;
  readonly body: string;
}

export interface McpCapability {
  call(input: McpCallInput, signal?: AbortSignalLike): Promise<unknown>;
}
export interface McpCallInput {
  readonly server: string;
  readonly tool: string;
  readonly args: unknown;
}

/** A run-scoped store for over-ceiling result spill — reclaimed at the run's terminal event. */
export interface ToolOutputStore {
  spill(text: string, limits: ToolResultLimits, signal?: AbortSignalLike): Promise<SpilledResult>;
}
export interface SpilledResult {
  /** A path/handle to the full spilled output, handed to the model + readable via the FS-scoped tools. */
  readonly ref: string;
  readonly byteLength: number;
}

/** The injected capability bundle. A sibling seam to ADR-0036's `ExecutionHost` and `ResolverCapabilities`. */
export interface ToolHost {
  readonly fs?: FsCapability;
  readonly process?: ProcessCapability;
  readonly egress?: EgressCapability;
  readonly os?: OsCapability;
  readonly mcp?: McpCapability;
  readonly outputStore?: ToolOutputStore;
}

/* ------------------------------------------------------------------------------------------------ *
 * The model-facing result bounding (the deferred tool-output-gate). Bounds the result that re-enters
 * the next LlmRequest; `output_mapping` always sees the FULL result (tool-registry.md).
 * ------------------------------------------------------------------------------------------------ */

export interface ToolResultLimits {
  /** Byte ceiling for the model-facing result; over ⇒ spill + preview. */
  readonly maxBytes: number;
  /** Line ceiling for the model-facing result; over ⇒ spill + preview. */
  readonly maxLines: number;
}

/** v1.0 defaults (built-in-tools.md §Tool result bounding) — tunable, byte/line (no token count). */
export const DEFAULT_TOOL_RESULT_LIMITS: ToolResultLimits = { maxBytes: 50 * 1024, maxLines: 2000 };

/* ------------------------------------------------------------------------------------------------ *
 * Dispatch context + ToolDef + outcome.
 * ------------------------------------------------------------------------------------------------ */

/** The resolved tool/agent config block (node-types.md `tool_config`/`agent_config`) for a dispatch. */
export interface ToolNodeConfig {
  /** Config-pinned parameter VALUES merged at dispatch (config wins; never LLM-visible). */
  readonly parameters?: Readonly<Record<string, unknown>>;
  /** Workflow-state → tool-arg wiring (the values are already resolved upstream). */
  readonly inputMapping?: Readonly<Record<string, unknown>>;
  /** Tool-result → workflow-state wiring (key paths). Applied to the FULL result. */
  readonly outputMapping?: Readonly<Record<string, string>>;
}

/** A handle's durable metadata + its authz scopes, for the `read_media` policy (1.AF/D12, ADR-0044 §1). */
export interface MediaHandleInfo {
  readonly mimeType: string;
  /** The durable byteLength (`media_objects`) the engine's `Range` math is bounded against. */
  readonly byteLength: number;
  /** The handle's `session`/`workspace` `media_references` rows — the set `read_media` checks membership in. */
  readonly allowedScopes: readonly Scope[];
}

/**
 * The engine media-read delegate for `read_media` (1.AF/D12, ADR-0044 §1) — the policy/mechanism bridge,
 * **NOT** a {@link ToolHost} capability arm: it reuses the `ExecutionHost.mediaStore` port + the
 * `media_references` store (mirroring the {@link ToolDispatchContext.invokeAgent} delegate). `describe`
 * returns the handle's durable metadata + authz scopes (the engine checks scope-set membership + the
 * `Range`); `readRange` is the host byte-delivery mechanism (D13) returning an in-flight **base64**
 * `MediaSource` (the host encodes — the engine-pure tool never touches raw bytes).
 */
export interface MediaReadAccess {
  describe(handle: string, signal?: AbortSignalLike): Promise<MediaHandleInfo | undefined>;
  readRange(handle: string, range: ByteRange, signal?: AbortSignalLike): Promise<MediaSource>;
}

/* ------------------------------------------------------------------------------------------------ *
 * Per-tool approval (ADR-0057 EA3) — the interactive consent seam. A host-injected hook (the same
 * dependency-inversion pattern as `ToolHost`, so ADR-0037's tool-execution boundary holds: the engine
 * defines the interface + the invocation point, the host supplies the implementation). The registry
 * consults it BETWEEN the `enforcePolicy` guardrail floor and the host side-effect, for a GOVERNED-class
 * dispatch only (fs_write / a model-controlled process / egress — never a read-only fs / `git_status` /
 * clipboard tool). The engine stays mode-agnostic: the host's hook owns the mode policy (ask / plan /
 * accept-edits / auto), the once/always cache, the protected-paths rule, and emitting
 * `agent:approval_requested`; the engine only asks "may this governed action proceed?" and honors it.
 * ------------------------------------------------------------------------------------------------ */

/** A secret-free, display-only preview of the side effect the user is approving (ADR-0057). */
export interface ToolActionPreview {
  /** fs_write — the resolved target path. */
  readonly path?: string;
  /** process — the resolved command string (what `allowedCommands` matched). */
  readonly command?: string;
  /** egress — the target host ONLY (never the full URL / query string, never a secret). */
  readonly host?: string;
}

/** What the engine asks the host to confirm — the governed action class + a secret-free preview. */
export interface ToolApprovalRequest {
  readonly toolId: ToolId;
  readonly action: ToolActionClass;
  readonly preview: ToolActionPreview;
}

/** The host's verdict. `reject.reason` is an optional, secret-free, display-safe label echoed in the error. */
export type ToolApprovalDecision =
  | { readonly outcome: 'approve' }
  | { readonly outcome: 'reject'; readonly reason?: string };

/**
 * The host-injected interactive consent hook. MUST be secret-free and SHOULD honor the `AbortSignal` (an
 * abort while prompting routes to the engine's cancel path, not a denial). Returns the verdict the registry
 * lowers into its existing control flow (approve ⇒ dispatch; reject ⇒ a fatal `tool_denied`).
 */
export type ConfirmActionHook = (
  request: ToolApprovalRequest,
  signal?: AbortSignalLike,
) => Promise<ToolApprovalDecision>;

/**
 * The per-dispatch approval regime (ADR-0057 EA3). Its PRESENCE on {@link ToolDispatchContext} marks the
 * interactive-approval (chat) path: a governed-class dispatch then REQUIRES a `confirm` decision, and an
 * ABSENT `confirm` is **fail-closed → denied** (a wiring bug can never let a write through). ABSENT on the
 * workflow author-trust path — governed tools proceed under the `enforcePolicy` floor, unchanged.
 */
export interface ToolApprovalContext {
  readonly confirm?: ConfirmActionHook;
}

export interface ToolDispatchContext {
  readonly nodeId: string;
  /** The node's narrowed grant (ADR-0029(b)); a dispatch outside it is refused (registered ≠ authorized). */
  readonly grantedToolIds: ReadonlySet<ToolId>;
  /** The resolved `tool_config`/`agent_config` block — config-only VALUES + the I/O mappings. */
  readonly config: ToolNodeConfig;
  /** The resolved workflow tool policy — `allowedCommands` / `allowedCommandGlobs` / `allowedDomains`. */
  readonly toolPolicy: import('@relavium/shared').ToolPolicy;
  /** The active filesystem scope tier (built-in-tools.md). */
  readonly fsScope: FsScopeTier;
  /** A human-gate decision is present for this dispatch (1.Q) — required by `git_commit`. */
  readonly gateApproved: boolean;
  /**
   * Per-tool approval regime (ADR-0057 EA3). PRESENT ⇒ the interactive-approval (chat) path: a
   * governed-class dispatch (fs_write / a model-controlled process / egress) requires a `confirm` decision,
   * and an absent `confirm` is fail-closed → denied. ABSENT ⇒ the workflow author-trust path, unchanged.
   */
  readonly approval?: ToolApprovalContext;
  /** Names of effective-arg keys that are secret-tainted (ADR-0029(c)) — rejected from non-credential args. */
  readonly secretArgKeys?: ReadonlySet<string>;
  /** Engine delegate for `invoke_agent` — pure orchestration, not a ToolHost I/O capability. */
  readonly invokeAgent?: (nodeId: string, input: unknown) => Promise<unknown>;
  /** The dispatching session's authz scope — `read_media` checks scope-set membership against it (1.AF/D12). */
  readonly requestingScope?: Scope;
  /** Engine delegate for `read_media` byte delivery (1.AF/D12) — reuses `ExecutionHost.mediaStore` + the
   *  `media_references` store; NOT a {@link ToolHost} I/O capability (mirrors {@link invokeAgent}). */
  readonly mediaRead?: MediaReadAccess;
  /** The model-facing result-bounding ceilings. */
  readonly limits?: ToolResultLimits;
  readonly signal?: AbortSignalLike;
}

export interface ToolDef<Args = unknown, Result = unknown> {
  readonly id: ToolId;
  readonly source: ToolSource;
  readonly description: string;
  /**
   * The EXECUTABLE args validator AND the source of truth for the parameter shape (a Zod `parse`).
   * Validates the COMPLETE effective argument set (model + input_mapping + config-only), throwing on a
   * miss. A bare JSON Schema is data, not a validator — it can never gate dispatch.
   */
  parseArgs(raw: unknown): Args;
  /** The LLM-VISIBLE projection lowered by the ToolNormalizer — excludes every `configOnlyParams` entry. */
  readonly llmVisibleParams: JsonSchema;
  /** Names of config-pinned params (values from `ctx.config.parameters`); never LLM-visible. */
  readonly configOnlyParams?: readonly string[];
  readonly policy: ToolPolicyClass;
  /**
   * Tells the registry WHERE this tool's guardrail target lives in the effective args, so the engine
   * enforces the allowlist generically without guessing a field. A `spawnsProcess` tool returns the
   * resolved `command` string (the full string the `allowedCommands` allowlist matches exactly); an
   * `http` egress tool returns the `url`. A pre-approved tool (e.g. `git_status`) returns neither and
   * the generic allowlist check is skipped. Omitted ⇒ no target (e.g. `os` / delegate tools).
   */
  readonly policyTarget?: (args: Args) => PolicyTarget;
  /**
   * Pure dispatcher: validated+merged effective args in, the FULL result out. Side effects ONLY via
   * `host`; never imports `node:*`/`fetch`. Threads `ctx.signal`. Bounding/taint/mapping are applied
   * by the registry AFTER this returns, so the full result reaches workflow state intact.
   */
  dispatch(args: Args, host: ToolHost, ctx: ToolDispatchContext): Promise<Result>;
}

/** What the registry's guardrail check inspects for a tool — a resolved command and/or an outbound URL. */
export interface PolicyTarget {
  /** The resolved command string the `allowedCommands` allowlist matches EXACTLY (ADR-0029(a)). */
  readonly command?: string;
  /** The outbound URL the `allowedDomains` exact-FQDN allowlist + SSRF policy applies to (ADR-0029(d)). */
  readonly url?: string;
  /**
   * The resolved fs target path of a WRITE — the per-tool approval preview shows it (ADR-0057 EA3). NOT a
   * guardrail target (`enforcePolicy` reads only `command`/`url`), so supplying it changes no allowlist
   * behavior; it is the display target for the approval prompt + the `agent:approval_requested` event.
   */
  readonly path?: string;
}

/** The engine-side registry + dispatcher. One instance, shared by both entry points (1.O / 1.V). */
export interface ToolRegistry {
  /** Resolve, validate, guard, dispatch, bound, and taint a tool call. See the lifecycle in tool-registry.md. */
  dispatch(toolCall: ToolCallPart, ctx: ToolDispatchContext): Promise<ToolDispatchOutcome>;
  /** Whether a tool id is registered (exact match). Registered ≠ authorized — the grant is checked per dispatch. */
  has(id: ToolId): boolean;
  /** The registered tool ids (sorted) — used to list available tools in an `UnknownToolError`. */
  list(): readonly ToolId[];
}

export interface CreateToolRegistryOptions {
  readonly tools: readonly ToolDef[];
  readonly host: ToolHost;
}

/** Sanitized event data for the bus's single translation point (ADR-0036); it adds the envelope. */
export interface ToolCallEventData {
  readonly toolId: ToolId;
  /** The LLM-visible args with config-only + secret-tainted keys removed (no secrets). */
  readonly toolInput: Readonly<Record<string, unknown>>;
}
export interface ToolResultEventData {
  readonly toolId: ToolId;
  readonly success: boolean;
  /** A truncated, display-only summary string (distinct from the model-facing bounded result). */
  readonly outputSummary: string;
}

export interface ToolDispatchOutcome {
  /**
   * The value the engine binds to workflow state — the FULL result projected through `output_mapping`
   * (or the full result when no mapping). Never the bounded model-facing preview, so a downstream node
   * gets the real value.
   */
  readonly output: unknown;
  /**
   * The model-facing tool_result content part — BOUNDED and **branded untrusted**: 1.O must
   * {@link Untrusted | unwrap} it to place it in a `user`/`tool` position, never `system`
   * (security-review.md §Prompt-injection). The brand makes the unsafe path unrepresentable.
   */
  readonly toolResult: Untrusted<ToolResultPart>;
  /** Whether the model-facing result was truncated (full output spilled to `outputStore`). */
  readonly truncated: boolean;
  /** Sanitized payloads the bus envelopes into `agent:tool_call` / `agent:tool_result`. */
  readonly events: { readonly call: ToolCallEventData; readonly result: ToolResultEventData };
}
