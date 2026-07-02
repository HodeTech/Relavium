# Tool Registry & the `ToolHost` Seam

- **Status**: Stable ([ADR-0037](../../decisions/0037-engine-tool-execution-boundary.md) is Accepted)
- **Canonical home**: the contract for the engine-side `ToolRegistry` + dispatch in `packages/core` (`@relavium/core`) and the host-injected `ToolHost` capability seam it performs side effects through — workstream **1.T**
- **Related**: [../../decisions/0037-engine-tool-execution-boundary.md](../../decisions/0037-engine-tool-execution-boundary.md) (the decision), [../../decisions/0029-tool-policy-hardening.md](../../decisions/0029-tool-policy-hardening.md) (the guardrails), [built-in-tools.md](built-in-tools.md) (the tool catalog + the concrete result-bounding / config-only-param shapes), [node-types.md](node-types.md) (the `tool_config` / `agent_config` blocks that carry `parameters` / `input_mapping` / `output_mapping`), [mcp-integration.md](mcp-integration.md) (the MCP tool transport, 2.R), [llm-provider-seam.md](llm-provider-seam.md) (the canonical `ToolDef` the `ToolNormalizer` lowers), [../contracts/sse-event-schema.md](../contracts/sse-event-schema.md#error-code-taxonomy) (`agent:tool_call` / `agent:tool_result` payloads + the `tool_denied` / `tool_failed` codes), [../../standards/security-review.md](../../standards/security-review.md#prompt-injection-posture) (the untrusted-data + SSRF + secret rules), [../../standards/error-handling.md](../../standards/error-handling.md) (the retryable/fatal mapping), [../../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md](../../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md) (the sibling `ExecutionHost` seam + the single event-translation point), [../../decisions/0031-llm-seam-shape-amendment-multimodal-io.md](../../decisions/0031-llm-seam-shape-amendment-multimodal-io.md) (durable media handles)

This page is the **one canonical home** for the tool-execution *contract* — how the engine registers a tool, resolves it, assembles and validates its effective arguments, enforces [ADR-0029](../../decisions/0029-tool-policy-hardening.md)'s guardrails, performs the side effect through the host, bounds the model-facing result, and marks it untrusted. The *why* (the engine↔host boundary, the policy/mechanism split) lives in [ADR-0037](../../decisions/0037-engine-tool-execution-boundary.md); the *tool catalog* (the thirteen built-ins, their return shapes, FS scope tiers, and the concrete result-bounding thresholds) lives in [built-in-tools.md](built-in-tools.md). This file is the dry reference its consumers (the 1.T registry, the 1.O `AgentRunner`, the 1.V `AgentSession`, each surface's `ToolHost` wiring) bind to. Where any other doc names a tool-dispatch rule it links here and never restates it.

> **The one rule that shapes everything here.** `@relavium/core` has **zero platform-specific imports** (CLAUDE.md rule 5). Twelve of the thirteen built-in tools need filesystem / process / network / OS / media-store I/O the engine therefore cannot perform (only `invoke_agent` is engine-internal). The engine owns **policy + dispatch** (pure); the **mechanism** is injected as a `ToolHost`, the same purity seam as `ResolverCapabilities.readFile` (1.L2) and the injected HTTP transport ([ADR-0018](../../decisions/0018-desktop-execution-and-rust-egress.md)). The TypeScript shapes below are the canonical interface the implementation mirrors.

## The `ToolDef` — a registered tool

A tool is registered as a `ToolDef`: its identity, an **executable** args validator (not just a JSON Schema), its guardrail/capability classification, and a pure `dispatch` that runs against the injected host.

```ts
/** Exact-match registry key. Built-ins use the fixed catalog ids; MCP ToolDefs are host-side assembled (2.R, ADR-0052). */
type ToolId = string; // e.g. 'read_file' | 'run_command' | 'mcp_{server}_{tool}' | 'plugin_{pkg}_{tool}'

interface ToolDef<Args = unknown, Result = unknown> {
  readonly id: ToolId;
  readonly source: 'builtin' | 'mcp' | 'plugin';
  readonly description: string;

  /**
   * The EXECUTABLE args validator AND the source of truth for the parameter shape — a Zod schema's
   * `parse` (Zod is already a `@relavium/core` dependency; no new dep). It validates the COMPLETE
   * effective argument set (model + `input_mapping` + config-only), not just model args, and throws
   * `ToolArgsInvalidError` on a miss. A bare `JSONSchema7` is data, not a validator — it cannot gate
   * dispatch, so it is never the validation mechanism.
   */
  parseArgs(raw: unknown): Args;

  /**
   * The LLM-VISIBLE projection of the parameter shape — and ONLY this — is what the `ToolNormalizer`
   * (1.E) lowers to each provider's wire shape; a model can supply only these. Derived from the
   * LLM-visible subset of the args schema (an in-house emitter or a hand-maintained projection),
   * excluding every `configOnlyParams` entry. Typed `JsonSchema` (= `Readonly<Record<string, unknown>>`,
   * exported by `@relavium/core`) — opaque data the engine carries, NOT the `@types/json-schema`
   * `JSONSchema7` type (the engine never imports it).
   */
  readonly llmVisibleParams: JsonSchema;

  /**
   * Names of CONFIG-PINNED parameters: their VALUES come from the node's `tool_config` / `agent_config`
   * block ([node-types.md](node-types.md)) via `ctx.config`, are merged at dispatch (config wins), and
   * NEVER appear in `llmVisibleParams` — a model argument can never override one (a pinned root path /
   * base URL / timeout the model can't touch).
   */
  readonly configOnlyParams?: readonly string[];

  readonly policy: ToolPolicyClass;

  /**
   * Where this tool's guardrail target lives in the effective args, so the registry enforces the
   * allowlist generically: a `spawnsProcess` tool returns the resolved `command` string the
   * `allowedCommands` allowlist matches; an `http` egress tool returns the `url`. Omitted ⇒ no target
   * (the generic allowlist check is skipped — e.g. a pre-approved `git_status` or an `os`/delegate tool).
   * SECURITY: a `spawnsProcess` / `egress:'http'` tool that omits this has its allowlist check silently
   * skipped (fail-open) — supply it, or pin the model-controlled args as config-only.
   */
  readonly policyTarget?: (args: Args) => PolicyTarget; // { command?: string; url?: string; path?: string }

  /**
   * Pure dispatcher: validated+merged effective args in, the FULL result out. Performs side effects
   * ONLY via `host`; never imports `node:*`/`fetch`. Threads `ctx.signal` (cooperative cancel). The
   * model-facing bounding (built-in-tools.md) is applied by the pipeline AFTER `output_mapping`, never
   * inside `dispatch`, so the full result reaches workflow state intact.
   */
  dispatch(args: Args, host: ToolHost, ctx: ToolDispatchContext): Promise<Result>;
}

interface ToolPolicyClass {
  /** Needs the FS scope tier — `read_file`, `write_file`, `list_directory`. */
  readonly fsScoped: boolean;
  /**
   * The fs operation is a WRITE (`write_file`), not a read. `fsScoped` alone is `true` for reads AND
   * writes alike, so it cannot tell `write_file` from `read_file`; this additive discriminator is the one
   * the per-tool approval needs to gate writes ([ADR-0057](../../decisions/0057-cli-chat-modes-and-per-tool-approval.md) EA3)
   * and the `fs-write` `ActionClass` [ADR-0041](../../decisions/0041-external-action-governance-seam.md) proposes —
   * landed once, credited to both. Absent/false ⇒ a read-only fs tool (never governed by approval).
   */
  readonly fsWrite?: boolean;
  /** Spawns an OS process under the `allowedCommands` allowlist — `run_command`, `git_*`. */
  readonly spawnsProcess: boolean;
  /** Outbound egress — DISCRIMINATED by kind, because the three paths have different policies. */
  readonly egress?: 'http' | 'search' | 'mcp';
  /** An OS-integration action — `read_clipboard` (an un-jailed read of ambient, secret-bearing OS state) /
   *  `notify`. A governed action class (ADR-0057 §security review): gated by the interactive approval floor,
   *  never merely the advertise-filter. Absent/false ⇒ not an os action. */
  readonly os?: boolean;
  /** Requires a human-gate approval in an automated workflow before it may execute — `git_commit`. */
  readonly requiresGateApproval: boolean;
}
```

The canonical `ToolDef` that crosses the `@relavium/llm` seam to a provider is the leaner
`{ name, description?, parameters }` shape ([llm-provider-seam.md](llm-provider-seam.md)); the
`ToolNormalizer` (1.E) lowers `id` → `name` and `llmVisibleParams` → `parameters`. **`configOnlyParams`
never crosses the seam** — that is the point.

## The `ToolHost` capability seam

The host (CLI / VS Code Node host, desktop Rust commands, Phase-2 cloud worker) injects a `ToolHost`.
Every method is the engine's only path to a side effect. Each capability is **optional**: a tool whose
capability is absent fails with a typed `ToolUnavailableError` (never a crash, never a platform import
sneaking into the engine) — exactly as an absent `ResolverCapabilities.readFile` fails the `read_file`
interpolation filter.

```ts
interface ToolHost {
  readonly fs?: FsCapability;            // file read/write/list, jailed to the active FS scope tier
  readonly process?: ProcessCapability;  // process spawn — host-resolved executable + base env; shell:false
  readonly egress?: EgressCapability;    // outbound HTTPS — shared SSRF primitive; host-resolved credential ref
  readonly os?: OsCapability;            // clipboard / native notification
  readonly mcp?: McpCapability;          // MCP client transport (ADR-0034; wired at 2.R)
  readonly outputStore?: ToolOutputStore; // run-scoped bounded spill for over-ceiling results (below)
}

interface ProcessCapability {
  /**
   * Spawn an already-allowlist-checked command with **`shell: false`**. The HOST resolves the executable
   * (platform PATH lookup — `npm`/`git` are unresolvable without it) and supplies the platform-minimal
   * base environment, then merges ONLY the engine-declared extra vars under an audited allowlist —
   * **never** the full ambient `process.env`. The engine cannot build a platform base env (it is
   * platform-free), so env construction is the host's job; the engine supplies the *policy* (the
   * allowlist-checked command + the declared vars) and the host enforces the FS scope tier + a
   * CPU/mem/time budget. stdout/stderr/exit are untrusted.
   */
  spawn(command: string, args: readonly string[], declaredEnv: Readonly<Record<string, string>>,
        opts: SpawnOpts, signal?: AbortSignalLike): Promise<ProcessResult>;
}

interface EgressCapability {
  /**
   * Perform an outbound HTTPS request the engine has ALREADY policy-checked (per egress kind, below).
   * The host implementation MUST run the one shared SSRF range-primitive (block
   * private/loopback/link-local/metadata/CGNAT; DNS-resolve + connect-by-validated-IP +
   * per-hop-redirect-revalidate — security-review.md). A `credentialRef` is an OPAQUE secret-store
   * reference (the `web_search` provider key, an auth header value) the host resolves and attaches
   * INSIDE its trusted boundary — the ADR-0006/0018 key-reference pattern, so the raw secret never
   * enters the engine / WebView. v1.0 bounding is applied post-hoc by the registry over the in-memory
   * `EgressResponse.body`; a future `maxBytes` on `EgressRequest` (with 1.AE) enables source-side truncation.
   * Ships feature-flag-OFF until the shared primitive lands at 1.AE.
   */
  fetch(request: EgressRequest, signal?: AbortSignalLike): Promise<EgressResponse>;
  // EgressRequest = { method, url, headers, body?, credentialRef?: string }
}

interface ToolOutputStore {
  /** Spill an over-ceiling result to a run-scoped store; returns a handle + byte length, reclaimed on the
   *  run's terminal event (ADR-0036). A genuinely streamed huge source is bounded by its host capability
   *  at the boundary (returning an already-bounded payload); this spills the in-memory result a
   *  `dispatch` returned, so the engine hands the model a preview + the spill handle, not the full bytes. */
  spill(text: string, limits: ToolResultLimits, signal?: AbortSignalLike): Promise<SpilledResult>;
}
```

> **Sibling seams, one host.** `ToolHost` is a distinct seam from [ADR-0036](../../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md)'s `ExecutionHost` (persistence / clock / transport) and from 1.L2's `ResolverCapabilities` (the `read_file` filter). The host wires all of them; in Phase-2 cloud the relocated `ExecutionHost` provides the `ToolHost`. None is folded into another — each stays minimal and auditable.

## Resolution & the dispatch lifecycle

`registry.dispatch(toolCall, ctx)` runs a fixed, pure pipeline. **Security order matters:** the
effective argument set is assembled *before* the guardrail checks, so a policy never runs on
half-populated args (a `tool` node has no model args — every value arrives via `input_mapping` — so a
policy that ran before assembly would inspect nothing and a command allowlist would be bypassed). The
host is touched once, in the middle.

0. **Reject a provider-executed call.** If `toolCall.providerExecuted === true`, reject immediately with `ToolPolicyError(reason: 'provider_executed')` **before** id resolution — the engine never dispatches a provider-executed `tool_call` (content.ts; ADR-0030/0029).
1. **Resolve by exact id, then check the grant.** Look up `toolCall.name` by **exact match** — unknown / misspelled → `UnknownToolError` listing the available ids (**never** fuzzy / nearest-name, [ADR-0029](../../decisions/0029-tool-policy-hardening.md)). Then verify the id is in `ctx.grantedToolIds` (the node's narrowed grant, 0029(b)); a registered-but-not-granted tool (e.g. a hallucinated / injected `tool_call`) → `ToolPolicyError`. The registry holding a `ToolDef` is **not** authorization to dispatch it.
2. **Assemble the effective argument set.** Start from the model-supplied args (for an agent tool-call) and/or `ctx.config.input_mapping` (for a `tool` node, where there are no model args), apply `input_mapping`, then merge `configOnlyParams` **last (config wins)**.
3. **Validate the COMPLETE effective set** via `tool.parseArgs` **and** the secret-taint check — `input_mapping`/config-derived values are validated identically to model args; a secret-tainted value reaching a non-credential arg is rejected (0029(c)). A miss → `ToolArgsInvalidError`.
4. **Enforce the guardrail policy on the EFFECTIVE args** (the resolved command / URL is now the real value): exact `allowedCommands` (+ opt-in `allowedCommandGlobs`, deny-all-empty); per egress kind (table below); `git_commit` refused unless `ctx.gateApproved`. A denial → `ToolPolicyError` → **before any host call**.
4b. **Per-tool approval — the interactive consent gate ([ADR-0057](../../decisions/0057-cli-chat-modes-and-per-tool-approval.md) EA3).** Runs only when `ctx.approval` is present (the **interactive-approval regime** — the chat path; absent ⇒ the workflow author-trust path, unchanged) and the dispatch is a **governed class**: `fsWrite`, an `egress` of any kind, an `os` action (`read_clipboard` / `notify` — the clipboard is an un-jailed exfiltration sink), or a `spawnsProcess` with a model-controlled `command` target (so the pre-approved `git_status`, which exposes no command, is **not** gated — matching step 4). The engine consults the host-injected `ctx.approval.confirm` hook with a **secret-free preview** (resolved path / command / host — never a full URL/query, never a secret) and, before prompting, the host emits `agent:approval_requested`. **Fail-closed:** under an active regime a governed dispatch *requires* a decision — an **absent `confirm` hook ⇒ denied** (`ToolDeniedByUserError`, reason `no_approval_hook`), never silently allowed, so a wiring bug cannot let `ask` mode write. A reject ⇒ `ToolDeniedByUserError` (reason `user_rejected`) carrying the existing **`tool_denied`** code (fatal, never retried); an abort while prompting routes to the **cancellation** path (cancel precedence). The host's `confirm` owns the mode policy (ask / plan / accept-edits / auto), the once/always cache, and the protected-paths rule — the engine stays mode-agnostic. This composes *after* step 4 and, when an `ActionGuard` ([action-guard-seam.md](action-guard-seam.md)) is also injected, *alongside* it (the org governor's `decide`/`commit` and the user's `confirm` each only further restrict).
5. **Call the host capability** (the single side effect), threading `ctx.signal`. Absent capability → `ToolUnavailableError`; an `AbortSignal`-origin failure → the **cancellation** path (`cancelled`, never `tool_failed` — preserves ADR-0036 cancel precedence); any other host throw → `ToolExecutionError`. A host capability MAY itself throw a typed `ToolDispatchError` subclass for a **deterministic host-side denial** (e.g. the CLI `fs` arm throwing a `tool_denied` when a path escapes the FS scope tier, or `ToolUnavailableError` for a read-only fail-close) — the registry passes any `ToolDispatchError` through **verbatim**, exactly as it does an engine-side `ToolPolicyError`, so such a denial is fatal (never burns the node-retry budget); only a *raw* host throw becomes the retryable `ToolExecutionError`.
6. **Apply `output_mapping` to the FULL result** → workflow state gets the real value, never the bounded preview.
7. **Bound the model-facing result** (§Result bounding and spill-to-file) from the result via `ctx.limits` + the host `outputStore` — over the ceiling the model gets a preview + a spill handle, the full result still flows to `output_mapping`.
8. **Mark the result untrusted** (§Untrusted-data taint) and hand the structured `tool_call` / `tool_result` data + its taint/secret markers to the bus's single translation point ([ADR-0036](../../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md)) for `agent:tool_call` / `agent:tool_result` emission.

> **Loop-correctable vs terminal.** `UnknownToolError` and `ToolArgsInvalidError` are **thrown** by the registry; the agent loop (1.O) **catches** them and synthesizes a correctable `isError` `tool_result` (from the secret-free `error.message`) so the model can fix its call, within a **bounded correction budget** it owns — escalating to a node `ErrorCode` only when that budget is spent. A `ToolPolicyError` — and, identically, a `ToolDeniedByUserError` (the per-tool approval denial, ADR-0057) — is structurally fatal (`tool_denied`) and **never** fed back as a correctable result (re-asking a denied tool just burns budget). See [agent-runner.md §the failure ladder](agent-runner.md). A `ToolCancelledError` maps to `cancelled` ahead of all other classifications (cancel wins).

```ts
interface ToolDispatchContext {
  readonly nodeId: string;
  readonly grantedToolIds: ReadonlySet<ToolId>;  // the node's narrowed grant (0029(b)); dispatch refused outside it
  readonly config: ToolNodeConfig;        // resolved tool_config/agent_config block: configOnly VALUES + input/output_mapping (node-types.md)
  readonly toolPolicy: ToolPolicy;         // resolved allowedCommands/-Globs/-Domains (@relavium/shared)
  readonly fsScope: FsScopeTier;           // 'sandboxed' | 'project' | 'full' (the @relavium/shared source of truth)
  readonly gateApproved: boolean;          // a human-gate decision is present for this dispatch (1.Q)
  // Per-tool approval regime (ADR-0057 EA3). PRESENT ⇒ the interactive-approval (chat) path: a governed-class
  // dispatch requires `approval.confirm`'s decision, and an absent confirm is fail-closed → denied. ABSENT ⇒
  // the workflow author-trust path (unchanged). `confirm` is the host-injected ConfirmActionHook (the engine
  // defines the interface + the invocation point, the host supplies the implementation — ADR-0037-clean).
  readonly approval?: { readonly confirm?: ConfirmActionHook };
  // The effective-arg keys whose resolved value is secret-tainted (ADR-0029(c)); the registry rejects
  // any present one from tool args (re-applying the parse-time taint gate on the effective set). 1.O/1.V
  // produces this; absent ⇒ no taint check (no producer yet).
  readonly secretArgKeys?: ReadonlySet<string>;
  readonly invokeAgent?: (nodeId: string, input: unknown) => Promise<unknown>; // engine delegate (invoke_agent); absent ⇒ ToolUnavailableError
  readonly limits?: ToolResultLimits;      // the result-bounding ceilings; absent ⇒ DEFAULT_TOOL_RESULT_LIMITS
  readonly signal?: AbortSignalLike;
}
```

`ctx.config` is populated by the `AgentRunner` (1.O) / DAG builder (1.M) from the node's resolved
config block ([node-types.md](node-types.md) `tool_config` / `agent_config`) — that is where the
config-only VALUES and the `input_mapping` / `output_mapping` come from. `invokeAgent` is an
**engine-provided delegate**, not a `ToolHost` capability — `invoke_agent` is pure orchestration
(dispatch another node by id), no platform I/O, no full router selection this phase.

### The per-tool approval seam (`ConfirmActionHook`, ADR-0057 EA3)

`ctx.approval.confirm` is the host-injected interactive-consent hook the dispatch lifecycle's step 4b
consults — the same dependency-inversion pattern as the `ToolHost` (the engine defines the interface +
the invocation point; the host supplies the implementation, so [ADR-0037](../../decisions/0037-engine-tool-execution-boundary.md)'s
tool-execution boundary holds). The host implementation owns the mode policy (ask / plan / accept-edits /
auto), the once/always cache, the protected-paths rule, and emitting `agent:approval_requested` — the
engine stays mode-agnostic and only asks "may this governed action proceed?" then honors the verdict. The
preview is **secret-free, display-only**.

```ts
/** Present on `ctx.approval` ⇒ the interactive-approval regime is active (the chat path). Absent ⇒ the
 *  workflow author-trust path (governed tools proceed under the step-4 floor, unchanged). */
interface ToolApprovalContext {
  readonly confirm?: ConfirmActionHook; // ABSENT under an active regime ⇒ fail-closed deny (no_approval_hook)
}

type ConfirmActionHook = (
  request: ToolApprovalRequest,
  signal?: AbortSignalLike, // SHOULD be honored — an abort while prompting routes to the engine's cancel path
) => Promise<ToolApprovalDecision>;

interface ToolApprovalRequest {
  readonly toolId: ToolId;
  readonly action: ToolActionClass; // 'fs_write' | 'process' | 'egress' | 'os' (@relavium/shared TOOL_ACTION_CLASSES)
  readonly preview: ToolActionPreview;
}

/** Secret-free, display-only — never a full URL/query, never a secret. */
interface ToolActionPreview {
  readonly path?: string;    // fs_write — the resolved target path
  readonly command?: string; // process — the resolved command string
  readonly host?: string;    // egress — the target host ONLY
}

type ToolApprovalDecision =
  | { readonly outcome: 'approve' }
  | { readonly outcome: 'reject'; readonly reason?: string }; // a secret-free, display-safe label
```

A reject ⇒ `ToolDeniedByUserError` (reason `user_rejected`); a hook that throws a non-abort error ⇒ the same
fatal `tool_denied` (reason `approval_error`, fail-closed — consent could not be obtained, never the
retryable `tool_failed` a *host-capability* throw gets); an absent hook under an active regime ⇒
`tool_denied` (reason `no_approval_hook`). All three carry the existing non-retryable `tool_denied`
`ErrorCode`. The action class is derived from `ToolPolicyClass` (§The `ToolDef`): `fsWrite` ⇒ `fs_write`,
any `egress` ⇒ `egress`, a `spawnsProcess` **with a model-controlled `command` target** ⇒ `process`
(so the pre-approved `git_status`, which exposes no command, is **not** gated), and `os` ⇒ `os`
(`read_clipboard` — an un-jailed exfiltration sink — / `notify`).

## Guardrail enforcement (policy = engine-pure; mechanism = host)

The canonical guardrail home is [security-review.md §Sandbox-and-tool-policy](../../standards/security-review.md#sandbox-and-tool-policy-run_command-node-tools-secret-inputs) and [ADR-0029](../../decisions/0029-tool-policy-hardening.md); this table shows **where each half runs** — every engine-pure check is on the **effective** args (step 4).

| Guardrail | Engine-pure check (the policy) | Host mechanism |
|-----------|-------------------------------|----------------|
| Node `tools:` grant | `id ∈ ctx.grantedToolIds` (exact); registered ≠ granted | — |
| `run_command` allowlist | resolved command matched **exactly** vs `allowedCommands`; opt-in glob via `allowedCommandGlobs`; **empty/absent ⇒ deny-all** | `process.spawn`, `shell:false`, FS scope tier + CPU/mem/time budget |
| Subprocess environment | engine supplies the **declared** vars + the policy | host resolves the executable + the platform-minimal base env, merges only allowlisted declared vars — **never** ambient `process.env` |
| `http_request` (egress `http`) | **HTTPS-only**, **exact-FQDN** `allowedDomains`, **empty/absent ⇒ deny-all**; an `input_mapping`-derived URL runs the same check (0029(d)) | `egress.fetch` runs the shared SSRF primitive + connect-pinning (1.AE) |
| `web_search` (egress `search`) | untrusted-data-validated **query** (transits a query, **not** an FQDN allowlist — [security-review.md §Prompt-injection](../../standards/security-review.md#prompt-injection-posture)) | `egress.fetch` to the configured provider; key via host-resolved `credentialRef` |
| `mcp_call` (egress `mcp`) | configured MCP **server** URL (not `allowedDomains`); secrets injected host-side | `mcp` transport runs the same SSRF primitive (0029(d); 2.R) |
| `git_commit` | refused unless `ctx.gateApproved` (human-gate, 1.Q) in an automated workflow | `process.spawn` |
| node `tools:` narrowing | already parser-enforced (narrow-only, 0029(b)/[ADR-0023](../../decisions/0023-strict-authored-yaml-validation.md)) | — |
| secret args | `secret`-typed values reach only credential/header fields, rejected at parse from tool text (transitive taint, 0029(c)); re-checked on the **top-level** effective-arg keys (step 3) — by contract the 1.O/1.V taint producer flattens a tainted *nested* path to a top-level deny before it reaches `secretArgKeys`; the actual secret never travels as an arg value (it is a host-resolved `credentialRef`) | host attaches a resolved `credentialRef` inside its trust boundary |
| FS scope tier | tool flagged `fsScoped` | `fs.*` jails to the tier + rejects path traversal |

## Result bounding and spill-to-file

The result a tool hands **back to the model** (which re-enters the next `LlmRequest`) is bounded —
distinct from the *event* `outputSummary`, which is truncated separately at the bus translation point
([ADR-0036](../../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md)). Three rules:

- **Bounding is model-facing only.** `output_mapping` runs on the **full** result (step 6) so workflow state holds the real value; only the model-facing `tool_result` is replaced by a **bounded preview + an explicit truncation marker + the spill path** (step 7).
- **The full result is spilled to the host `outputStore`; the model gets a preview + handle.** *v1.0 caveat:* the bound is over the **in-memory** result the `dispatch` returns — the seam's `FileRead.content` / `EgressResponse.body` / `ProcessResult.stdout` are `string`, so the engine holds the full result transiently before spilling. The **stream-and-incrementally-spill-at-the-boundary** guarantee (the engine never holding the full bytes) is a **host-capability obligation** — push a `maxBytes` into `FsReadOpts` / `EgressRequest` so the host truncates at the source — landed with the first genuinely-streamed large source (the residual engine-memory exposure until then is bounded by the FS scope tier + the host process budget; egress is gated to 1.AE). The model-facing context-window protection (the stated purpose) holds today regardless. The output store is its **own** `ToolHost` capability, so bounding does not depend on the optional `fs` capability (a `web_search` / MCP host with no `fs` still bounds).
- **Reclaimed at the terminal event.** Spilled output is run-scoped and swept when the run reaches a terminal event (the ADR-0036 terminal-state sweep), like other run-scoped artifacts.

The ceiling is a **byte/line** bound (no token count — that needs a provider-specific tokenizer, which would break engine purity); concrete defaults and the marker shape are canonical in
[built-in-tools.md](built-in-tools.md#tool-result-bounding). `ToolResultLimits` carries them into `ctx`.

## Untrusted-data taint (1.T marks; 1.O places)

Every tool result is wrapped in the engine's branded untrusted marker at the registry boundary (the
same compile-time technique as the 0029(c) secret taint). The 1.O message-assembly layer can then place
a tainted value **only** in a `user` / `tool` position, **never** `system` and never string-concatenated
into an instruction template — the type makes the unsafe path unrepresentable rather than relying on
per-call-site discipline ([security-review.md §Prompt-injection](../../standards/security-review.md#prompt-injection-posture), binding on 1.T/1.O/1.V). 1.T owns the **marking**; 1.O owns the **placement**. This also covers a value that flowed through 1.L2's `resolveTemplate` (which drops provenance), per the 1.O acceptance criteria.

## Built-in tool → capability map

| Tool | Capability / delegate | Guardrail |
|------|----------------------|-----------|
| `read_file` / `write_file` / `list_directory` | `host.fs` | FS scope tier (binary/media ⇒ **durable handle**, not inline base64 — below) |
| `run_command` | `host.process` | exact `allowedCommands` + host-resolved executable + declared env, `shell:false` |
| `git_status` | `host.process` | pre-approved git allowlist |
| `git_commit` | `host.process` | **human-gate approval required** |
| `http_request` | `host.egress` (`http`) | HTTPS-only + exact-FQDN `allowedDomains` + SSRF (1.AE-gated) |
| `web_search` | `host.egress` (`search`) | provider key via host-resolved `credentialRef`; untrusted query |
| `read_clipboard` / `notify` | `host.os` | — |
| `mcp_call` | `host.mcp` | server URL runs the same SSRF primitive (0029(d); 2.R) |
| `invoke_agent` | `ctx.invokeAgent` (engine delegate) | pure orchestration — no `ToolHost` I/O |

**Binary / media results.** A tool returning binary or media content (a `read_file` on a non-text file,
a media `http_request` body) returns a **durable media handle** (`tool_result.media`,
[ADR-0031](../../decisions/0031-llm-seam-shape-amendment-multimodal-io.md)) — **never** inline base64 in
`tool_result.result`, which the ADR-0031 backstop rejects. The host writes the bytes to its media store
and returns the handle (the desktop CAS path of [ADR-0032](../../decisions/0032-desktop-rust-media-de-inline-amends-0018.md)); this threads through the media sub-spine (1.AF) and is gated until it lands.

## Error taxonomy

All typed, narrowed on a discriminant, **secret-free** (names a tool id / field, never an arg value, a
resolved path, or a host stack — [error-handling.md](../../standards/error-handling.md)). The
retryable/fatal split is owned by [error-handling.md](../../standards/error-handling.md) and the closed
codes by [sse-event-schema.md](../contracts/sse-event-schema.md#error-code-taxonomy):

| Error | When | Run `ErrorCode` | Class |
|-------|------|-----------------|-------|
| `UnknownToolError` | id not an exact match | `tool_failed` | fatal (loop-correctable first) |
| `ToolPolicyError` | a guardrail / grant denial — `not_granted`, `provider_executed`, `command_not_allowed`, `domain_not_allowed`, `insecure_url`, `gate_required`, `media_scope_denied` (the full `ToolPolicyDenyReason` union; `media_scope_denied` is `read_media`'s scope-set denial, [ADR-0044](../../decisions/0044-media-access-governance-read-media-save-to-cost.md) §1) | `tool_denied` | **fatal** (never retried) |
| `ToolDeniedByUserError` | an interactive **per-tool approval** denial ([ADR-0057](../../decisions/0057-cli-chat-modes-and-per-tool-approval.md) EA3) — `user_rejected` (rejected by the user / mode policy), `no_approval_hook` (fail-closed: a governed dispatch under an active regime with no confirm hook wired), `approval_error` (fail-closed: the hook threw a non-abort error, so consent could not be obtained) | `tool_denied` | **fatal** (never retried; not loop-correctable — re-asking re-prompts/re-denies, like `ToolPolicyError`) |
| `ToolArgsInvalidError` | effective args fail `parseArgs` / secret-taint | `validation` | fatal (loop-correctable first) |
| `ToolUnavailableError` | the required `ToolHost` capability is absent (host/config gap, not the model's fault) | `tool_unavailable` | **fatal** (names the tool + the unwired arm actionably — never a bare `internal`; EA1, [ADR-0055](../../decisions/0055-cli-host-capability-seam-tool-environment-factory.md)) |
| `ToolExecutionError` | the host capability threw a non-cancel error (cause kept off the message, for logs) | `tool_failed` | retryable (node budget) |
| *(AbortSignal abort)* | the run was cancelled mid-tool | `cancelled` | fatal (cancel path, not `tool_failed`) |

## Instantiation

```ts
// Engine-pure: register the tools, inject one host. Both entry points share one instance.
const registry = createToolRegistry({
  tools: BUILTIN_TOOLS,   // the ToolDef catalog (built-in-tools.md); MCP ToolDefs are host-side assembled (2.R, ADR-0052)
  host: toolHost,         // the surface's ToolHost (Node fs/process/fetch; desktop Rust commands)
});
// Per dispatch, the node's grant + resolved config gate the call (ctx.grantedToolIds / ctx.config):
const result = await registry.dispatch(toolCall, ctx);
```

`createToolRegistry` performs **no** I/O and reads **no** ambient state — a stub `ToolHost` makes the
whole registry unit-testable with zero real side effects (the engine coverage bar applies). The registry
holds every registered `ToolDef`, but a dispatch is authorized only by `ctx.grantedToolIds`, so adding a
tool to the catalog never widens what a given node may call. An MCP or media tool is an additive
`ToolDef` + `ToolHost` capability later (2.R / 1.AF), not a shape change here.
