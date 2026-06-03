# Security Review

- **Status**: Accepted
- **Date**: 2026-06-03
- **Related**: [architectural-principles.md](architectural-principles.md), [error-handling.md](error-handling.md), [logging-and-observability.md](logging-and-observability.md), [code-review.md](code-review.md)

The binding security checklist for Relavium. Security is
[first-class, not an afterthought](architectural-principles.md#9-build-in-house-minimize-third-party-dependencies),
and [secrets never touch disk or the frontend](architectural-principles.md#6-secrets-never-touch-disk-or-the-frontend).
Any change touching the items below gets this checklist applied in
[code review](code-review.md). The canonical secret-handling flow lives in
[keychain-and-secrets.md](../reference/desktop/keychain-and-secrets.md) and is cited, not
restated, here.

## Keys and secrets (BYOK-local)

This section covers **BYOK-local** secret handling — the user's own provider keys on
the user's machine. It is **one of three** key-custody models. The canonical home for
all three — BYOK-local (OS keychain), BYOK-central (AES-256-GCM Postgres org vault), and
managed (KMS-backed key pools) — is
[key-management.md](../architecture/key-management.md); the managed model's security
surface is covered in [Managed mode (Phase 2)](#managed-mode-phase-2) below.

- **API keys live in the OS keychain** (macOS Keychain / Windows Credential Manager /
  libsecret), resolved by the backend at call time and attached by the
  `@relavium/llm` adapter just before the HTTPS request. See
  [ADR-0006](../decisions/0006-os-keychain-for-api-keys.md).
- **Keys never leave the keychain boundary and never reach the frontend.** No key in a
  Tauri IPC payload to the WebView, no key in a Zustand store, no key in a React prop, no
  key in localStorage, no key returned from an IPC command. The frontend learns *that* a
  provider is configured, never its secret.
- **No plaintext at rest.** No key in a config file, `.env` committed to git,
  `.relavium.yaml`, a log, or the SQLite DB unencrypted (the local DB is SQLCipher;
  secrets still belong in the keychain, not a DB column).
- Keys are never interpolated into error messages or the `node:failed` / `run:failed`
  events (see [error-handling.md](error-handling.md)).

## Managed mode (Phase 2)

Managed mode puts **Relavium's own provider keys** in the data path and proxies LLM
egress through Relavium's gateway, with metering and billing. This is a distinct security
surface from BYOK-local: the secrets are Relavium's, not the user's, and the gateway is
multi-tenant. BYOK-local is the only default; managed is opt-in (see
[product-constraints.md](../product-constraints.md)). Canonical homes are cited, not
restated, here.

- **Master key vault + per-provider key pools.** Relavium's master keys live in a
  KMS-backed vault and are issued to requests from **per-provider key pools** — never
  hard-coded, never in a config file, never in the SQLite/Postgres app schema as
  plaintext. See [ADR-0013](../decisions/0013-managed-key-vault-and-pools.md) and
  [managed-inference.md](../architecture/managed-inference.md).
- **No prompt logging by default — meter token counts, not content.** The metering path
  records token counts and usage metadata, **not** prompt or completion bodies. Prompt/
  response content is not logged, not persisted, and not retained by default. See
  [ADR-0015](../decisions/0015-managed-mode-data-handling-and-compliance.md).
- **Audit every key-leak surface.** None of these may ever contain a provider key or a
  prompt body: the **vault at rest**, the **gateway request path**, **metering rows**,
  **billing payloads**, and the **usage dashboard**. A review must trace data through each
  and confirm no key material and no prompt content lands there.
- **No Relavium/managed key crosses the `LLMProvider` seam.** A managed provider key is
  attached inside the gateway, on the outbound HTTPS request to the upstream provider only.
  It must never flow back across the `LLMProvider` interface toward the engine, IPC, the
  frontend, a store, a log, or a tool — same boundary discipline as a BYOK key, applied to
  Relavium's secret.
- **Gateway authn/z, per-account caps, and the kill switch.** Every gateway request is
  authenticated and authorized to a managed account; per-account usage caps are enforced;
  and the abuse **kill switch** can immediately cut off an account (see
  [ADR-0014](../decisions/0014-managed-metering-quota-and-billing.md)). A request that
  fails authn/z or exceeds its cap is rejected before any managed key is selected.
- **Multi-tenant isolation.** Tenant data is scoped by `org_id` and enforced with
  row-level security (RLS) so one account can never read another's keys, metering, or
  billing rows.

## Network and custom base URLs

- **SSRF on custom base URLs.** DeepSeek (and any OpenAI-compatible provider) is reached
  via a user-supplied `baseURL`. Validate it: HTTPS only, reject non-HTTP(S) schemes and
  credentials-in-URL, and **block private/loopback/link-local/metadata ranges**
  (`127.0.0.0/8`, `::1`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` incl. the cloud
  metadata IP `169.254.169.254`) unless the user has explicitly opted into a local
  endpoint. Never let an agent-config URL cause the engine to call an internal address
  with a real key attached.
- All provider calls are HTTPS; we do not disable TLS verification.
- Outbound requests carry the AbortSignal and a timeout; a hung provider must not pin a
  worker open.

## Sandbox for `run_command`

- The `run_command` built-in tool spawns **model-driven shell execution** and runs
  sandboxed: only commands on the workflow's `allowedCommands` allowlist execute (an
  unlisted command never runs), under the workflow's filesystem **scope tier** (restricted
  fs — no reach outside the granted paths), with **no network** authority beyond what an
  allowed command itself performs, and a CPU/memory/time budget that terminates a runaway.
  It never receives a provider key or any secret. Treat its output (stdout/stderr/exit code)
  as untrusted input. See
  [built-in-tools.md](../reference/shared-core/built-in-tools.md) for the canonical tool
  contract.

## Prompt-injection posture

- Model output and tool results are **untrusted data**, never trusted instructions. Tool
  calls the model requests are validated against the declared tool schema and the user's
  configured tool allowlist before execution — a model cannot invoke a tool it was not
  granted, and arguments are schema-checked, not eval'd.
- High-impact tool effects (filesystem writes, shell, external calls) route through the
  workflow's human-gate / approval path rather than firing on the model's say-so. Injected
  text in a fetched document or prior tool result cannot silently escalate privilege.
- We do not concatenate untrusted content into a position where it can override the system
  prompt; the `system` field is set by Relavium, not by tool output.

## Never hand-roll crypto

- We **never implement cryptography, TLS, or keychain primitives ourselves**. We use vetted
  platform implementations (the OS keychain, platform AES-256-GCM, the runtime's TLS) and
  wrap them tightly behind a Relavium interface. This is the explicit carve-out in the
  [build-in-house principle](architectural-principles.md#9-build-in-house-minimize-third-party-dependencies):
  own the product layers, never the crypto. A PR that rolls its own crypto is rejected.

## Dependency and supply chain

- A new third-party dependency is a new attack surface and requires an
  [ADR](../decisions/README.md) and review sign-off ([code-review.md](code-review.md)).
- The lockfile is committed; dependency advisories are watched and a known-CVE dependency
  is not knowingly shipped.

## Logging

No secrets, no full prompts/responses, and no raw keys in logs — ever. Logging redaction
rules live in [logging-and-observability.md](logging-and-observability.md).

## When a review is mandatory

Any change to: key handling or the keychain bridge, IPC commands, provider base-URL
handling, the `run_command` sandbox, prompt/tool-call construction, the DB encryption
path, or a new dependency. For **managed mode**, also: the gateway authn/z path, key-pool
selection, the metering/billing path, and the master-key vault. When in doubt, run the
checklist.
