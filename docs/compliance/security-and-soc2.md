# Security and SOC 2 — Master Keys, Abuse, Enterprise

- **Status**: Not started — precondition for managed mode (SOC 2 is a post-launch enterprise trajectory)
- **Phase**: Managed inference (Phase 2) only — **does not apply to BYOK-local**
- **Related**: [ADR-0012](../decisions/0012-managed-inference-dual-mode.md), [ADR-0013](../decisions/0013-managed-key-vault-and-pools.md), [ADR-0015](../decisions/0015-managed-mode-data-handling-and-compliance.md), [security-review.md](../standards/security-review.md), [provider-tos.md](provider-tos.md), [analysis §4, §5](../analysis/managed-inference-business-model-2026-06-03.md)

> **Phase 2 (managed).** These obligations exist because managed mode holds
> **Relavium's own** provider keys, runs **multi-tenant** infrastructure, and proxies
> traffic under Relavium's provider account. In BYOK-local the user's key stays in the OS
> keychain on their machine, there is no shared tenancy, and abuse runs under the user's
> own account — so **this file does not apply** to BYOK-local. The binding
> [security-review.md](../standards/security-review.md) checklist already governs BYOK
> key handling; this file is the *additional* managed-mode surface.

Managed mode introduces a security surface BYOK-local never had: Relavium now holds master
provider keys, separates many customers on shared infrastructure, and is the party a
provider holds responsible for abuse. Each item below is a precondition; SOC 2 Type II is
the enterprise trajectory that follows.

## Master-key handling

In managed mode Relavium holds its **own** provider keys (one or more per provider) — the
"master keys" that back every managed customer. Compromise of one is a far larger blast
radius than a single user's BYOK key.

- **Vault + key pools.** Master keys live in a KMS-backed vault, organized as **pools**
  (multiple keys per provider for org-level rate limits, zero-downtime rotation,
  429-cooldown and cross-provider fallback). The canonical decision is
  [ADR-0013](../decisions/0013-managed-key-vault-and-pools.md).
- **Never hand-roll the crypto.** Per [security-review.md](../standards/security-review.md),
  Relavium uses vetted KMS / platform crypto and wraps it — it never implements key
  storage or encryption primitives itself.
- **Keys never reach the client.** The same rule as BYOK applies and is stricter here: a
  master key never enters an IPC payload, a frontend store, a log, or a job payload. The
  gateway attaches the key to the outbound HTTPS request and nowhere else.
- **Segregate keys per provider/region** so a ban or rotation on one does not cascade, and
  so EU-region traffic uses EU-region keys (see [data-protection.md](data-protection.md)).
- **Master-key-compromise is an incident-response scenario** (rotate the pool, revoke,
  re-key) — a runbook is carried forward from
  [ADR-0012's docs-to-change list](../decisions/0012-managed-inference-dual-mode.md).

## Multi-tenant isolation

Managed mode is multi-tenant: many customers' usage, credits, and metering live in the
same Postgres. Isolation is a correctness, billing-integrity, and compliance requirement.

- **Row-level security (RLS)** so one tenant can never read or meter against another's
  rows.
- **Per-tenant metering and quota** — `usage_event` and credit balances are keyed per
  tenant, with **idempotent metering** (reserve→settle on a UNIQUE `request_id`) so a
  retry cannot double-bill or cross tenants
  ([ADR-0014](../decisions/0014-managed-metering-quota-and-billing.md)).
- **No content stored by default** — metering records token counts, not prompts
  ([data-protection.md](data-protection.md)), shrinking the multi-tenant data at risk.

## Abuse, the AUP, and moderation liability — the key-ban risk

This is the sharpest managed-mode risk. **Abuse by a managed customer runs under
Relavium's own provider account.** A provider can suspend that account for one customer's
violation, taking **every** managed customer offline at once
([analysis risk R3](../analysis/managed-inference-business-model-2026-06-03.md)).

- **An Acceptable Use Policy (AUP).** A published AUP binds managed customers and mirrors
  the providers' own usage policies — what Relavium forbids is at least what its providers
  forbid, because Relavium is liable for it under [provider-tos.md](provider-tos.md).
- **Moderation / disclosure duties.** Some providers (notably OpenAI) impose explicit
  moderation and disclosure obligations on products built on their API
  ([provider-tos.md](provider-tos.md)). Relavium must meet them.
- **Abuse detection + per-account caps.** Anomaly detection on usage, per-account and
  per-day budgets (already a margin guardrail in
  [ADR-0012](../decisions/0012-managed-inference-dual-mode.md)) double as abuse limits.
- **A kill switch.** The ability to instantly cut off an abusing tenant — before the
  provider cuts off Relavium.
- **Provider/region key segregation + multi-provider redundancy** so a ban on one account
  does not take down the whole service.

These controls protect the [R1 clearance](provider-tos.md): the agreements that permit
managed mode assume Relavium polices abuse under them.

## SOC 2 Type II — the enterprise trajectory

> **Required for enterprise sales, not for launch.** SOC 2 Type II is a **post-launch
> trajectory** with a **6–12 month runway**, because Type II attests controls operating
> *over a period of time*. It is the compliance asset enterprise buyers ask for; it is not
> a gate on shipping managed mode to individual/team customers.

- **What it evidences:** that the controls above (master-key handling, multi-tenant
  isolation, abuse controls, change management, monitoring, the
  [no-prompt-logging](data-protection.md) stance) operate consistently over the audit
  period.
- **Why it matters:** enterprise is the [ADR-0012](../decisions/0012-managed-inference-dual-mode.md)
  path where BYOK + a SOC 2 report together answer the "don't trust you in the data path"
  objection.
- **Plan the runway early:** because it measures a period, the controls must be in place
  and operating *before* the audit window starts — so the work begins well ahead of the
  first enterprise deal.

## Gate summary

Security controls (master-key vault/pools, multi-tenant isolation, AUP + abuse + kill
switch) are **launch-blocking for managed mode**; SOC 2 Type II is the **enterprise
trajectory** that follows. Both are tracked in the
[compliance gate status table](README.md#gate-status). All of it is **managed-mode only —
BYOK-local ships without any of it**, governed solely by the existing
[security-review.md](../standards/security-review.md) checklist.
