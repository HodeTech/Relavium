# The `ActionGuard` Seam — external action-governance

- **Status**: Draft ([ADR-0041](../../decisions/0041-external-action-governance-seam.md) is Proposed; this reference lands only if/when 0041 is Accepted)
- **Canonical home**: the contract for the **optional, host-injected `ActionGuard`** that an external action-governance control plane (reference implementation: **Provna**) plugs into at the side-effecting tool boundary — the verdict union, the `ActionIntent` payload, the decide/commit/compensate lifecycle, and the engine-opaque receipt/compensation handles
- **Related**: [../../decisions/0041-external-action-governance-seam.md](../../decisions/0041-external-action-governance-seam.md) (the decision), [tool-registry.md](tool-registry.md) (the `ToolHost` seam + the dispatch lifecycle this composes into), [../../decisions/0037-engine-tool-execution-boundary.md](../../decisions/0037-engine-tool-execution-boundary.md) (the policy/mechanism split), [../../decisions/0029-tool-policy-hardening.md](../../decisions/0029-tool-policy-hardening.md) (the always-on guardrails that run first), [../../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md](../../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md) (the durable suspend/resume the approval verdict reuses), [../../decisions/0039-same-provider-reasoning-replay.md](../../decisions/0039-same-provider-reasoning-replay.md) (the side-effect journaling precedent), [../contracts/sse-event-schema.md](../contracts/sse-event-schema.md#error-code-taxonomy) (the `tool_denied` code an `ActionDecision` of kind `block` maps to), [../../standards/security-review.md](../../standards/security-review.md#prompt-injection-posture) (the untrusted-data taint this consumes), [../../product-constraints.md](../../product-constraints.md) (the local-first, no-cloud-dependency constraint the off-by-default rule preserves)

This page is the **one canonical home** for the `ActionGuard` *contract* — the typed port the engine consults, what the engine passes it, the verdict it returns, and how the registry composes it into the [tool-registry.md](tool-registry.md) dispatch lifecycle. The *why* (the integration boundary for an external governor, the constraints it must not break) lives in [ADR-0041](../../decisions/0041-external-action-governance-seam.md). This file is the dry reference its consumers (the 1.T registry, each surface's host wiring, the external governor's adapter) bind to. Where any other doc names an `ActionGuard` rule it links here and never restates it.

> **The two rules that shape everything here.** **(1) Off by default.** The `ActionGuard` is an **optional** host capability; absent (the default on every surface), the registry calls the `ToolHost` mechanism **directly** — no external call, behavior byte-identical to today, the [product-constraints.md](../../product-constraints.md) local-first / zero-egress guarantee untouched. It is an enterprise opt-in, the [ADR-0012](../../decisions/0012-managed-inference-dual-mode.md) posture applied to governance. **(2) Engine owns the seam, host owns the mechanism.** `@relavium/core` defines the `ActionGuard` *interface* and the *invocation point* (pure); calling the external governor is network/process I/O, so the implementation is **host-injected** — the same purity seam as the `ToolHost` ([ADR-0037](../../decisions/0037-engine-tool-execution-boundary.md)) and the Rust egress ([ADR-0018](../../decisions/0018-desktop-execution-and-rust-egress.md)). No external-governor SDK type crosses the seam (the `LLMProvider` discipline). The TypeScript shapes below are the canonical interface the implementation mirrors.

## The `ActionGuard` seam

A two-phase **decide → commit** protocol, plus an out-of-band **compensate**. The engine *decides* first (so a `require-approval` can durably suspend between the two phases via the existing human gate, and a `block` never touches the host); the guard *commits* second (so it owns running the side effect through a registry-supplied thunk, binding idempotency, recording compensation, and emitting its tamper-evident audit record). The engine never sees the governor's internals — compensation and audit are **engine-opaque handles**, exactly as a `credentialRef` is an opaque secret reference ([tool-registry.md](tool-registry.md)).

```ts
/**
 * Optional capability on the host. Governs side-effecting tools AND ALL egress — a `policy.spawnsProcess`,
 * any `policy.egress` (incl. read-only egress like `web_search`), or an fs WRITE (`policy.fsWrite`, below).
 * Local read-only tools (fs read, `git_status`, clipboard) and `invoke_agent` (engine delegate, not a host
 * capability) bypass it.
 */
interface ActionGuard {
  /**
   * PHASE 1 — decide. Called AFTER the ADR-0029 guardrails pass (the registry only consults the guard
   * on actions it already permits) and BEFORE any host side effect. Pure-decision: the guard runs its
   * information-flow check, per-action authorization, and risk classification, and returns a verdict.
   * MUST NOT perform the side effect here.
   */
  decide(intent: ActionIntent, ctx: ActionGuardContext): Promise<ActionDecision>;

  /**
   * PHASE 2 — commit. Called only after `decide` returned `allow` (and, for `require-approval`, after the
   * engine obtained approval via the durable human gate; for `transform`, after the engine re-validated
   * the narrowed args). The guard OWNS running the effect: it invokes `thunk` (the registry-supplied
   * thunk that performs the underlying `ToolHost` mechanism) exactly once for a given `plan.idempotencyKey`,
   * binding idempotency, recording a compensation, and emitting its audit record. Returns the untrusted-
   * marked result plus the engine-opaque `ActionReceipt` the engine journals for replay.
   */
  commit(plan: ActionPlan, thunk: ActionCommit, ctx: ActionGuardContext): Promise<GovernedResult>;

  /**
   * OUT-OF-BAND — compensate. Reverse an already-committed action on a later saga failure or post-hoc
   * policy violation (the engine calls this when a downstream node fails and the run unwinds, or on an
   * operator/kill-switch request). Idempotent: safe to retry. Optional — a guard with no reversible
   * actions may omit it (then irreversible actions must have been gated at `decide`).
   */
  compensate?(receipt: ActionReceipt, reason: CompensationReason, ctx: ActionGuardContext): Promise<CompensationOutcome>;
}

/** The registry-supplied thunk that performs the underlying side effect (the same `ToolHost` call the
 *  registry would have made directly). The guard wraps — never replaces — it. */
type ActionCommit = () => Promise<Untrusted<unknown>>;
```

## `ActionIntent` — what the engine passes

The engine hands the guard the **effective, validated** action (post-[ADR-0029](../../decisions/0029-tool-policy-hardening.md)) plus the taint markers and identity it already holds. It carries no raw secret: a secret-typed value is a host-resolved `credentialRef`, named in `secretArgKeys`, never an arg value ([tool-registry.md §Guardrail enforcement](tool-registry.md#guardrail-enforcement-policy--engine-pure-mechanism--host)).

```ts
interface ActionIntent {
  readonly toolId: ToolId;                       // tool-registry.md
  readonly action: ActionClass;                  // the side-effect kind (below) — read-only never reaches here
  readonly effectiveArgs: Untrusted<JsonValue>;  // the COMPLETE validated effective set (step 3); model-derived parts already untrusted-marked
  readonly secretArgKeys: ReadonlySet<string>;   // effective-arg keys carrying a host-resolved credentialRef (NEVER the secret value) — 0029(c)
  readonly taint: ActionTaint;                    // integrity/confidentiality labels the guard's IFC consumes (below)
  readonly principal: ActionPrincipal;            // who/what: the agent, the on-behalf-of user, the delegation chain
  readonly correlation: ActionCorrelation;        // the run-or-session origin (discriminated union) — for audit + the idempotency key
}

/**
 * The governed side-effecting kinds, derived from `ToolPolicyClass` (tool-registry.md): `spawnsProcess`
 * → `process`; `egress: 'http' | 'search' | 'mcp'` → `egress-http` | `egress-search` | `egress-mcp`; an
 * fs WRITE → `fs-write`. The fs-write split needs a discriminator the current `ToolPolicyClass` LACKS —
 * `fsScoped` is `true` for reads AND writes alike (`read_file` / `write_file` / `list_directory` share it),
 * so ADR-0041 proposes an additive **`fsWrite?: boolean`** on `ToolPolicyClass` (canonical in tool-registry.md;
 * lands when 0041 is Accepted). Until it lands, an implementation MUST NOT govern fs reads as `fs-write`.
 * Local read-only tools (fs read, `git_status`, clipboard) are NOT governed. EGRESS IS governed even when
 * read-only (e.g. `web_search`): egress is an exfiltration *sink* for the IFC pillar (the query is the
 * lethal-trifecta channel), so the guard sees every egress for IFC/authz/audit — a read-only egress simply
 * carries no compensation.
 */
type ActionClass = 'process' | 'egress-http' | 'egress-search' | 'egress-mcp' | 'fs-write';

/** The taint the registry already computed (tool-registry.md §Untrusted-data taint / 0029(c) secret taint), surfaced for IFC.
 *  The guard's information-flow decision CONSUMES this and its result stays untrusted-marked (taint handoff, below). */
interface ActionTaint {
  readonly untrustedArgKeys: ReadonlySet<string>; // effective-arg keys derived from an untrusted source (a tool result / web / file)
  readonly hasSecretRefs: boolean;                // any secretArgKeys present
}

interface ActionPrincipal {
  readonly agentId: string;                       // the .agent.yaml identity taking the action
  readonly onBehalfOf?: string;                   // the human/service the agent acts for (an enterprise host may inject this; absent on a solo BYOK-local run)
  readonly delegation?: readonly string[];        // the delegation chain (sub-agent hops), if the host supplies one
}

/**
 * Correlates the action to its origin — a `WorkflowEngine` run OR an `AgentSession` turn (the two entry
 * points, [ADR-0024](../../decisions/0024-agent-first-entry-point-agentsession.md)). A discriminated UNION,
 * not an optional-`runId` record: a session has NO `runId` (ADR-0024 keeps run and session distinct), so
 * neither entry point fabricates the other's id, and node-retry `attempt` vs session `turn` stay typed to
 * their own world.
 */
type ActionCorrelation =
  | {
      readonly kind: 'run';
      readonly runId: string;
      readonly nodeId: string;
      readonly attempt: number;   // the node-retry attempt (ADR-0040) — part of replay correlation, NOT the idempotency key
    }
  | {
      readonly kind: 'session';
      readonly sessionId: string; // [agent-session-spec.md](../contracts/agent-session-spec.md)
      readonly turn: number;      // the session turn — the session-side counterpart of `attempt`
    };
```

## `ActionDecision` — the verdict the engine interprets

A discriminated union the registry lowers into its **existing** control flow — no new failure path, suspend mechanism, or validator.

```ts
type ActionDecision =
  | { readonly verdict: 'allow'; readonly plan: ActionPlan }
  | { readonly verdict: 'block'; readonly reason: ToolPolicyDenyReason }                    // → tool_denied (fatal); stable reason code from tool-registry.md §Error taxonomy
  | { readonly verdict: 'require-approval'; readonly approval: ApprovalRequest; readonly plan: ActionPlan }
  | { readonly verdict: 'transform'; readonly narrowedArgs: Untrusted<JsonValue>; readonly plan: ActionPlan };

/** Opaque to the engine: the guard's idempotency key + whatever it needs to commit/compensate this action.
 *  The engine journals it (replay) and hands it back to `commit`; it never inspects the internals. */
interface ActionPlan {
  readonly idempotencyKey: string;   // the guard's SEMANTIC effect key (NOT the request body hash) — replay-stable
  readonly opaque: OpaqueGuardState; // engine-opaque (Readonly<Record<string, unknown>>) — compensation descriptor, audit ref, etc.
}

/** The approval ask — surfaced through the SAME durable human gate as a `human_in_the_loop` node (ADR-0036). */
interface ApprovalRequest {
  readonly summary: string;                 // human-facing: what is about to happen (the dry-run preview)
  readonly riskTier: 'low' | 'elevated' | 'high' | 'irreversible';
  readonly timeoutPolicy?: HumanGateTimeout; // the `human_in_the_loop` gate's timeout shape ([node-types.md](node-types.md)) — reused, not redefined; absent ⇒ host default
}
```

`ToolPolicyDenyReason` is the stable, closed reason-code union used by `ToolPolicyError` in [tool-registry.md §Error taxonomy](tool-registry.md#error-taxonomy); reusing it for the `block` verdict keeps the governor denial in the same taxonomy as the engine's own guardrail denials.

Engine interpretation of each verdict:

| Verdict | Engine action (all reuse existing machinery) |
|---------|----------------------------------------------|
| `allow` | proceed to **PHASE 2 commit** (`guard.commit(plan, thunk, ctx)`). |
| `block` | raise `ActionDeniedError` → **`tool_denied`** (fatal, never retried — the [tool-registry.md §Error taxonomy](tool-registry.md#error-taxonomy) class, no new code). |
| `require-approval` | **suspend** the run on the durable `human_in_the_loop` gate ([ADR-0036](../../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md)); on resume → `approve` proceeds to commit, `reject` raises `ActionDeniedError` → `tool_denied`, timeout follows the gate's `approve`/`reject` fallback (the human-gate timeout — [node-types.md](node-types.md)). **No new suspend/resume mechanism. Run-only in Phase 1 — see Entry-point scope.** |
| `transform` | **re-validate** `narrowedArgs` against the **same** `tool.parseArgs` (Zod) + [ADR-0029](../../decisions/0029-tool-policy-hardening.md) guardrails; the guard may only **narrow, never widen** (symmetry with node-tools narrow-only, 0029(b)) — a widening attempt fails `ToolArgsInvalidError`. On success → commit. |

## Supporting types

The remaining types the seam references. `ToolId`, `JsonValue`, and `AbortSignalLike` are imported from [tool-registry.md](tool-registry.md) / `@relavium/shared`, not redefined; `Untrusted<T>` is the engine's branded untrusted marker, canonical in [tool-registry.md §Untrusted-data taint](tool-registry.md#untrusted-data-taint-1t-marks-1o-places); `HumanGateTimeout` is the `human_in_the_loop` node's timeout shape, canonical in [node-types.md](node-types.md) (reused, not redefined — rule 8).

```ts
/** What `commit` returns: the untrusted-marked tool result + the engine-opaque receipt the registry journals. */
interface GovernedResult {
  readonly result: Untrusted<unknown>;    // stays untrusted end to end (tool-registry.md §Untrusted-data taint)
  readonly receipt: ActionReceipt;
}

/** Engine-OPAQUE proof-of-commit. The registry journals it in `run_events` (keyed by `idempotencyKey`) for
 *  replay and hands it back to `compensate`; the engine never inspects `opaque`. */
interface ActionReceipt {
  readonly idempotencyKey: string;        // the SAME key as `ActionPlan.idempotencyKey` — the replay / dedup key
  readonly opaque: OpaqueGuardState;       // the guard's compensation descriptor, audit ref, commit time, … (engine never reads it)
}

/** Engine-opaque carrier the engine journals but never interprets — the governor's internals live here.
 *  Must be JSON-serializable because it is persisted in `run_events` for replay/resume. */
type OpaqueGuardState = Readonly<Record<string, JsonValue>>;

/** JSON-serializable values only — `OpaqueGuardState` is journaled, so non-serializable data must not enter. */
type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | Readonly<Record<string, JsonValue>>;

/** Why the engine is asking for a reverse — the `WorkflowEngine` run loop (ADR-0036) supplies it. */
type CompensationReason = 'saga_unwind' | 'policy_violation' | 'operator_killswitch';

/** The outcome of a reverse. `irreversible` is the honest "no compensation exists" answer (such an action
 *  should have been gated at `decide` — see Composition rules); `failed` raises `CompensationError`. */
interface CompensationOutcome {
  readonly status: 'reversed' | 'not_needed' | 'irreversible' | 'failed';
  readonly detail?: string;                // secret-free human note for the audit / operator
}

/** The per-call context shared by all three methods — minimal by design (the rich payload is in `ActionIntent`). */
interface ActionGuardContext {
  readonly correlation: ActionCorrelation;  // the run-or-session origin (discriminated union), so `commit`/`compensate` locate the action
  readonly approval?: ApprovalResolution;   // present on `commit` ONLY when `decide` returned `require-approval` and the gate APPROVED
  readonly signal?: AbortSignalLike;        // cooperative cancel — an abort routes to the ADR-0036 cancel path, never `tool_failed`
}

/** The approved resolution the durable human gate (ADR-0036) hands forward to `commit`. A `reject` never reaches `commit`. */
interface ApprovalResolution {
  readonly approver?: string;               // who approved, if the host has an identity to attribute; absent on a solo run
}
```

## Where it sits in the dispatch lifecycle

The [tool-registry.md](tool-registry.md#resolution--the-dispatch-lifecycle) pipeline is unchanged through step 4. The `ActionGuard` inserts **between step 4 (guardrails pass) and step 5 (the host side effect)**, for side-effecting tools only, and **only when a guard is injected**:

- **4 → (default, no guard):** step 5 calls the `ToolHost` capability directly — today's behavior, no external call.
- **4 → (guard injected, side-effecting tool):**
  - **4a. decide.** `guard.decide(intent, ctx)` → `ActionDecision`.
  - **4b. interpret** the verdict (table above): `block` → `tool_denied`; `require-approval` → durable suspend (ADR-0036), resume re-enters at 4c; `transform` → re-validate (back through steps 3–4 on the narrowed args), then 4c; `allow` → 4c.
  - **4c. commit.** `guard.commit(plan, thunk, ctx)`, where `thunk` is the **exact** step-5 host call. The guard runs it once per `plan.idempotencyKey`, returns `GovernedResult { result: Untrusted<...>, receipt }`.
- **The rest of the [tool-registry.md](tool-registry.md#resolution--the-dispatch-lifecycle) pipeline proceeds unchanged** — `output_mapping` on the full result, model-facing result bounding, the untrusted-mark, and bus emission — *plus* the registry **journals the `ActionReceipt`** as a side effect in `run_events` (see Determinism, below).

Read-only tools, `invoke_agent`, and any dispatch with no injected guard **skip 4a–4c entirely**.

## Composition rules

| Rule | How it holds |
|------|--------------|
| **Off by default** | no guard ⇒ no `decide`/`commit`, direct `ToolHost` call, zero external egress — the local-first guarantee ([product-constraints.md](../../product-constraints.md)). |
| **Governed classes (side-effecting + egress)** | the registry consults the guard only for `policy.spawnsProcess`, any `policy.egress` (incl. read-only `web_search`), or an fs write (`policy.fsWrite` — the additive flag ADR-0041 proposes, see `ActionClass`); local read-only tools and `invoke_agent` bypass it. |
| **Composes after, never replaces** | [ADR-0029](../../decisions/0029-tool-policy-hardening.md) runs first (steps 1–4); a not-granted / disallowed / SSRF-blocked call is already `tool_denied` **before** `decide`. The guard can only further restrict (`block` / `require-approval`) or narrow (`transform`) — never re-grant. |
| **Narrow-only transform** | a `transform` verdict's `narrowedArgs` is re-validated through the same Zod + 0029 path; widening fails (0029(b) symmetry). |
| **Taint handoff** | the guard consumes `intent.taint` (the registry's untrusted/secret markers) for its IFC decision and returns an `Untrusted<...>` result — the unsafe-path-unrepresentable boundary ([tool-registry.md §Untrusted-data taint](tool-registry.md#untrusted-data-taint-1t-marks-1o-places)) holds end to end. |
| **No raw secret crosses the seam** | `secretArgKeys` names credential-bearing keys; the value stays a host-resolved `credentialRef` (0029(c)) — the guard governs *which* credential ref, never *the secret*. |
| **Vendor-neutral** | the interface names no governor; Provna is one implementation. No governor SDK type crosses the seam. |
| **Irreversible ⇒ gated at `decide`** | the engine has no reverse of its own to fall back on, so for `riskTier: 'irreversible'` (or any action whose guard implements no `compensate`) `decide` MUST return `require-approval` or `block`, never `allow`. The seam states the contract; the **guard implementation** enforces it (the engine cannot). |

## Determinism, idempotency & replay

Side effects must survive the derived `Checkpointer` ([ADR-0003](../../decisions/0003-pure-ts-engine-not-langgraph-python.md)) + cross-process `resumeFromCheckpoint` ([ADR-0036](../../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md)) **without re-executing**, exactly as an LLM call does ([ADR-0039](../../decisions/0039-same-provider-reasoning-replay.md)):

- The registry **journals the `ActionReceipt`** (and the verdict) as a side-effect record in `run_events`, keyed by `plan.idempotencyKey`; for a `require-approval`, the verdict's `ActionPlan` is journaled at decide-time so the suspend/resume carries it across the checkpoint. On resume, a present receipt is **re-delivered, not re-committed** — a resumed run never double-posts a payment / re-spawns a process.
- The `idempotencyKey` is the guard's **semantic effect key** (a function of principal + resource + normalized intent), *not* the request-body hash and *not* the run-retry `attempt` (nor the session `turn`) — so a node-retry ([ADR-0040](../../decisions/0040-node-retry-budget-above-the-chain.md)) of the *same* logical action reuses the key and the guard de-duplicates, while a genuinely new action gets a new key.
- For a **`WorkflowEngine` run**, the run loop ([ADR-0036](../../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md)) is what calls `compensate` — when a downstream node fails and the run unwinds, or on an operator / kill-switch via the cancel flow ([ADR-0036](../../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md)). (For `AgentSession` turns, automatic compensation is **out of scope in Phase 1** — see Entry-point scope.) `compensate` is itself idempotent and journaled, so an unwind that is interrupted and resumed does not double-reverse.

## Entry-point scope — run vs session (Phase 1)

Two of the seam's behaviors lean on `WorkflowEngine` machinery an `AgentSession` ([ADR-0024](../../decisions/0024-agent-first-entry-point-agentsession.md)) does not (yet) have — a node-level run loop, the `human_in_the_loop` gate, and (until 1.X/1.Y) durable session persistence:

- **`require-approval` is run-only in Phase 1.** It reuses the durable `human_in_the_loop` gate, a `WorkflowEngine` node mechanism. A guard governing an `AgentSession` turn MUST resolve to `allow` / `block` / `transform` (synchronous) and MUST NOT return `require-approval` — or the host must surface an interactive approval out-of-band *before* calling `commit`. (Durable session approval lands with session persistence, 1.X/1.Y.)
- **Automatic `compensate` (saga unwind) is run-only in Phase 1.** A session has no run-loop unwinder, so a session turn gets `decide` / `commit` / per-action audit / idempotency, but **no automatic compensation**. Its irreversible / high-risk actions must therefore be **gated at `decide`** (which, given the run-only `require-approval` rule above, means `block` for a session — or an out-of-band host approval); any reversal of a committed session action is operator-triggered, not automatic.

Both are deliberate Phase-1 scope, not seam limitations: the **run** entry point (the FS-back-office target) gets the full guarantee today; the **session** entry point gets IFC + authz + audit + idempotency now, and the transactional + approval guarantees when the session unwinder + persistence land.

## Error taxonomy (additions to [tool-registry.md](tool-registry.md#error-taxonomy))

All typed, discriminant-narrowed, **secret-free** ([error-handling.md](../../standards/error-handling.md)):

| Error | When | Run `ErrorCode` | Class |
|-------|------|-----------------|-------|
| `ActionDeniedError` | `decide` returned `block`, or `require-approval` resolved to `reject`/timeout-reject | `tool_denied` | **fatal** (never retried — a denied action re-asked just burns budget; same class as `ToolPolicyError`) |
| `ActionGuardError` | `guard.decide` threw, or the guard's control plane was unreachable in the **decision** phase — the verdict is **indeterminate**, so the registry **fails closed** (the action does NOT execute). Safe to retry — nothing committed. | `tool_failed` | retryable (fail-closed; node budget) |
| `ActionCommitError` | `guard.commit` threw a non-cancel error (the underlying side effect or the governor failed) | `tool_failed` *(default)* | retryable **by default** — the idempotency key makes the retry *safe*. But a retry is not always *correct* (an upstream 4xx / unauthorized won't fix on retry), so the **guard MAY throw a classified error** the registry maps to `tool_denied` / `validation` (fatal) instead; absent a classification, the default is retryable. |
| `CompensationError` | `guard.compensate` failed to reverse a committed action | `internal` | fatal — surfaced for operator escalation; the audit shows the system *attempted* the unwind |

An **undefined** `actionGuard` is the **default-off** path (no `decide`/`commit`, direct `ToolHost` call) — **not** an error. `ActionGuardError` is the *opposite* case: a guard IS injected but cannot render a decision (its control plane errored / timed out), so the registry fails closed rather than letting an ungoverned action through.

## Instantiation

```ts
// Engine-pure: the registry takes the SAME shape as today, plus an OPTIONAL guard. Omit it ⇒ unchanged behavior.
const registry = createToolRegistry({
  tools: BUILTIN_TOOLS,   // tool-registry.md
  host: toolHost,         // the surface's ToolHost (Node fs/process/fetch; desktop Rust commands)
  actionGuard,            // OPTIONAL — undefined on the local-first default; an enterprise host injects one
});
// Dispatch is unchanged for read-only tools and when actionGuard is undefined; for a side-effecting tool
// with a guard present, the registry runs decide → (interpret) → commit around the step-5 host call.
const result = await registry.dispatch(toolCall, ctx);
```

`createToolRegistry` still performs **no** I/O and reads **no** ambient state; a stub `ActionGuard` (like the stub `ToolHost`) keeps the whole registry unit-testable with zero real side effects. Adding a guard never widens what a node may call — `ctx.grantedToolIds` + [ADR-0029](../../decisions/0029-tool-policy-hardening.md) still gate the call first; the guard can only restrict further.

> **Engine-opaque by design.** `OpaqueGuardState`, `ActionReceipt`, and the compensation/audit internals are `Readonly<Record<string, unknown>>` the engine carries and journals but never interprets — the governor's IFC engine, compensation library, per-action authorization, and tamper-evident audit live entirely on the **external** side of the seam (see [ADR-0041](../../decisions/0041-external-action-governance-seam.md)). Relavium owns the boundary; the governor owns the guarantees.
