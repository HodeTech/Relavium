# Product Constraints

- **Status**: Binding
- **Related**: [vision.md](vision.md), [roadmap/README.md](roadmap/README.md), [tech-stack.md](tech-stack.md)

These are the hard, user-defined boundaries for Relavium. They override
convenience and feature pressure. When a proposed feature conflicts with a
constraint here, the constraint wins.

## Hard Constraints

### The desktop app is NOT an IDE

The desktop app is a pure **agent-management center**. Its scope is exactly:

- Workflow canvas design
- Agent creation and configuration
- Run monitoring and history
- Provider / API key management
- Cost tracking

It does **not** have a code editor, a file browser, or a terminal. That is the
VS Code extension's job. When suggesting features for the desktop app, keep them
within agent-management scope; code-editing ideas belong to the VS Code
extension.

### Local-first in Phase 1

No cloud dependency. No account required to use the product. Agents run on the
user's machine and, **in BYOK-local mode**, API calls go directly from the
user's machine to the LLM providers under the user's own keys. This is the Phase-1
default and ships unchanged. See the execution model in [vision.md](vision.md).

### Privacy is a permanently-supported mode, not the universal headline

**BYOK-local ("Private mode")** — the user's own keys, calls straight to the
providers, zero LLM data through Relavium — is a **first-class execution mode that
is kept permanently supported and non-degraded**. It is the Phase-1 default and
remains the heavy-user / enterprise / trust lane forever. What changes in Phase 2
is only that privacy stops being the *universal* headline: a third **`managed`**
mode (Relavium's keys, LLM egress proxied through Relavium's gateway) is offered as
an **opt-in convenience mode** for users who would rather not manage keys. The
privacy guarantee is therefore **mode-scoped** (it holds in BYOK-local/cloud,
not in managed), never silently weakened. See
[decisions/0012-managed-inference-dual-mode.md](decisions/0012-managed-inference-dual-mode.md)
and [analysis/managed-inference-business-model-2026-06-03.md](analysis/managed-inference-business-model-2026-06-03.md).

### BYOK-local stays first-class and non-degraded — permanently

Adding managed inference must **never** degrade, paywall behind it, or
second-class the BYOK-local mode. BYOK-local is the higher-margin core business
and the trust proof; it remains a complete, fully-supported path on every surface
in every phase. Managed inference is *additive convenience*, not a replacement.

How each customer segment adopts these modes and tiers end-to-end — and why no
segment is ever forced into managed — is mapped in
[deployment-models.md](deployment-models.md).

### Cloud execution is Phase 2

Do not design Phase 1 to require the cloud. The engine architecture must support
local (Phase 1) plus cloud and managed (both Phase 2) modes via a clean interface
switch, so that Phase 2 adds layers without breaking Phase 1 surfaces. See [roadmap/README.md](roadmap/README.md).

> **Managed inference is a separate Phase-2 capability from cloud execution.**
> Managed inference proxies only **LLM egress** through Relavium's keys/gateway —
> the engine still runs **locally**. It is the *first* Phase-2 deliverable and is
> decoupled from (and ships ahead of) the cloud-execution worker plane. See
> [decisions/0012-managed-inference-dual-mode.md](decisions/0012-managed-inference-dual-mode.md).

### Workflow files are git-native

`.relavium/*.relavium.yaml` files are first-class artifacts — designed to be
committed, PR'd, code-reviewed, and version-controlled. The schema is a public
API from day one; breaking changes require a migration path so users'
git-committed workflows do not silently break.

## Explicit MVP Out-of-Scope

The following are explicitly **not** part of the Phase 1 MVP:

| Out of scope (MVP) | Why / where it lands |
|--------------------|----------------------|
| Multi-user / team features | Phase 2 (cloud + portal) |
| Billing / subscription | Phase 2 — **metered managed-inference billing is the Phase-2 commercial centerpiece** (prepaid credits + hard included-usage cap + metered overage + cheap-default routing; BYOK stays unlimited). See [decisions/0014-managed-metering-quota-and-billing.md](decisions/0014-managed-metering-quota-and-billing.md). |
| Ollama / local models | API-based providers only for MVP |
| Cloud execution queue | Phase 2 (BullMQ + Redis) |
| Web portal | Phase 2 |
| Automatic cloud firing of scheduled / webhook triggers | Phase 2 — auto-fire needs an always-on cloud listener; the trigger *types* are still declarable in Phase 1 (see note and [ideas/scheduled-and-webhook-triggers.md](ideas/scheduled-and-webhook-triggers.md)) |
| OAuth | Portal uses email + password only at first |

> The `manual` and `file_change` triggers fire automatically in Phase 1. The
> `webhook` and `schedule` trigger *types* are declarable in YAML in Phase 1 and
> are honored when the workflow is invoked manually or by a user-run watcher;
> only **automatic cloud-hosted firing** (an always-on HTTP listener / cron
> scheduler) is deferred to Phase 2. See
> [reference/contracts/workflow-yaml-spec.md](reference/contracts/workflow-yaml-spec.md).

## Phase-2 preconditions for managed inference

Managed inference puts Relavium in the data path and on the hook for billing, so
two hard gates are **launch-blocking preconditions** — managed mode may not ship
until both are cleared:

- **Provider-ToS confirmation (gate R1).** Written confirmation / the appropriate
  commercial or partner agreement from **each** provider that "Relavium holds the
  key, customers consume metered usage under Relavium's account, Relavium keeps
  margin" is permitted. Getting this wrong at scale is account termination, not a
  fine.
- **Merchant-of-record.** A merchant-of-record (e.g. Paddle / Lemon Squeezy) must
  be in place to absorb VAT / sales-tax across jurisdictions, plus chargebacks and
  disputes, before any metered charge is taken.

A KVKK + GDPR / data-residency posture (DPA + sub-processor list, cross-border
transfer handling, no-prompt-logging-by-default) is the third precondition. These
gates apply **only to managed mode**; BYOK-local/cloud are unaffected. See
[decisions/0012-managed-inference-dual-mode.md](decisions/0012-managed-inference-dual-mode.md),
[decisions/0015-managed-mode-data-handling-and-compliance.md](decisions/0015-managed-mode-data-handling-and-compliance.md),
the [compliance/](compliance/) area, and
[analysis/managed-inference-business-model-2026-06-03.md](analysis/managed-inference-business-model-2026-06-03.md).

## Rationale

The user explicitly confirmed that the desktop app is an application for
*managing agents* — no separate IDE, agent-management focus only. Every scope
decision above flows from that intent: keep the desktop surface focused, ship a
trustworthy local-first product first, and earn the cloud layer with real usage
data rather than building it speculatively.
