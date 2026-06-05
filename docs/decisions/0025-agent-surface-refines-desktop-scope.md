# ADR-0025: The conversational agent surface — a refinement of ADR-0007's desktop scope

- **Status**: Accepted
- **Date**: 2026-06-05
- **Related**: [0007-desktop-is-not-an-ide.md](0007-desktop-is-not-an-ide.md), [0024-agent-first-entry-point-agentsession.md](0024-agent-first-entry-point-agentsession.md), [../product-constraints.md](../product-constraints.md), [../reference/desktop/routes-and-screens.md](../reference/desktop/routes-and-screens.md), [../architecture/agent-sessions.md](../architecture/agent-sessions.md)

## Context

[ADR-0007](0007-desktop-is-not-an-ide.md) settled that the desktop app is a **pure
agent-management center**, not an IDE: no code editor, no file browser, no integrated terminal —
code-adjacent work belongs to the VS Code extension. The agent-first pivot
([ADR-0024](0024-agent-first-entry-point-agentsession.md)) adds a conversational chat panel to the
desktop. This raises a fair question: does a chat panel re-open the "AI coding environment" door
that ADR-0007 deliberately closed?

It must not, and the boundary needs to be drawn precisely so future feature requests can be triaged
without re-litigating ADR-0007. This refines ADR-0007's scope; it does **not** reverse it.

## Decision

**Distinguish *agent capabilities* (in scope) from an *IDE shell* (out of scope).**

| In scope — agent capabilities | Out of scope — IDE shell (still forbidden) |
|---|---|
| A conversational **chat panel** (input + transcript + tool-call visualization) | A code **editor** / syntax-highlighted text buffer |
| The workflow **canvas** and run/cost **monitoring** | A **file browser** / project file tree |
| An agent **steering** affordance over a running node | An integrated **terminal** shell pane |

A chat panel is an **agent** capability, not an IDE feature: the user converses with an agent that
*itself* edits files through the same allowlisted, FS-scope-tiered tools a workflow agent uses — the
desktop never becomes the editor. **Chat and Canvas are co-equal top-level tabs**; the default
landing stays the neutral/operational home (the canvas remains the product's signature surface), so
this refinement does not demote the canvas or contradict
[routes-and-screens.md](../reference/desktop/routes-and-screens.md). The teeth that keep the chat
panel honest are the same as for workflows: `fs_scope = sandboxed` by default and an
empty-by-default command allowlist.

Considered: **(A)** treat any chat UI as an ADR-0007 violation — *rejected*: conflates conversing
with an agent (allowed) with embedding an editor (forbidden), and would block the whole pivot.
**(B)** supersede ADR-0007 — *rejected*: ADR-0007's no-editor / no-file-tree / no-terminal boundary
is fully intact and correct; this is a clarification, not a reversal, so per the
[append-only convention](README.md) ADR-0007 is **amended in place** with a dated pointer to this
ADR rather than superseded. **(C, chosen)** record the agent-capability-vs-IDE-shell line here and
forward-link it from ADR-0007.

## Consequences

### Positive

- A crisp, durable triage rule: "is this conversing with an agent, or is it an editor/file-tree/
  terminal?" — the same principled "no" ADR-0007 created, extended to the chat era.
- The desktop gains a first-class conversational surface without competing with VS Code on its turf.
- The canvas keeps its signature-surface status; agent-first is expressed by Chat being a peer tab,
  not by hijacking the landing screen.

### Negative

- The line will be tested by requests that sit near it (e.g. "show the file the agent just edited" —
  a read-only diff view is arguably agent feedback, an editable buffer is not); this ADR exists to
  adjudicate them rather than decide each ad hoc.
- A reviewer must check that desktop chat features stay on the agent-capability side of the table.
