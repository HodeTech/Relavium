# ADR-0026: Session export to workflow YAML — the chat-to-workflow continuum

- **Status**: Accepted
- **Date**: 2026-06-05
- **Related**: [0024-agent-first-entry-point-agentsession.md](0024-agent-first-entry-point-agentsession.md), [0008-local-first-phase-1-cloud-phase-2.md](0008-local-first-phase-1-cloud-phase-2.md), [0009-git-native-workflow-yaml.md](0009-git-native-workflow-yaml.md), [../reference/contracts/agent-session-spec.md](../reference/contracts/agent-session-spec.md), [../reference/contracts/workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md)

## Context

The agent-first pivot ([ADR-0024](0024-agent-first-entry-point-agentsession.md)) makes a chat
`AgentSession` a first-class entry point. The pivot's strategic value is the **continuum**: a
throwaway conversation in any other tool stays throwaway, but in Relavium a high-value session can
**graduate** into a reusable, git-committable, CI-runnable workflow. That graduation needs a defined
export. The question is what the exported `.relavium.yaml` actually contains — and how much fidelity
to promise — without over-claiming an automatic "conversation → optimal DAG" compiler we cannot
honestly deliver.

## Decision

**An `AgentSession` can be explicitly exported to a `.relavium.yaml` workflow, producing a
human-reviewed scaffold — a linear chain of agent nodes plus the full conversation preserved as YAML
metadata — never an auto-inferred parallel/conditional/looping graph.**

- The export reconstructs the session's agent turns as a **linear sequence of `agent` nodes** in the
  order they occurred, carrying the agent binding, the resolved prompts, and the tools that were
  used.
- The **complete transcript is preserved as comments/metadata** so the authored file is
  self-documenting and the human can see exactly what the agent did.
- Export is an **explicit, user-initiated action presented for review before commit** — it is never
  silent and never auto-commits. It produces a *starting scaffold* the author then refines on the
  canvas (adding parallelism, conditions, gates).
- The export **produces** the format owned by
  [workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md); it does **not** redefine it.
  The export contract (what maps to what) has its single home in
  [agent-session-spec.md](../reference/contracts/agent-session-spec.md).

Considered: **(A)** best-effort DAG reconstruction (infer parallel/conditional structure from the
tool-call sequence) — *rejected for v1*: brittle, surprising, and over-promises; a wrong graph is
worse than an honest linear one. **(B)** a single orchestrator node that replays the transcript —
*rejected*: faithful but opaque and not a "designed" graph the user can evolve. **(C)** transcript as
comments only, no nodes — *rejected*: makes the user rebuild everything. **(D, chosen)** the
linear-chain-plus-transcript hybrid with mandatory review, positioned in the product as a
**"scaffold"**, not a finished workflow. Because the output is git-native YAML
([ADR-0009](0009-git-native-workflow-yaml.md)) it is reviewable and diffable like any authored
workflow, and the whole flow stays local-first ([ADR-0008](0008-local-first-phase-1-cloud-phase-2.md)).

## Consequences

### Positive

- Closes the continuum loop with an honest, predictable artifact users can read and trust.
- Reuses the existing YAML contract and review/commit flow — no new authored format.
- Sets a clean forward path: richer reconstruction (parallel/condition inference) can be a later,
  opt-in enhancement without changing the v1 promise.

### Negative

- The scaffold is linear; users who chatted through inherently parallel work must add the structure
  themselves on the canvas (mitigated by positioning it as a scaffold + the preserved transcript).
- The transcript-as-metadata must obey the secret rules — a `secret`-typed value must never be
  serialized into the exported file ([ADR-0029](0029-tool-policy-hardening.md) forbids secret
  interpolation into agent text in the first place).
