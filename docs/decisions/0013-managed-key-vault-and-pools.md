# ADR-0013: Managed-mode provider-key vault and key pools

- **Status**: Accepted
- **Date**: 2026-06-03
- **Related**: [0012-managed-inference-dual-mode.md](0012-managed-inference-dual-mode.md), [0006-os-keychain-for-api-keys.md](0006-os-keychain-for-api-keys.md), [0011-internal-llm-abstraction.md](0011-internal-llm-abstraction.md), [0015-managed-mode-data-handling-and-compliance.md](0015-managed-mode-data-handling-and-compliance.md), [../analysis/managed-inference-business-model-2026-06-03.md](../analysis/managed-inference-business-model-2026-06-03.md), [../tech-stack.md](../tech-stack.md)

## Context

Managed mode ([ADR-0012](0012-managed-inference-dual-mode.md)) calls LLM providers with **Relavium's own** provider keys from a server-side gateway, not the user's keys. This is a fundamentally different secret-handling problem from the one [ADR-0006](0006-os-keychain-for-api-keys.md) solved. ADR-0006 stores the *user's* keys in the *user's* OS keychain on the *user's* machine and explicitly scoped server-side provider keys out (it notes "Phase-2 cloud execution introduces a separate secret model … explicitly out of scope here"). This ADR fills exactly that gap for the managed gateway.

The constraints are tighter and the blast radius is larger. Relavium's keys are *organization-level* secrets shared across all managed-mode traffic: a leaked key is a direct financial liability for Relavium (not the user), and a single key hitting a provider org rate limit would throttle every managed user at once. Providers also enforce per-org rate and spend limits, so one key per provider does not scale. And per the non-negotiable rules ([CLAUDE.md](../../CLAUDE.md) rule 3), we **never hand-roll crypto** — we wrap vetted infrastructure.

## Decision

**Relavium's own provider keys live in a managed secrets manager / KMS, never in the per-tenant AES store and never in the OS keychain. The gateway draws from a key pool per provider, with zero-downtime rotation, 429-cooldown, and cross-provider fallback.**

- **Vault, not the per-tenant store.** Relavium's provider keys are held in a cloud KMS / secrets manager (e.g. a managed secrets service with envelope encryption and audited access), distinct from both the user-key OS keychain of [ADR-0006](0006-os-keychain-for-api-keys.md) and the per-tenant encrypted store used for BYOK-cloud. The gateway reads a key at call time with least-privilege access; keys never reach the engine, the frontend, logs, or job payloads (the same non-exposure rule BYOK keys follow). We **never hand-roll crypto** — the vault is vetted infrastructure we wrap, consistent with [ADR-0011](0011-internal-llm-abstraction.md)'s "only retain official/vetted third-party code for security-critical transport" stance.
- **Key pools.** Each provider has a *pool* of multiple keys, not a single key, so aggregate managed throughput exceeds any one org's rate/spend limit and load can be spread across keys (and, where applicable, across provider orgs/regions). The gateway selects from the pool per request.
- **Zero-downtime rotation.** Keys are versioned in the vault and rotated without a service interruption: a new key is added to the pool, traffic shifts to it, the old key is drained then retired. Rotation is routine (scheduled) and emergency (on suspected compromise), and is exercised by a runbook.
- **429-cooldown + cross-provider fallback.** A key that returns a rate-limit (429) or quota error is placed on a short cooldown and skipped by the selector until it recovers; if a whole provider is saturated or degraded, the gateway falls back across providers using the existing per-agent fallback-chain capability of [ADR-0011](0011-internal-llm-abstraction.md) — no new seam, the same normalized contract.

Considered options:

1. **One key per provider** — *rejected.* A single org's rate/spend limit caps all managed throughput; rotation means downtime; one 429 stalls everyone.
2. **Reuse the per-tenant AES key store** (the BYOK-cloud store) — *rejected.* That store is designed for *user* secrets under tenant isolation; Relavium's org-level master keys are a different trust tier and belong in a dedicated KMS/secrets manager with separate access policy and audit. ADR-0006 deliberately scoped this out.
3. **KMS/secrets-manager vault + key pools + rotation + cooldown/fallback** — *chosen.* Matches the org-level blast radius, scales past provider limits, and rotates without downtime.

This **complements [ADR-0006](0006-os-keychain-for-api-keys.md)** rather than superseding it: ADR-0006 governs the user's keys on the user's machine (Phase 1, BYOK), unchanged; this ADR governs Relavium's keys on Relavium's servers (Phase 2, managed). Both honor the same invariants — never plaintext, never to the frontend, never in logs, never hand-rolled crypto. Pinned infrastructure versions live in [tech-stack.md](../tech-stack.md). The full key-pool design and the rotation / pool-saturation / master-key-compromise runbooks are referenced from the managed-inference architecture doc.

## Consequences

### Positive

- Relavium's org-level provider secrets sit in vetted KMS/secrets-manager infrastructure with least-privilege, audited access — no hand-rolled crypto, consistent with [CLAUDE.md](../../CLAUDE.md) rule 3 and the secret-handling invariants of [ADR-0006](0006-os-keychain-for-api-keys.md).
- Key pools let aggregate managed throughput exceed any single provider org's rate/spend limit and spread load across keys/regions.
- Zero-downtime rotation makes both scheduled hygiene and emergency compromise-response non-disruptive.
- 429-cooldown plus cross-provider fallback (reusing the [ADR-0011](0011-internal-llm-abstraction.md) fallback chain) keeps managed mode resilient to per-key and per-provider rate limits with no change to the seam.
- Cleanly separates trust tiers: user keys ([ADR-0006](0006-os-keychain-for-api-keys.md)) and Relavium's org keys never share a store or an access policy.

### Negative

- A new piece of production secret infrastructure to operate, monitor, and secure — its compromise is a Relavium-wide financial and trust event. Mitigated by least-privilege access, audit logging, key-pool segmentation, fast rotation, and a master-key-compromise incident-response runbook.
- Key-pool selection, cooldown tracking, rotation orchestration, and cross-provider fallback are real engineering with correctness and concurrency risks (e.g. draining a key mid-stream); covered by tests and the pool-saturation runbook.
- Abuse runs under Relavium's provider account, so pool keys carry key-ban risk at the provider; bounded here by segmentation and rotation and addressed as an AUP/abuse concern in [ADR-0015](0015-managed-mode-data-handling-and-compliance.md).
- Operating org-level keys adds an attack surface and audit burden that simply does not exist for BYOK-local; accepted as the cost of offering managed convenience.
