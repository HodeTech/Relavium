# ADR-0057: Reseat-less chat modes and per-tool approval (with mid-turn abort)

- **Status**: Proposed
- **Date**: 2026-06-28
- **Related**: [ADR-0024](0024-agent-first-entry-point-agentsession.md), [ADR-0029](0029-tool-policy-hardening.md), [ADR-0028](0028-workflow-resource-governance.md), [ADR-0037](0037-engine-tool-execution-boundary.md), [ADR-0055](0055-cli-host-capability-seam-tool-environment-factory.md), [ADR-0059](0059-cli-mid-session-model-reseat.md), [phase-2.5-cli-consolidation.md](../roadmap/phases/phase-2.5-cli-consolidation.md) (2.5.E), [architectural-principles.md](../standards/architectural-principles.md)

> **Draft.** Proposed alongside the Phase 2.5 plan; to be reviewed and finalized (→ Accepted) when workstream 2.5.E begins. **Security review is mandatory before Accept.**

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
  `/mode` change applies on the next turn. `Shift+Tab` cycles `ask → plan → accept-edits`; `auto` is
  explicit-only (`/mode auto`); there is **no one-key bypass valve**
  ([ADR-0029](0029-tool-policy-hardening.md)). `.git/`, `.relavium/`, and shell rc files are never
  auto-written in any mode. Switching the **model** mid-session does require a reseat — the separate
  concern of [ADR-0059](0059-cli-mid-session-model-reseat.md).
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
  guarantee, so a wiring bug cannot let `ask` mode write. Plus: a session-stream `agent:approval_requested`
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

Considered reseating per mode change (rejected: silent tool-context loss + instance churn); binding a
read-only host and reseating to add write capability (rejected: same loss); reusing the node-level
workflow gate for per-tool approval (rejected: wrong granularity — it pauses a DAG vertex, not a tool
call); and a single bypass flag like the four surveyed competitors (rejected: secure-by-default).

## Consequences

### Positive

- Instant, lossless mode switching; real per-tool approval with once/always memory; a true mid-turn abort
  that keeps the session alive (today `/cancel` kills it).
- No one-key bypass valve — the one structural differentiator from every surveyed terminal agent CLI.
- The pause/resume machine is shared by per-tool approval, mid-turn abort, and the deferred budget pause.

### Negative

- The `ToolHost` is full-capability even in `ask` mode, so defense-in-depth rests one layer more on the
  policy layer than on capability absence — mitigated by the advertise-filter, the `enforcePolicy` gate,
  protected paths, and this ADR's mandatory security review.
- This is the most complex workstream: a new shared event, a new session state, and a REPL intercept —
  isolated in 2.5.E behind this ADR so the rest of Phase 2.5 does not depend on it.
