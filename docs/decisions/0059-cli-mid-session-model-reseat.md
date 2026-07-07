# ADR-0059: Mid-session model switching via host-side reseat (refines ADR-0024)

- **Status**: Accepted
- **Date**: 2026-07-06
- **Related**: [ADR-0024](0024-agent-first-entry-point-agentsession.md) (the one-model-per-lifetime rule this refines), [ADR-0026](0026-session-export-to-workflow.md), [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md) (the instance-scoped approval cache a reseat re-primes), [ADR-0062](0062-context-compaction-and-cli-history-commands.md) (the `/clear` host-swap machinery + the `contextPreamble` a reseat must carry), [phase-2.6-conversational-authoring.md](../roadmap/phases/phase-2.6-conversational-authoring.md) (2.6.C), [architectural-principles.md](../standards/architectural-principles.md)

> **Proposed 2026-06-28 alongside the Phase 2.6 plan; Accepted 2026-07-06** and implemented as a 2.5.G follow-up
> (the in-chat `/models` reseat requested with the Phase-2.5 CLI-consolidation model work), pulling the ADR forward
> from 2.6.C. The reseat reuses the `/clear` host-swap machinery ([ADR-0062](0062-context-compaction-and-cli-history-commands.md) §7)
> and the `chat-resume` transcript path — zero engine change — exactly as designed below.
>
> **Note (2026-07-06): the FK reality behind the per-message `modelId`.** The Decision below says "only the CLI
> persister wiring is missing"; on implementation that proved under-specified. `session_messages.model_id` /
> `agent_sessions.model_id` are **foreign keys to `model_catalog.id` (a UUID row PK), not the raw model string** — and
> nothing populated them before this work (run history still leaves them NULL). Correct population needs a
> model-string → `model_catalog.id` resolution, degrading to a NULL "unknown" bucket when the model is not yet
> cataloged (the Decision anticipates this).
>
> **Note (2026-07-06, superseding the deferral): the attribution SHIPPED in 2.5.G Step D, not 2.6.C.** An earlier
> draft of the note above deferred the per-message/session `modelId` to 2.6.C; on maintainer direction it was
> implemented now instead. The persister resolves the failover-aware `cost:updated.model` (per assistant turn) and
> the bound model (per session) to their `model_catalog.id` via `catalogIdByModelId` (`@relavium/db`), writing the
> UUID or NULL — never a raw string (so the FK is never violated). The 2.6.C cost breakdown will now merely *read*
> the populated column. **Known limitation (low):** the resolution is by model STRING (ignoring provider), so a
> model id shared across two providers could mis-attribute to the other provider's catalog row; deferred as a
> latent edge (real model ids are globally unique; the FK stays valid either way).

## Context

An `AgentSession` binds one agent and one model for its lifetime — multi-agent/model orchestration is a
workflow concern, and the fallback plan is memoized ([ADR-0024](0024-agent-first-entry-point-agentsession.md)).
But users want `/models` to switch the bound model **mid-chat** (e.g. start on a cheap model, escalate to
a stronger one for a hard turn). This is distinct from a **mode** change, which stays on the same
instance with no reseat ([ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md)); a model change alters
the provider, the pricing, and the memoized plan, so it cannot be a flag flip. The risk is either
overstating what carries across the switch (the transcript is text-only) or churning the engine to
support in-place rebind.

## Decision

**We will switch models mid-session via a host-side "reseat" that reuses the existing `chat-resume`
machinery — no engine change — and explicitly disclose what it does not carry.** A mid-chat `/models`
reconstructs the transcript (`reconstructSessionState`) and starts a new `AgentSession.resume` bound to
the new model/provider, carrying the cumulative cost and turn count. The new instance memoizes a **fresh**
`#plan` for the chosen model (the old plan is discarded with the old instance): the picked model becomes
the primary, and the chain is built **exactly as `AgentSession.build()` builds one for a fresh session
bound to that model with no explicit `fallback_chain`** — i.e. the same default-plan helper, so a switch to
`claude-opus-4-8` yields the identical chain to starting a new session on it (a single-model chain if the
provider has no default). The original agent's `fallback_chain` is **not** carried across a model switch
(that chain belonged to the original model). Each
`AgentSession` instance still has exactly one model — so this **refines** (clarifies) ADR-0024's
one-model-per-lifetime rule rather than reversing it. We persist a per-message `modelId` with the model
that actually produced each message (failover-aware) — the `session_messages` schema already has the
(nullable) column; only the CLI persister wiring is missing — and show a per-model cost breakdown. Rows
written before this wiring (and any failover edge that leaves it unset) carry a **null** `modelId`; the
breakdown assigns those to an explicit `unknown` (pre-attribution) bucket rather than dropping them, so
legacy history is never silently lost from the totals. The reseat carries
the **text-only** transcript, so we surface an explicit notice — shared with the `chat-resume` family —
that prior tool calls and file contents are **not** carried to the new model; full-fidelity tool-context
(a persister + schema extension) is deferred to Phase 3.

Considered an in-place model rebind on the same instance (rejected: it fights the `#plan` memoization and
ADR-0024's lifetime invariant; reseat reuses proven, tested machinery with zero engine change); claiming
full context carries (rejected: false — the cross-turn transcript is text-only); and starting a fresh
session that drops history (rejected: poor UX — the user expects to continue).

## Consequences

### Positive

- Mid-chat model switching reusing the proven resume path; ADR-0024's invariant is honored, not broken;
  per-message model attribution makes the cost breakdown accurate.

### Negative

- Tool context (read files, tool results) is **not** carried across the switch — disclosed by an explicit
  notice; full fidelity is Phase 3.
- Each switch reconstructs the transcript (an `O(n)` cost on a long session) — acceptable for an
  interactive, user-initiated action; verified by the 2.6.C harness (a 200-message session reseats in well
  under the interactive budget).
- The per-tool approval once/always cache ([ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md)) is
  instance-scoped, so a reseat **re-prompts** for previously-approved tools — mildly friction in an
  author → escalate-model → run flow; accepted as the safe default (a new model is a new trust context).

### Neutral

- This **refines, not reverses**, [ADR-0024](0024-agent-first-entry-point-agentsession.md): each
  `AgentSession` instance still binds exactly one model for its lifetime; mid-session model switching is a
  host-side reseat (a new instance), not an in-place rebind. On acceptance (2026-07-06), ADR-0024 received a
  dated `> Amended` note + a Related forward-link to this ADR (documentation-style §7).
