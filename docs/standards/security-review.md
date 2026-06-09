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
  libsecret) and are attached just before the HTTPS request — but *where* the raw key
  is read and attached is host-specific. On the **desktop**, the egress is delegated to
  Rust: the `llm_stream` command reads the key from the keychain and attaches the
  `Authorization` header inside Rust; the WebView-resident `@relavium/llm` adapter holds
  only a key *reference* and never sees the raw key. On **Node-style hosts** (CLI, VS
  Code extension host, Phase-2 Bun API) the adapter resolves the key and attaches it
  in-process, within the one trusted process. See
  [ADR-0006](../decisions/0006-os-keychain-for-api-keys.md) and
  [ADR-0018](../decisions/0018-desktop-execution-and-rust-egress.md).
- **Keys never leave the keychain boundary and never reach the frontend.** No key in a
  Tauri IPC payload to the WebView, no key in a Zustand store, no key in a React prop, no
  key in localStorage, no key returned from an IPC command. The frontend learns *that* a
  provider is configured, never its secret.
- **No plaintext at rest.** No key in a config file, `.env` committed to git,
  `.relavium.yaml`, a log, or the SQLite DB unencrypted (the local DB is SQLCipher;
  secrets still belong in the keychain, not a DB column).
- Keys are never interpolated into error messages, the normalized `LlmError` (`.message` / `.code`), or
  the `node:failed` / `run:failed` events (see [error-handling.md](error-handling.md)). **This is a
  positive, *tested* obligation, not only a prohibition:** the `@relavium/llm` **per-adapter adapter tests**
  (each plants a secret in a vendor error and asserts the surfaced `LlmError` is secret-free), plus
  `llm-error.test.ts` for the shared `makeLlmError`→`scrubSecrets` backstop, assert that the resulting
  `message`/`code` is **secret-free** — no API key, no credentials-in-URL, no auth header, no token (a
  public endpoint URL is not itself a secret; a declared-but-untested "already
  redacted" invariant is a future leak). A secret that was *sent* (in a header, query string, or URL) must
  likewise be redacted from any provider response/error body before it reaches a log.
- **Audit the desktop Rust-delegated egress path.** On the desktop the LLM egress is a
  Rust command (`llm_stream`) that streams normalized chunks back over a
  `Channel<StreamChunk>` ([ADR-0018](../decisions/0018-desktop-execution-and-rust-egress.md),
  [ipc-contract.md](../reference/contracts/ipc-contract.md)). This is a sensitive IPC
  surface: a review must confirm the WebView passes only a key *reference*
  (`{ providerId, keyId }`), never the raw key; that the raw key is resolved and the
  `Authorization` header attached **only inside Rust** and is never persisted or logged;
  that the `Channel<StreamChunk>` carries **no secrets** (only provider response chunks);
  and that cancellation (the `AbortSignal`) aborts the Rust request cleanly without
  leaking key material.

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

## Chat mode (`AgentSession`) and security scope

A conversational [`AgentSession`](../reference/contracts/agent-session-spec.md) is a
first-class engine entry point ([ADR-0024](../decisions/0024-agent-first-entry-point-agentsession.md)),
not a separate trust domain. It runs on the **same** substrate and therefore inherits this
entire checklist with **no chat-specific exception**: provider keys stay in the keychain
and are attached exactly as above (the chat surface holds only a key reference), the
session runs under the same filesystem **scope tier**, `run_command` uses the same
`allowedCommands` allowlist (exact-match, below), and no secret ever reaches the frontend.
A chat-only relaxation of any rule here is a security violation, not a feature.

- **Conversational content is the user's data, not a managed secret.** What the user types
  into a session and the model's replies are persisted **encrypted in `history.db`**
  (SQLCipher) — that is user data under the user's control, not a key-custody concern, and
  it is **not** a violation of
  [secrets-never-touch-the-frontend](architectural-principles.md#6-secrets-never-touch-disk-or-the-frontend).
- **The real leak is a `secret`-typed input in a prompt.** non-negotiable #6 targets
  *managed* secrets — keychain keys and `secret`-typed inputs — which live below the seam
  and must never enter message history. The P0 leak closed by
  [ADR-0029](../decisions/0029-tool-policy-hardening.md) is a `secret`-typed **input
  interpolated into a prompt** (event-payload masking does not save you once it is in the
  prompt body); see the parse-time rejection rule under
  [Sandbox and tool policy](#sandbox-and-tool-policy-run_command-node-tools-secret-inputs).

## Network and outbound URLs (SSRF — three egress paths today, a fourth reserved)

There are **three** user-supplied outbound-URL paths today (a fourth — the multimodal media `url`
carrier — is forward-looking; see the last bullet), and they share **one** vetted
SSRF range-primitive — never a second hand-rolled parser. The same validation
(HTTPS only, reject non-HTTP(S) schemes and credentials-in-URL, and **block
private/loopback/link-local/metadata ranges** — `127.0.0.0/8`, `::1`, `10/8`,
`172.16/12`, `192.168/16`, `100.64/10` (CGNAT), `169.254/16` incl. the cloud metadata IP `169.254.169.254`,
unless the user has explicitly opted into a local endpoint) applies to all three:

- **Provider `baseURL`.** DeepSeek (and any OpenAI-compatible provider) is reached via a
  user-supplied `baseURL`. Never let an agent-config URL cause the engine to call an
  internal address with a real key attached.
- **The `http_request` tool.** *(Security tightening — ADR-0029(d), a public
  workflow-API tightening: cheap now, no workflow exists yet.)* Model-driven outbound HTTP
  runs the same range-block; in addition it is **HTTPS-only with exact-FQDN matching**
  against the tool's `allowedDomains`, and an **empty or absent `allowedDomains` ⇒
  deny-all** (symmetry with `run_command`'s `allowedCommands` "empty ⇒ disabled"). It
  carries no provider key or secret. `built-in-tools.md` stays a one-line pointer to this
  binding rule — not a second home. See
  [ADR-0029](../decisions/0029-tool-policy-hardening.md) and
  [built-in-tools.md](../reference/shared-core/built-in-tools.md).
- **MCP server URLs.** *(Security tightening — ADR-0029(d).)* An MCP `sse`/`websocket`
  server URL is a second egress path that **injects secrets** into headers, so leaving it
  scheme-checked-only while hardening `http_request` would be strictly worse. MCP server
  URLs run the **same** SSRF range-primitive (no second parser). See
  [mcp-integration.md](../reference/shared-core/mcp-integration.md) for the MCP contract
  and [ADR-0029](../decisions/0029-tool-policy-hardening.md) for the rationale.
- **Media `url` carrier (multimodal — [ADR-0031](../decisions/0031-llm-seam-shape-amendment-multimodal-io.md) A7) — a fourth path, forward-looking.**
  A media `url` source (a user-supplied input URL or a provider-returned output URL) is fetched by the
  **engine** (never an adapter), through this **same** range-primitive — no second parser. It ships
  **feature-flag-OFF** until the one shared primitive lands. *(Not yet built; recorded here so it binds to
  the same primitive when it does.)*
- All provider calls are HTTPS; we do not disable TLS verification. *(Per-host/per-provider TLS granularity
  is a deferred draft-proposal, not a current rule — see [deferred-tasks.md](../roadmap/deferred-tasks.md);
  the global never-disable stance holds until a private-CA self-hosted consumer needs an opt-IN behind a
  fresh ADR.)*
- Outbound requests carry the AbortSignal and a timeout; a hung provider must not pin a
  worker open.

## Media byte delivery (`read_media`, Range, upload)

Media artifacts are served back to a surface (e.g. the desktop WebView) only through the **one bounded
`read_media(ref)` gate** ([ADR-0032](../decisions/0032-desktop-rust-media-de-inline-amends-0018.md)) — never
a second raw static-file mount, and **never with symlink-following on**. A review of any byte-delivery or
upload surface must confirm:

- **Range/offset is validated, fail-closed.** A `Range`/offset is rejected if negative, reversed
  (`end < start`), or out of bounds against the known `byteLength` — a raw `parseInt` with no bound check is
  a concrete DoS / out-of-bounds-read surface. Serve only the validated window; never trust a client-supplied
  size.
- **Bodies stream and are size-bounded.** Neither a download nor an upload reads the whole body into memory;
  delivery streams from the store and an upload enforces a maximum size — bytes never buffer fully in the
  engine/process (the de-inline + handle discipline of
  [ADR-0031](../decisions/0031-llm-seam-shape-amendment-multimodal-io.md)/[ADR-0032](../decisions/0032-desktop-rust-media-de-inline-amends-0018.md)).
- **`read_media` is session-scoped** (the scope-set authz of ADR-0031/0032): a session may read only a handle
  it produced or explicitly received — "know a sha256" is not authorization. The Rust CAS / file layer
  resolves paths with `realpath` + `commonpath` **fail-closed** (no path-traversal; symlinks off).

*(Not yet built — these are binding acceptance criteria for the `read_media` / Rust-CAS workstreams,
1.AF/1.AH.)*

## Sandbox and tool policy (`run_command`, node tools, secret inputs)

This is the **binding home** for the tool-policy rules; the rationale is
[ADR-0029](../decisions/0029-tool-policy-hardening.md) and the authored fields live in
[built-in-tools.md](../reference/shared-core/built-in-tools.md) and
[workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md) (cited, not
restated). Three of the four rules below are **security tightenings** — public
workflow-API tightenings, cheap now because no workflow exists yet, never sold as additive.

- The `run_command` built-in tool spawns **model-driven shell execution** and runs
  sandboxed: only commands on the workflow's `allowedCommands` allowlist execute (an
  unlisted command never runs), under the workflow's filesystem **scope tier** (restricted
  fs — no reach outside the granted paths), with **no network** authority beyond what an
  allowed command itself performs, and a CPU/memory/time budget that terminates a runaway.
  It never receives a provider key or any secret. Treat its output (stdout/stderr/exit code)
  as untrusted input.
- **`run_command` matches exactly by default.** *(Security tightening — ADR-0029(a).)* An
  `allowedCommands` entry is matched **exactly** against the resolved command — not as a
  prefix or substring — so `git` does not authorize `git push --force` or `gitleaks`.
  Glob/wildcard matching is **opt-in** via `allowedCommandGlobs`; the plain list is
  exact-only.
- **Node `tools:` narrow-only, never escalate.** *(Security tightening — ADR-0029(b).)* A
  workflow agent-node's `tools:` may only **restrict** the agent's granted toolset, never
  add to it. A node listing a tool the agent was not granted is a **parse/validation
  error** (validator-enforced, bound to [ADR-0023](../decisions/0023-strict-authored-yaml-validation.md)),
  so a node can never silently widen a tool grant.
- **`secret`-typed inputs never interpolate into prompts or tool text.** *(Security
  tightening — ADR-0029(c); this closes the real P0 leak.)* A `secret`-typed input may feed
  **only** credential/header fields (e.g. an auth header), and is **rejected at parse** from
  `prompt_template` or any tool argument text — **transitively** (taint-tracked through `context`
  entries and any derived value, so it cannot be laundered through an intermediate variable).
  Event-payload masking is not enough on its
  own — a secret interpolated into a prompt has already left the boundary before any mask
  applies. The user's own conversational content in a chat session is the user's data
  (encrypted in `history.db`), **not** a managed secret; the leak this rule closes is a
  `secret`-typed *input* reaching prompt/tool text.

### Expression sandbox (`condition` / `transform` / `merge_fn`)

`condition`, `transform`, and a custom `merge_fn` evaluate author-supplied JavaScript. Per
[ADR-0027](../decisions/0027-expression-sandbox.md) the sandbox is **security-sensitive** (rule #3:
never hand-roll a security primitive; rule #2: a new runtime dependency needs an ADR) and these are
**binding** invariants a review must confirm:

- **QuickJS-wasm, instantiated only via the standard `WebAssembly` global from embedded wasm bytes.**
  Never loaded via `node:fs`, `fetch`, or the DOM — that would break `@relavium/core`'s zero
  platform-specific imports ([ADR-0003](../decisions/0003-pure-ts-engine-not-langgraph-python.md)).
  `new Function()` / `eval` / the Node `vm` module are **forbidden** (none is a security boundary).
- **No ambient globals, no I/O.** Only an explicit, audited allow-list is injected (e.g. `JSON`,
  `Math` *without* `Math.random`, pure `Array`/`Object`/`String`/`Number`).
- **Deterministic.** No wall-clock and no random source, so the same inputs always produce the same
  result — which is what keeps checkpoint/resume and retry-from-node reproducible.
- **Resource-capped.** Every evaluation runs under a CPU/instruction budget, a memory cap, and a
  wall-clock timeout; a runaway expression is terminated with a typed, secret-free error.

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

No secrets, no full prompts/responses, and no raw keys in logs — ever, **including a secret that was
*echoed back* in a provider response or error body, which must be redacted before it is logged.** Logging
redaction rules live in [logging-and-observability.md](logging-and-observability.md).

## When a review is mandatory

Any change to: key handling or the keychain bridge, IPC commands, the desktop
Rust-delegated egress path (`llm_stream` / `Channel<StreamChunk>`), provider base-URL
handling, the `http_request` tool or MCP server-URL handling (the other two SSRF egress
paths), the `run_command` sandbox, node `tools:` narrowing or `secret`-typed input
handling, prompt/tool-call construction, **media byte delivery (`read_media` / Range / upload) and the
media `url` carrier**, the DB encryption path, or a new dependency. For
**managed mode**, also: the gateway authn/z path, key-pool selection, the metering/billing
path, and the master-key vault. When in doubt, run the checklist.
