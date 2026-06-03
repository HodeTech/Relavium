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

## Keys and secrets

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
- Keys are never interpolated into error messages or the `node:error` / `run:error`
  events (see [error-handling.md](error-handling.md)).

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

## Sandbox for `run_javascript`

- The `run_javascript` built-in tool executes **untrusted, model-generated code** and runs
  in a sandbox with **no ambient authority**: no filesystem, no network, no process/env,
  no keychain, and a CPU/memory/time budget that terminates a runaway. It never receives a
  provider key or any secret. Treat its output as untrusted input. See
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
handling, the `run_javascript` sandbox, prompt/tool-call construction, the DB encryption
path, or a new dependency. When in doubt, run the checklist.
