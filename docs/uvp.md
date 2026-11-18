# Unique Value Proposition

- **Status**: Accepted
- **Related**: [vision.md](vision.md), [product-constraints.md](product-constraints.md), [analysis/README.md](analysis/README.md)

## Statement

> The only platform that lets any developer visually design, locally execute, and
> git-commit multi-model multi-agent workflows that run identically in their IDE,
> terminal, desktop canvas, and CI/CD pipeline — no cloud dependency, no vendor
> lock-in, no framework expertise required.

## Proof Points

1. **Every competitor owns at most two surfaces; Relavium owns all four**
   (desktop, VS Code, CLI, web). The **identical engine** runs on the three Phase-1
   **execution** surfaces — desktop, VS Code, and CLI — so a workflow behaves the
   same on each; the Phase-2 **web portal** is a browser **control-plane** surface
   (usage, quota, governance), not a fourth identical-engine runtime.
2. **No chat-driven assistant lets you keep — and ship — the conversation.**
   Relavium agent sessions are **persistent, resumable, and exportable**:
   auto-saved to durable local history (kept on your machine; API keys stay in
   the OS keychain — never in `history.db` or any plaintext store), resumable on any surface, and one-click
   exportable to a reviewable `.relavium.yaml` scaffold. Competitors' sessions
   evaporate; Relavium's become committable, re-runnable workflows. See
   [decisions/0024-agent-first-entry-point-agentsession.md](decisions/0024-agent-first-entry-point-agentsession.md)
   and [decisions/0026-session-export-to-workflow.md](decisions/0026-session-export-to-workflow.md).
3. **No competitor produces version-controllable workflow artifacts.** Relavium
   workflows are first-class git objects (`.relavium.yaml` in `.relavium/`).
4. **No competitor combines visual design + local execution + multi-model routing
   + multi-agent orchestration** in a single product.
5. **Workflow portability** means a workflow built by one developer runs unchanged
   in CI/CD — closing the gap between local AI use and automated pipelines that
   every other tool leaves open.
6. **BYOK-local mode means zero data leaves the machine — guaranteed,
   permanently.** In Relavium's first-class **BYOK-local ("Private mode")**, runs
   execute on the user's machine and LLM calls go straight to the providers under
   the user's own keys; nothing transits Relavium. This is a mode-scoped guarantee
   kept permanently non-degraded — a trust and compliance advantage no SaaS-first
   competitor can match. *(Phase 2 adds an opt-in **managed-inference** convenience
   mode that proxies LLM egress through Relavium's keys; BYOK-local always stays
   available for users who want the zero-egress guarantee. See
   [product-constraints.md](product-constraints.md) and
   [decisions/0012-managed-inference-dual-mode.md](decisions/0012-managed-inference-dual-mode.md).)*
7. **Convenience without lock-in (Phase 2, opt-in).** Managed inference lets users
   start with zero key setup, while BYOK-local remains a one-switch escape hatch —
   same product, your key — so the convenience never becomes lock-in.

## Positioning

Relavium is **two entry points on one engine**: a conversational coding agent
*and* a workflow-orchestration layer above the editor — not another editor. You
**start in chat** and **graduate to a committed workflow**; the same engine backs
both. The properties the product aims to combine are:

| Property | Relavium requirement |
|----------|----------------------|
| **Chat-first** | Persistent conversational coding sessions on each surface, exportable to a workflow. |
| **Visual** | A canvas with live execution on the node face. |
| **Git-native** | Diffable, reviewable workflow YAML. |
| **Multi-model** | Per-agent model choice and provider fallback. |
| **No lock-in** | Standard editor, terminal and git-host integration with local ownership. |

## Product framing

The differentiator is the conversation-to-workflow path on one engine, with
portable artifacts and explicit ownership of execution. These are Relavium's
requirements and direction; current delivery is tracked in the
[current roadmap](roadmap/current.md). External product comparisons were removed
at the maintainer's request on 2026-11-15.

## Two Entry Points, One Wedge

Relavium sits at **both** ends of a developer's flow. **Chat is the hook**: a
familiar, zero-setup conversational coding agent — the same surface developers
already reach for — is how they arrive, and typing `relavium` (the Home) is the fastest
path to first value. **The workflow file is the wedge**: because a workflow is a portable,
readable YAML file, the workflow file itself becomes the viral mechanic — a
developer shares a `.relavium.yaml`, a teammate runs it unchanged in their own
editor, terminal, or CI. The chat-to-workflow continuum is what connects them:
the moment a session proves a flow, exporting it to a committed workflow turns a
private conversation into shareable team infrastructure. Value scales with team
size — the workflow file is team infrastructure, not a personal preference. This
positioning underpins the go-to-market and pricing strategy (gate on
collaboration and scale, not on capability).

How this maps to adoption per segment — execution mode, key model, tier, and the
upgrade path for individuals, small teams, and enterprises — is detailed in
[deployment-models.md](deployment-models.md).
