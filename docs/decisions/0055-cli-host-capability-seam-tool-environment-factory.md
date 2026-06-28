# ADR-0055: Shared CLI tool-environment factory — `ToolHost`, `ToolPolicy`, and dispatch context as separate channels

- **Status**: Proposed
- **Date**: 2026-06-28
- **Related**: [ADR-0029](0029-tool-policy-hardening.md), [ADR-0037](0037-engine-tool-execution-boundary.md), [ADR-0043](0043-media-egress-failover-rematerialization-ssrf.md), [ADR-0053](0053-mcp-network-transport-egress-security.md), [ADR-0052](0052-inbound-mcp-client-package-lifecycle-registration.md), [phase-2.5-cli-consolidation.md](../roadmap/phases/phase-2.5-cli-consolidation.md) (2.5.A), [architectural-principles.md](../standards/architectural-principles.md)

> **Draft.** Proposed alongside the Phase 2.5 plan; to be reviewed and finalized (→ Accepted) when workstream 2.5.A begins. **Security review is mandatory before Accept.**

## Context

The built-in chat agent advertises `read_file` / `list_directory` / `git_status`
(`apps/cli/src/chat/default-agent.ts`) and its system prompt tells the model to "say so plainly" when a
tool is unavailable — a designed graceful path. But the CLI wires a **fail-closed** `ToolHost` (no `fs`,
no `process`, no `egress`) on both the chat path (`apps/cli/src/chat/session-host.ts`) and the
workflow-run path (`apps/cli/src/engine/build-engine.ts`). So the first tool call throws
`capability_unavailable`, which the turn core maps to a bare `internal`, and the user sees an opaque
`error: internal`. Two further problems compound it: the two paths build the host **differently** — the
chat path *merges* the MCP arm onto a base host, the run path *replaces* the host with `{ mcp }` — which
is harmless today but silently drops sibling arms (`fs`/`process`) once they are added; and the three
concepts a tool dispatch needs are distinct types that a naive factory signature would conflate — the
`ToolHost` capability arms, the `ToolPolicy` allowlists ([ADR-0029](0029-tool-policy-hardening.md)), and
the per-dispatch `ToolDispatchContext` (`fsScope`).

## Decision

**We will add one shared factory `assembleToolEnv(mode, fsScopeTier)` that returns `{ host: ToolHost,
policy: ToolPolicy }`, wired into both the chat and run paths, with `fsScope` flowing through the
dispatch context — keeping the three concepts in three channels.** The factory always uses conditional
spread (`exactOptionalPropertyTypes`-clean) so the MCP arm is a true **merge** on both paths, deleting
the two divergent inline host expressions. The default chat profile wires **`fs` read-only and the
`process` arm** — `read_file` / `list_directory` use `fs`, but `git_status` spawns `git` through
`requireProcess`, so an `fs`-only host would still fail it with `capability_unavailable` (the exact root
cause). `run_command` is kept unadvertised (the mode advertise-filter,
[ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md)) and denied by an empty `ToolPolicy.allowedCommands`,
so in the default profile the `process` arm only ever serves the pre-approved `git_status` — which is
**not** subject to `allowedCommands` (it exposes no model-controlled `command` to `policyTarget`, so
`enforcePolicy`'s command-allowlist arm never fires for it; an empty allowlist therefore blocks
`run_command` only, never `git_status`); `fs`-read-write and `egress` are wired only for the higher tiers. The `egress` arm reuses the existing SSRF-validated
`EgressCapability` mechanism ([ADR-0043](0043-media-egress-failover-rematerialization-ssrf.md)
/ [ADR-0053](0053-mcp-network-transport-egress-security.md)) — the one shared primitive, never
re-implemented.

**Responsibility boundary with [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md):** this ADR owns
*which capability arms are physically wired* — the `host`/`policy` shape, mode-independent; the `mode`
parameter drives only the `ToolPolicy` allowlists and the dispatch context, never the host-arm selection,
and that mapping lives in `apps/cli`, not the engine. ADR-0057 owns *whether a present capability may be
used in a given mode*. The tool dispatch boundary is unchanged
([ADR-0037](0037-engine-tool-execution-boundary.md)); the engine stays pure. Spec lives in
[tool-registry.md](../reference/shared-core/tool-registry.md).

This decision also covers the two pure engine amendments that complete the error surface (the phase doc's
EA1/EA2): **EA1** maps the dispatch-layer `capability_unavailable` to a new portable `tool_unavailable`
`ErrorCode` (`@relavium/shared` `ERROR_CODES`; `codeForToolError` in `agent-turn.ts` is the single change
point) instead of `internal`, so a missing capability surfaces with the tool name; and **EA2** carries the
real accumulated usage on a failed turn (a `usage` field on `AgentTurnError`), touching only the two
provider-engaged branches in `agent-session.ts`. Both are recorded by this ADR.

Considered the conflated signature `createCliToolHost({ fsScope, allowedCommands, egress })` (rejected:
`fsScope` is dispatch-context, `allowedCommands` is `ToolPolicy` — three types crammed into one); wiring
only `fs` for chat (rejected: leaves the run path and the `process`/`egress` tiers unwired — the same
gap, just narrower); and keeping the host fail-closed and merely filtering the advertised tool set
(rejected: the advertised tools must actually **work** for a first-class chat — the advertise-filter is
the safety complement, not a substitute for wiring the capability).

## Consequences

### Positive

- The capability-gap root cause is closed at its source: the chat agent's tools work, and the
  merge-vs-replace asymmetry is fixed once, in one place.
- One security-reviewed seam instead of two drifting inline host expressions; desktop/VS Code can reuse
  the same factory shape.

### Negative

- A new security surface — `fs`-write, `process`, and `egress` capabilities now exist in the CLI host —
  requiring a dedicated security review. The posture is **default-deny by policy, not by capability
  absence**: the host can write, but the mode/approval layer must permit it. ("Read-only by default" means
  the *chat default profile* wires only the read tiers; the higher tiers, once wired, are gated.)
- The write capability is physically present even in `ask` mode, since the mode system is a policy layer
  rather than a per-mode rebind — a deliberate defense-in-depth trade-off. It is mitigated by
  [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md)'s **fail-closed** `confirmAction` floor: whenever
  a write/process/egress arm is wired, a write-class dispatch *requires* an approval decision, and an absent
  hook **denies** — so even if the advertise-filter is bypassed, `ask` mode cannot write. (Crucially,
  `enforcePolicy` alone is **inert** for `write_file` — its `FS_POLICY` triggers none of `enforcePolicy`'s
  arms — so the floor is `confirmAction`, not `enforcePolicy`.) Protected paths apply in every mode.
