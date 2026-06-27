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
  `.relavium.yaml`, a log, or a DB column (the **desktop's** local DB is SQLCipher-encrypted;
  the **CLI's** `history.db` is unencrypted, guarded by `0600`/`0700` OS permissions per
  [ADR-0050](../decisions/0050-cli-history-db-at-rest-posture.md) — either way, secrets
  belong in the keychain, never a DB column).
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
  into a session and the model's replies are persisted in `history.db` (SQLCipher-encrypted on
  the desktop; unencrypted, `0600`/`0700`-guarded on the CLI per [ADR-0050](../decisions/0050-cli-history-db-at-rest-posture.md))
  — that is user data under the user's control, not a key-custody concern, and
  it is **not** a violation of
  [secrets-never-touch-the-frontend](architectural-principles.md#6-secrets-never-touch-disk-or-the-frontend).
- **The real leak is a `secret`-typed input in a prompt.** non-negotiable #6 targets
  *managed* secrets — keychain keys and `secret`-typed inputs — which live below the seam
  and must never enter message history. The P0 leak closed by
  [ADR-0029](../decisions/0029-tool-policy-hardening.md) is a `secret`-typed **input
  interpolated into a prompt** (event-payload masking does not save you once it is in the
  prompt body); see the parse-time rejection rule under
  [Sandbox and tool policy](#sandbox-and-tool-policy-run_command-node-tools-secret-inputs).

## Network and outbound URLs (SSRF — four egress paths, all on one primitive)

There are **four** outbound-URL paths (the fourth — the multimodal media `url` carrier — is now wired
host-side via [ADR-0043](../decisions/0043-media-egress-failover-rematerialization-ssrf.md)'s `fetchMediaBytes`;
see the last bullet), and they share **one** vetted
SSRF range-primitive — never a second hand-rolled parser. The same validation
(HTTPS only, reject non-HTTP(S) schemes and credentials-in-URL, and **block
private/loopback/link-local/metadata ranges** — `127.0.0.0/8`, `::1`, `10/8`,
`172.16/12`, `192.168/16`, `100.64/10` (CGNAT), `169.254/16` incl. the cloud metadata IP `169.254.169.254`,
unless the user has explicitly opted into a local endpoint) applies to **all four** — including the media `url`
carrier fetched by `fetchMediaBytes`. NOTE: the shared primitive is the **range block**; the stronger
**connect-by-validated-IP + per-redirect revalidation** is wired for the media carrier (and is construction-time
for the provider `baseURL` / `http_request`), but the **MCP** path is on the **pre-connect host floor** only
until its dialer lands (see the MCP bullet) — so a DNS-rebind / redirect-to-private window is MCP-specific, not
a property of all four.

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
- **MCP server URLs.** *(Security tightening — ADR-0029(d); network egress per ADR-0053.)* A network MCP
  (`http`/`websocket`) server URL is a second egress path, so leaving it scheme-checked-only while hardening
  `http_request` would be strictly worse. MCP server URLs run the **same** SSRF range-primitive (no second
  parser): private/loopback/link-local/metadata hosts are rejected and a remote host must use `https`/`wss`,
  unless the per-server `allow_local_endpoint` opt-in is set (which never relaxes the no-credentials check).
  **MCP is a temporary exception to the full egress guarantee:** 2.R ships only the **pre-connect host floor**
  (the SDK opens its own socket), so a hostname that DNS-resolves to a private IP — or a redirect to one —
  remains a residual window until the connect-by-validated-IP dialer (resolve → validate → connect-by-IP →
  re-validate per redirect) lands; tracked in [deferred-tasks.md](../roadmap/deferred-tasks.md)
  ([ADR-0053](../decisions/0053-mcp-network-transport-egress-security.md) §2/§3). The transport vocabulary,
  the `allow_local_endpoint` host:port scope, and the `env`-injection scoping are specified in their canonical
  home — [mcp-integration.md](../reference/shared-core/mcp-integration.md); see
  [ADR-0029](../decisions/0029-tool-policy-hardening.md) for the rationale.
- **Media `url` carrier (multimodal — [ADR-0031](../decisions/0031-llm-seam-shape-amendment-multimodal-io.md) A7 / [ADR-0043](../decisions/0043-media-egress-failover-rematerialization-ssrf.md)) — a fourth path, now wired host-side.**
  A media `url` source (a provider-returned output URL re-hosted to a handle, or a user-supplied input URL) is
  fetched through the **host** `fetchMedia` port — `@relavium/db`'s **`fetchMediaBytes`**, the one vetted
  SSRF primitive (DNS-resolve → validate-every-IP → connect-by-validated-IP → re-validate per redirect), never an
  adapter and never a second parser. The CLI host wires it with **`allowPrivate: false`** (the default-deny
  posture, 2.S/[ADR-0043](../decisions/0043-media-egress-failover-rematerialization-ssrf.md)); the engine owns the
  `maxBytes` size bound + the run `AbortSignal`. The shared primitive **has landed** (ADR-0043, tested); a
  user-supplied `url` INPUT *source* (a `url` media part crossing the seam) stays **feature-flag-OFF**
  (`MEDIA_URL_SOURCE_ENABLED`) until the BYOK local-endpoint opt-in lands behind a fresh ADR.
- **The check and the connect must see the same address (no TOCTOU).** The primitive resolves the
  hostname, validates **every** resolved IP against the range-block, and then **pins the connection
  to a validated IP** (connect-by-validated-IP / a lookup-pinned HTTP agent). Validating one
  resolution and letting the HTTP client re-resolve at connect time is the DNS-rebinding window —
  an attacker-controlled DNS answer can pass the check and then point the actual connection at a
  private address. Redirects re-run the full resolve-validate-pin cycle per hop.
- All provider calls are HTTPS; we do not disable TLS verification. *(Per-host/per-provider TLS granularity
  is a deferred draft-proposal, not a current rule — see [deferred-tasks.md](../roadmap/deferred-tasks.md);
  the global never-disable stance holds until a private-CA self-hosted consumer needs an opt-IN behind a
  fresh ADR.)*
- Outbound requests carry the AbortSignal and a timeout; a hung provider must not pin a
  worker open.

## Media byte delivery (`read_media`, Range, `save_to`, upload)

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
- **`save_to` writes are jailed identically** ([ADR-0044](../decisions/0044-media-access-governance-read-media-save-to-cost.md)
  §2). An `output` node's `save_to` is a write of model-produced bytes to a **relative** path; the
  platform-pure engine resolves the path (only `{{ run.id }}` in scope) and the single produced handle to
  bytes, then hands `(relativePath, bytes)` to a **host media-write port**. The host enforces the same
  fail-closed discipline as the read gate: reject an absolute / drive / UNC / `..` path; `realpath` the scope
  root; verify the deepest existing ancestor is within the root **before** any `mkdir`/write (a symlinked
  ancestor that escapes is caught before anything is created outside the root); refuse a symlink at the final
  component; publish atomically (temp + `rename`, which never follows a final-component symlink). The engine
  never does filesystem I/O and never knows the scope root.

*(Not yet built for the surface — these are binding acceptance criteria for the `read_media` / Rust-CAS
workstreams, 1.AF/1.AH. The `save_to` host write port + its jail land in 1.AF (`@relavium/db`'s
`createFilesystemMediaWrite`); the surface rendering is 1.AH.)*

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
  (persisted in `history.db` — see the at-rest posture above), **not** a managed secret; the
  leak this rule closes is a `secret`-typed *input* reaching prompt/tool text.

### Expression sandbox (`condition` / `transform` / `merge_fn`)

`condition`, `transform`, and a custom `merge_fn` evaluate author-supplied JavaScript. Per
[ADR-0027](../decisions/0027-expression-sandbox.md) the sandbox is **security-sensitive** (rule #3:
never hand-roll a security primitive; rule #2: a new runtime dependency needs an ADR) and these are
**binding** invariants a review must confirm:

The full contract (scope, exhaustive allow-list, caps, error taxonomy) is owned by
[expression-sandbox-spec.md](../reference/shared-core/expression-sandbox-spec.md); the **binding
security invariants** a review must confirm are:

- **QuickJS-wasm via embedded bytes only.** Instantiated only through the standard `WebAssembly`
  global from embedded wasm bytes — `@relavium/core` imports `quickjs-emscripten-core` plus a
  single-file **sync** variant, never the meta-package's default `getQuickJS()` loader (it statically
  imports `node:fs`/`path` and breaks the zero-platform-imports invariant,
  [ADR-0003](../decisions/0003-pure-ts-engine-not-langgraph-python.md)). Host `new Function()` / `eval`
  / the Node `vm` module are **never used as the sandbox** (none is a boundary).
- **The wasm VM is the boundary; deny-by-default capabilities.** The VM runs on an isolated wasm heap
  with no host reference reachable (zero host functions injected). Only the audited pure allow-list
  exists; `Date`, `Math.random`, `Promise`/async, `performance`, `crypto`, `Proxy`, `WeakRef`, `Intl`,
  and all I/O are absent (the pure reflective globals `BaseObjects` ships — `Reflect`/`Symbol`/`WeakMap`
  — are present but deterministic and host-unreachable). The `Eval` intrinsic stays on (quickjs
  `evalCode` needs it), so `eval`/`Function`
  exist *inside* the VM but are contained — they reach no host reference and no forbidden capability,
  so they are harmless; the guarantee rests on the isolation + capability removal, not on deleting
  every reflective handle to `Function`.
- **JSON-only marshaling, immutable global.** Scope crosses the boundary as plain JSON (host
  `stringify` → VM `parse`), so no live host object/getter/function leaks in and a `{"__proto__":…}`
  in model/tool-derived `run.outputs` cannot poison the prototype chain; each binding is installed
  non-writable/non-configurable over a deep-frozen value.
- **Deterministic within caps; caps are non-idempotent safety nets.** A successful evaluation is a
  pure function of the scope (no clock/RNG/async). The wall-clock timeout, memory, and stack caps are
  safety nets, not results — a trip surfaces as a typed `sandbox_error`, never a stable value.
- **Secret-free, scrubbed errors.** Secrets are never injected (ADR-0029(c) gate + an injection-time
  filter); a `sandbox_error` message is the code + a generic string — never the expression source, a
  variable name, a scope value, or a host stack.

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
- **Untrusted-content-as-data is a *structural* engine guarantee, not a per-call-site
  discipline.** Every piece of content the model's caller does not author — a tool result
  (`run_command` stdout, `read_file` contents, an `http_request` body), an MCP server
  response, fetched media text — enters message assembly through a **typed untrusted
  boundary** (a branded wrapper / taint marker on the engine side, the same compile-time
  technique as the ADR-0029(c) secret taint), and the assembly layer can place such a value
  **only** in a data position (`user`/`tool` content), **never** in `system` and never
  string-concatenated into an instruction template. The reason it must be structural: with
  N tool call-sites, "remember to wrap it" fails open at exactly one forgotten site — the
  type boundary makes the unsafe path unrepresentable. This binds the `AgentRunner` /
  `ToolRegistry` / `AgentSession` implementations (1.O / 1.T / 1.V); it is an engine-layer
  rule and changes **no** seam shape — `LlmMessage` stays as the seam defines it.

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
paths), the `run_command` sandbox, **the host file reader behind the `read_file` interpolation
filter (`ResolverCapabilities.readFile`) — which must jail to the workspace root and reject path
traversal, a duty the pure engine delegates to each host**, node `tools:` narrowing or
`secret`-typed input handling, prompt/tool-call construction, **media byte delivery (`read_media` /
Range / upload) and the media `url` carrier**, the DB encryption path, or a new dependency. For
**managed mode**, also: the gateway authn/z path, key-pool selection, the metering/billing
path, and the master-key vault. When in doubt, run the checklist.
