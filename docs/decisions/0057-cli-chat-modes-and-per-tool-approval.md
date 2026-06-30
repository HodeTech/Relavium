# ADR-0057: Reseat-less chat modes and per-tool approval (with mid-turn abort)

- **Status**: Proposed
- **Date**: 2026-06-28
- **Related**: [ADR-0024](0024-agent-first-entry-point-agentsession.md), [ADR-0029](0029-tool-policy-hardening.md), [ADR-0028](0028-workflow-resource-governance.md), [ADR-0037](0037-engine-tool-execution-boundary.md), [ADR-0041](0041-external-action-governance-seam.md), [ADR-0043](0043-media-egress-failover-rematerialization-ssrf.md), [ADR-0053](0053-mcp-network-transport-egress-security.md), [ADR-0055](0055-cli-host-capability-seam-tool-environment-factory.md), [ADR-0059](0059-cli-mid-session-model-reseat.md), [phase-2.5-cli-consolidation.md](../roadmap/phases/phase-2.5-cli-consolidation.md) (2.5.E), [tool-registry.md](../reference/shared-core/tool-registry.md), [action-guard-seam.md](../reference/shared-core/action-guard-seam.md), [architectural-principles.md](../standards/architectural-principles.md)

> **Draft.** Proposed alongside the Phase 2.5 plan; to be reviewed and finalized (→ Accepted) when workstream 2.5.E begins. **Security review is mandatory before Accept** — and now covers a larger surface than the original draft: the write-capable `fs` tier + protected paths, the SSRF-hardened host `egress` arm, the `os` arm (the 2.5.A deferral closed here), and the maintainer's decision to put `auto` on the `Shift+Tab` cycle (below). Per-tool approval is built as a separate, lighter `confirmAction` primitive that **composes with** the Accepted `ActionGuard` seam ([ADR-0041](0041-external-action-governance-seam.md)) rather than reusing it — see [§Relationship to ADR-0041](#relationship-to-adr-0041-actionguard).

## Context

We want Claude-Code-style chat modes (ask / plan / accept-edits / auto) and per-tool approval for writes
and shell. Two facts about the current code shape the decision. First, a session binds one agent and one
model for its lifetime, with the fallback plan memoized ([ADR-0024](0024-agent-first-entry-point-agentsession.md)),
and the cross-turn transcript plus `reconstructSessionState` are **text-only** — so applying each mode
change by "reseating" the session (reconstruct + a new instance) would silently delete that session's
accumulated tool context (which files were read, tool results), a data-loss trap on a frequent keystroke.
Second, there is **no** per-tool approval infrastructure: the workflow human-gate is node-level, the
`gateApproved` flag is a one-way static deny that is always `false` on the chat path, `agent:tool_call`
is emitted *after* dispatch, and `ToolPolicy` carries no approval concept. Getting this wrong either
loses context on every `Shift+Tab` or ships an unsafe "approve everything" escape hatch.

A third fact bounds the design. Relavium **already** has an Accepted side-effect-governance seam — the
optional, host-injected `ActionGuard` ([ADR-0041](0041-external-action-governance-seam.md) /
[action-guard-seam.md](../reference/shared-core/action-guard-seam.md)), which inserts a two-phase
`decide → commit → compensate` protocol between the guardrail check and the host side-effect for an
*external, automated* governor (off-by-default, Phase-2 enterprise). It is the **wrong tool for
interactive end-user consent**: its `require-approval` verdict is **run-only** (a session has no durable
gate — [ADR-0041](0041-external-action-governance-seam.md) §Entry-point scope, which itself anticipates the
host "surfacing an interactive approval out-of-band *before* `commit`"), and its idempotency /
compensation / tamper-evident-audit / IFC machinery is overkill for a "may I write this file?" terminal
prompt. So per-tool approval is a **separate, lighter** primitive that **composes with** — never replaces
— `ActionGuard` ([§Relationship to ADR-0041](#relationship-to-adr-0041-actionguard)). Finally, the 2.5.A
host wiring deferred the chat `egress` / `os` arms and the write-capable `fs` tier to this workstream
([ADR-0055](0055-cli-host-capability-seam-tool-environment-factory.md) §Phased wiring); they land here,
behind the approval floor, with the host-side SSRF egress mechanism the
[deferred-tasks](../roadmap/deferred-tasks.md) ledger tracks (`EgressCapability.fetch` enforcement).

## Decision

**We will make chat modes a policy layer on the same session instance — no reseat — and build per-tool
approval as a new, bounded engine vertical.**

- **Reseat-less modes.** The `ToolHost` is bound full-capability for the session lifetime
  ([ADR-0055](0055-cli-host-capability-seam-tool-environment-factory.md)); a mutable `#mode` (snapshotted
  per turn) controls only (a) the model-advertised tool subset (a per-turn `buildLlmTools` filter) and
  (b) the per-dispatch approval policy. Mode changes flip a flag — lossless, cheap, and two-layer safe:
  the advertise-filter (best-effort — it keeps a write tool out of the model's reach) plus the
  **mode-aware `confirmAction` approval policy** (authoritative — if the model emits a `write_file` call in
  `ask` mode anyway, the approval policy denies it by mode). The existing `enforcePolicy` gate is
  mode-agnostic (it only enforces `requiresGateApproval` / `allowedCommands`) and is the floor beneath
  both. The mode policy is read from the same per-turn snapshot as the advertise-filter, so a mid-turn
  `/mode` change applies on the next turn. `Shift+Tab` cycles **`ask → plan → accept-edits → auto`**
  (auto-approve is now a mainstream expectation, so `auto` is reachable in the cycle, not hidden behind a
  typed command), and `/mode <name>` jumps directly. **The default is read-only `ask`**, the active mode is
  **always shown in the footer**, and reaching `auto` is a deliberate, visible, reversible cycle step — so
  there is **no hidden "bypass all permissions" valve**: even `auto` cannot write a **protected path**
  (`.git/`, `.relavium/`, shell rc — in `auto` a protected-path write **falls back to an explicit prompt**,
  never auto-approved) or escape the `fs` jail / sandbox tier, and the fail-closed `confirmAction` floor
  (below) applies under **every** mode ([ADR-0029](0029-tool-policy-hardening.md) secure-by-default). That
  surviving guarantee — a read-only default plus no mode that escapes protected-paths + the jail — is the
  structural differentiator from the surveyed terminal CLIs, preserved even with `auto` on the cycle.
  Switching the **model** mid-session does require a reseat — the separate concern of
  [ADR-0059](0059-cli-mid-session-model-reseat.md).
- **Per-tool approval (new vertical), fail-closed.** A registry pre-dispatch `confirmAction` hook
  (host-injected — the same dependency-inversion pattern as `ToolHost`, so it does not violate
  [ADR-0037](0037-engine-tool-execution-boundary.md)'s tool-execution boundary: the engine defines the hook
  interface, the host supplies the implementation). It runs **between `enforcePolicy` and the side-effect**
  in `packages/core/src/tools/registry.ts`. **Critically:** `enforcePolicy` is mode-agnostic and **inert
  for `write_file`** (its `FS_POLICY` sets `requiresGateApproval:false` and is not a process tool, so none
  of `enforcePolicy`'s three arms — gate / command-allowlist / domain-allowlist — apply). So `confirmAction`
  is the **authoritative** mode gate, and it must be **fail-closed**: when the host has wired a write /
  process / egress arm ([ADR-0055](0055-cli-host-capability-seam-tool-environment-factory.md)), a
  write-/exec-/egress-class tool dispatch **requires** a `confirmAction` decision — if no hook is supplied,
  the dispatch is **denied**, never allowed. The advertise-filter is best-effort; this floor is the
  guarantee, so a wiring bug cannot let `ask` mode write. The registry classifies a dispatch's side-effect
  kind from its `ToolPolicyClass` ([tool-registry.md](../reference/shared-core/tool-registry.md)):
  `spawnsProcess` and `egress` already discriminate, but `fsScoped` is `true` for **both** `read_file` and
  `write_file`, so it cannot tell a write from a read. This ADR therefore lands the additive
  **`fsWrite?: boolean`** flag on `ToolPolicyClass` — the **same** discriminator
  [ADR-0041](0041-external-action-governance-seam.md) already proposed for its `fs-write` `ActionClass`
  (canonical home [tool-registry.md](../reference/shared-core/tool-registry.md)); it is landed here and
  **credited to both ADRs**, so the two stay compatible. A read-only tool (`read_file` / `list_directory` /
  `git_status`) is never write-class and never requires `confirmAction`. Plus: a session-stream `agent:approval_requested`
  event (kept in the existing `agent:*` namespace, alongside `agent:tool_call`); an `AgentSession`
  pause/resume state (which today does not exist) — and an `Esc` **mid-turn abort** that aborts the
  in-flight turn and keeps the session alive by emitting **one** `session:turn_completed` (with an abort
  stop-reason), rolling back the pending user message, and returning `#status` to `idle` (the engine has no
  `aborted` status and this is **not** `cancel()`, which is terminal); a REPL `[approve]/[reject]/[comment]`
  intercept that bypasses the in-flight key-swallow gate (so the prompt cannot deadlock); a typed
  `ToolDeniedByUserError` carrying the **existing** `tool_denied` `ErrorCode` (already non-retryable — it is
  absent from `RETRYABLE_ERROR_CODES` in `@relavium/shared/constants`, so a user deny is final, not a retried
  execution error); and a session-scoped, **in-memory** once/always cache (instance-scoped — **not**
  persisted across resume, so a reseat or `chat-resume` re-prompts; semantics: **once** = this specific
  invocation (tool + args), **always** = this tool id for the remainder of this session instance). The
  `gateApproved` flag is **not** reused (it is a one-way static deny). The session-level budget pause/resume
  deferred from Phase 2 ([ADR-0028](0028-workflow-resource-governance.md)) rides the same machine.
- **Host arms (the 2.5.A deferral, closed here).** The write-capable `fs` tier, the `egress` arm, and the
  `os` arm are wired in the CLI host this workstream — no deferral left behind. `egress` reuses the
  **existing SSRF-validated** connect-by-validated-IP mechanism (DNS-resolve → validate **every** resolved
  IP → connect pinned to the validated IP → re-validate on **every** redirect hop → size-bounded stream)
  already shipped for media egress ([ADR-0043](0043-media-egress-failover-rematerialization-ssrf.md),
  `packages/db/src/media-egress.ts`) over the one shared `isPrivateOrLocalHost` range-block
  (`@relavium/shared`) — **extracted so tool egress and media egress share one implementation, never a
  second SSRF parser** ([ADR-0029](0029-tool-policy-hardening.md)(d) one-primitive rule;
  [ADR-0053](0053-mcp-network-transport-egress-security.md) is the sibling MCP floor). `egress` is a
  **governed class**, so it always rides the fail-closed `confirmAction` floor; `web_search` resolves its
  provider key as an opaque host-side `credentialRef`, never exposing it to the engine. A **dedicated
  adversarial security review** covers the fs-write jail + protected paths, the egress mechanism, and the
  `os` arm.

### Relationship to ADR-0041 (`ActionGuard`)

`confirmAction` and `ActionGuard` are **complementary layers at the same dispatch boundary, not
alternatives.** `ActionGuard` ([ADR-0041](0041-external-action-governance-seam.md)) is the *automated,
organizational* policy-decision point — an external governor that `decide`s allow / block / transform and
`commit`s with idempotency + compensation + tamper-evident audit; optional, **off-by-default**, Phase-2
enterprise. `confirmAction` is the *interactive, end-user* consent gate — the human at the terminal answers
`[a]/[r]/[c]` — and is precisely the "out-of-band interactive approval the host surfaces before `commit`"
that [ADR-0041](0041-external-action-governance-seam.md) §Entry-point scope names for the **session** entry
point (where `ActionGuard`'s `require-approval` verdict is unavailable). When **both** are present they
**compose** in the [tool-registry.md](../reference/shared-core/tool-registry.md) dispatch lifecycle: the
[ADR-0029](0029-tool-policy-hardening.md) guardrails (steps 1–4) run first; then `ActionGuard.decide` (the
org's policy, if injected) may further restrict; then `confirmAction` (the user's consent) gates the
side-effect; then the host call (wrapped by `ActionGuard.commit` if injected). Each can only **restrict**,
never re-grant — secure-by-default holds end to end. The additive `fsWrite?` discriminator this ADR lands
is shared with, and satisfies, ADR-0041's `fs-write` `ActionClass` need.

Considered reseating per mode change (rejected: silent tool-context loss + instance churn); binding a
read-only host and reseating to add write capability (rejected: same loss); reusing the node-level
workflow gate for per-tool approval (rejected: wrong granularity — it pauses a DAG vertex, not a tool
call); **folding per-tool approval into the `ActionGuard` seam itself** (rejected: its `require-approval`
is run-only, it is off-by-default enterprise, and its compensation / idempotency / audit weight is wrong
for an interactive terminal prompt — it would couple 2.5.E to an unimplemented enterprise seam); and a
single bypass flag like the four surveyed competitors (rejected: secure-by-default — the default stays
read-only `ask` and no mode escapes protected-paths + the jail).

## Consequences

### Positive

- Instant, lossless mode switching; real per-tool approval with once/always memory; a true mid-turn abort
  that keeps the session alive (today `/cancel` kills it).
- No hidden "bypass all permissions" valve — the default is read-only `ask`, the mode is always shown, and
  **no** mode (auto included) writes a protected path or escapes the fs jail. That guarantee — not "auto is
  unreachable by key" — is the structural differentiator from the surveyed terminal CLIs, and it survives
  putting `auto` on the `Shift+Tab` cycle (a deliberate mainstream-UX call).
- One SSRF egress implementation shared by tool egress and media egress (no second parser); the additive
  `fsWrite?` flag is shared with ADR-0041, so the enterprise `ActionGuard` track inherits it.
- The pause/resume machine is shared by per-tool approval, mid-turn abort, and the deferred budget pause.

### Negative

- The `ToolHost` is full-capability even in `ask` mode, so defense-in-depth rests one layer more on the
  policy layer than on capability absence — mitigated by the advertise-filter, the `enforcePolicy` gate,
  protected paths, and this ADR's mandatory security review.
- `auto` is reachable on the `Shift+Tab` cycle, so auto-approve-writes is one cycle-position away — a
  deliberate UX call, mitigated by the read-only default, the always-visible mode indicator, the
  protected-paths rule (never auto in any mode), the fs jail, and the fail-closed floor; the mandatory
  security review scrutinizes this trade-off explicitly.
- The CLI host now carries `fs`-write, `egress`, and `os` capabilities (the 2.5.A deferral closed), a
  larger security surface — mitigated by reusing the already-reviewed SSRF connect-by-validated-IP
  mechanism (one shared primitive), the protected-paths rule, and a dedicated security review.
- This is the most complex workstream: a new shared event, a new session state, a registry approval hook,
  three new host arms, and a REPL intercept — isolated in 2.5.E behind this ADR so the rest of Phase 2.5
  does not depend on it.
