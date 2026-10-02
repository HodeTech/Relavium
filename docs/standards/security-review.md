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
- **Relavium-managed provider keys are never stored as plaintext.** No such key in a config file, `.env` committed to git,
  `.relavium.yaml`, a log, or a DB column (the **desktop's** local DB is SQLCipher-encrypted;
  the **CLI's** `history.db` is unencrypted, guarded by `0600`/`0700` OS permissions per
  [ADR-0050](../decisions/0050-cli-history-db-at-rest-posture.md) — either way, secrets
  belong in the keychain, never a DB column). This is a key-custody control, not a claim that user content,
  event copies or retained run tool results contain no credentials or sensitive data; see
  [the history.db sitting](#sitting-historydb-at-rest--cr-71-cr-97-2026-10-02).
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
- **The chat input layer (`@`-mention / `!`-shell) must reuse the audited boundaries, never fork them**
  ([ADR-0061](../decisions/0061-cli-input-layer-file-injection-and-shell-escape.md), 2.5.D). `@`-mention reads a
  file into the message through the **same** `FsCapability` `read_file` uses — the jail + the sensitive-read
  confidentiality floor (`isSensitiveReadPath`: `.ssh` / `.env*` / `.aws` / `.docker/config.json` / `.envrc` /
  `.dockercfg` / … — never listed nor read) + the binary/size guards; a user typing `@path` replaces the
  `confirmAction` prompt, **never** the floor. `!`-shell runs through the **one** `run_command` boundary via the
  additive `AgentSession.runUserCommand` (reusing `#runTurn`'s dispatch context verbatim): `enforcePolicy(allowedCommands)`
  **before** `confirmAction`, then `spawn`/`shell:false` (no metachar expansion). **`[chat].allowed_commands` defaults
  EMPTY ⇒ `!`-shell disabled** — a non-empty chat default is the "chat-specific relaxation" this section forbids
  (`run_command` has no argument/file floor, so even a read-only default reopens `!cat .env`). Both inject their
  bytes as **UNTRUSTED, nonce-fenced, bounded** context. **Editing the chat `allowed_commands` set, the input-layer
  boundary reuse, or the read-side confidentiality floor is a mandatory-review trigger** (below).

## Network and outbound URLs (SSRF — four attacker-influenceable egress paths, all on one primitive; plus one fixed-host path)

> **Amended 2026-07-13 ([ADR-0071](../decisions/0071-models-dev-as-the-model-metadata-source.md)) — a FIFTH
> outbound path exists: the model-catalog refresh.** It is listed apart from the four below **on purpose**, and
> the distinction is the whole point of this section: the four paths are dangerous because **something other
> than Relavium chooses the URL** — a user config, an agent's YAML, a *model's* tool call. The SSRF primitive
> exists to defend that. The catalog refresh's destination is a **compile-time constant** (`models.dev`): no
> user, no agent, and no model can influence it, so there is no SSRF vector to range-block. It is the same
> category as the provider fetch of [ADR-0064](../decisions/0064-live-model-catalog.md) §9, not the same as
> `http_request`.
>
> It is nonetheless **egress**, and this inventory is a closed list, so it is recorded here rather than left to
> be discovered. Its posture:
>
> - **HTTPS only**, to a fixed hostname; certificate validation never disabled. A **cross-host redirect is an
>   error, not a hop** — a 30x off `models.dev` fails the refresh rather than following.
> - **No user data, no key, no telemetry** — an unauthenticated `GET` of a public file. Nothing about the user's
>   session, keys, prompts, or machine leaves.
> - **Default OFF** (`[catalog] auto_refresh = false`), following [ADR-0068](../decisions/0068-full-screen-tui-renderer-ink7-harness.md)'s
>   opt-in-then-flip convention for a new surface. A **user-initiated** `relavium models refresh` may always
>   fetch — an explicit command is consent.
> - **Host-side only** (`apps/cli/src/engine/`). `packages/core` and the pure part of `packages/llm` keep **zero
>   platform imports** (CLAUDE.md rule 5); the merge stays a pure function taking data as an argument.
> - The response is **Zod-validated at the boundary** before it becomes a Relavium type — untrusted input, in
>   the same class as a provider's model list.
> - **Additive only:** a refresh can never leave a model *less* priced than the shipped snapshot did, and a
>   failed refresh is a **no-op**. This matters because pricing feeds a **safety control** (the ADR-0028 cost
>   cap): the guarantee is that a bad or hostile upstream cannot *lower* the floor the binary shipped with.
>
> A change that gives the catalog fetch a **non-constant** destination (a configurable mirror, a proxy setting)
> moves it into the four below and **requires the SSRF primitive** — that is a mandatory-review change, not a
> config tweak.

There are **four** outbound-URL paths (the fourth — the multimodal media `url` carrier — is now wired
host-side via [ADR-0043](../decisions/0043-media-egress-failover-rematerialization-ssrf.md)'s media egress —
`streamMediaBytes` for a media body, `fetchMediaBytes` for the rest; see the last bullet), and they share
**one** vetted SSRF range-primitive — never a second hand-rolled parser.
The **shared** rule (what every path runs through the one primitive) is the **range block**: reject
private/loopback/link-local/metadata ranges — `127.0.0.0/8`, `::1`, `10/8`, `172.16/12`, `192.168/16`,
`100.64/10` (CGNAT), `169.254/16` incl. the cloud metadata IP `169.254.169.254` (and the IPv6 forms that embed
those) — unless the caller has explicitly opted into a local endpoint, plus reject credentials-in-URL. The
**scheme** requirement is per-path, NOT part of this shared summary: each transport requires its own TLS scheme
(see the individual bullets below — e.g. provider `baseURL` / `http_request` / a remote MCP `url`). NOTE: the
shared primitive is the **range block**; the stronger **connect-by-validated-IP + per-redirect revalidation** is
wired for the media carrier, for the provider `baseURL` / `http_request`, and — since
[ADR-0088](../decisions/0088-the-mcp-boundary-is-hostile.md) §2.1 — for the MCP `http`/`sse` transports. The
one path that still cannot carry it is MCP `websocket`, whose SDK transport accepts no dialer; that transport
is therefore **narrowed to a local, opted-in endpoint** rather than left on a floor (§2.3).

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
  **MCP is no longer an exception** ([ADR-0088](../decisions/0088-the-mcp-boundary-is-hostile.md) §2–§4,
  which closes what ADR-0053 §2 scoped out). `http`/`sse` take a host-injected validated `fetch`, so every
  request rides the connect-by-validated-IP hop and the DNS-rebind window is closed; a **redirect is refused**
  rather than re-validated, because an MCP server is the exact url its author declared; a **remote
  `websocket` is refused at admission**, since that transport can be neither pinned nor byte-bounded; and the
  `allow_local_endpoint` opt-in is one **bound** policy — the private-range and plaintext relaxations lift
  together, only for the authored `host:port`, only when it actually resolves private, and **never** for the
  link-local/cloud-metadata space. The transport vocabulary,
  the `allow_local_endpoint` host:port scope, and the `env`-injection scoping are specified in their canonical
  home — [mcp-integration.md](../reference/shared-core/mcp-integration.md); see
  [ADR-0029](../decisions/0029-tool-policy-hardening.md) for the rationale.
- **Media `url` carrier (multimodal — [ADR-0031](../decisions/0031-llm-seam-shape-amendment-multimodal-io.md) A7 / [ADR-0043](../decisions/0043-media-egress-failover-rematerialization-ssrf.md)) — a fourth path, now wired host-side.**
  A media `url` source (a provider-returned output URL re-hosted to a handle, or a user-supplied input URL) is
  fetched through the **host** media-egress port — `@relavium/db`'s **`streamMediaBytes`**, which writes the
  body straight into the store under a size ceiling, an idle deadline and the run `AbortSignal`
  ([ADR-0089](../decisions/0089-media-correctness-four-boundaries.md) §2), never an adapter and never a second
  parser. It is not a second primitive: it shares `connectValidated` with its whole-buffer twin
  `fetchMediaBytes` (DNS-resolve → validate-every-IP → connect-by-validated-IP → re-validate per redirect), so
  there is still exactly one place that decides whether an address may be reached. **A media `url` with no
  streaming hook wired is REFUSED**, not quietly whole-buffered — the fallback that would have re-opened the
  unbounded read does not exist. The CLI host wires it with **no local-endpoint policy at all** — the
  default-deny posture, which [ADR-0088](../decisions/0088-the-mcp-boundary-is-hostile.md) §4 expresses as an
  ABSENT `localEndpoint` rather than the old `allowPrivate: false` boolean, so there is no flag a later edit
  can flip to "private is fine, anywhere"; the engine owns the
  `maxBytes` size bound + the run `AbortSignal`. The shared primitive **has landed** (ADR-0043, tested), and
  so has the local-endpoint opt-in — as ADR-0088 §4's ABSENT `localEndpoint`, cited in this same bullet
  above. `MEDIA_URL_SOURCE_ENABLED` is therefore **`true`** (flipped at 1.AE per ADR-0043 §3): a `url` media
  part crosses the seam today. It is admitted and then **re-hosted**, not trusted — the engine pins it to a
  content-addressed handle at the dispatch boundary before anything reads it (`CR-54`), so the bytes are
  fetched exactly once, through the one vetted primitive, and no later reader re-fetches a pointer whose
  answer may have changed. *(This clause previously claimed the flag was off. It had not been off since
  1.AE — a control asserted in a document with nothing behind it, which is the pattern the media-bytes
  sitting exists to catch.)*
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

### Sitting: prompt and trust provenance — `CR-01`–`CR-03`, `CR-10`–`CR-17` (2026-09-06)

The phase-2.6.5 prompt/trust-provenance sitting
([phase clause 7](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md)). The threat is **text that
arrives as data and is read as instruction**: a tool result, a model-written compaction summary, an MCP
server's tool description, another node's output. The `system` role is the boundary — everything with
authority is on one side of it, and everything a model or a server produced is on the other.

| Control | Adversarial test |
|---|---|
| `system` is constructible ONLY from authored sources — the type system, not a convention | `authored-system-prompt.test.ts` — "the agent arm reads the agent's prompt and the node's append, and nothing else", "the engine arm takes a prompt IDENTITY, never text", and "a dynamic string is not assignable to the brand — the type-level half" |
| A hostile compaction summary — text the MODEL wrote — lands in a user part and never in `system` | `authored-system-prompt.test.ts` — "places the summary at the head of the FIRST user message", "the system prompt has ZERO occurrences of the summary", "the block announces itself as data, in-band"; and the edge case that would otherwise drop it silently, "with no user-role message it makes one, rather than leaving the summary out" |
| The same holds across a RESUME, where the summary arrives from storage rather than from the turn | `agent-session.test.ts` — "after a RESTORE the bytes are in a user part and ZERO times in `system`", plus "the granted tool set is byte-identical however the summary is mutated" (a summary cannot widen what the model may do) |
| An untrusted `run.outputs` reference cannot resolve into the system role | `agent-runner.test.ts` — "never resolves an untrusted run.outputs reference into the system role (ADR-0038)" |
| An engine-authored preamble never presents as the user | `agent-turn.test.ts` — "carries an engine-authored preamble that never presents as the user (the `CR-13` trust rule)" |
| A tool result is MARKED untrusted at the boundary, and a bare value is rejected rather than assumed safe | `untrusted.test.ts` — "detects a wrapped value and rejects a bare one"; `registry.test.ts` — "dispatches read_file and returns mapped output + untrusted result + sanitized events" |
| Untrusted data cannot reach the prototype chain of the expression scope | `sandbox.test.ts` — "a __proto__ key in untrusted scope data cannot pollute the prototype chain" and its deep variant |
| A refusal names a POSITION, never the authored value — an authored string has no charset or length bound and would ride an event and a log | `dag.test.ts` — "locates the offence POSITIONALLY and never echoes the authored tool value" |
| A durable-append gap fails the engine's next ask CLOSED rather than continuing on a log it cannot trust | `m2-e2e-harness.e2e.test.ts` — "append audit: a LOST non-terminal write makes the engine's next ask fail closed (CR-10 acceptance)", with "an ordinary SEQUENTIAL run already overlaps nothing (CR-10 baseline)" as the control |

**What the sitting produced.** No new finding — and that is a claim this sitting can make only because the
controls above are each pinned by a test that fails when the control is removed, several of them written
BECAUSE the original claim was false: `CR-13`'s preamble presented as the user until the test above existed,
and `CR-10`'s fan-out assertion had to flip (`m2-e2e-harness.e2e.test.ts` — "the assertion that flipped").
The one weakness recorded rather than closed: the brand is a compile-time guarantee, and
[ADR-0081](../decisions/0081-the-compaction-summary-is-untrusted-and-the-system-prompt-is-branded.md) §1 names
**two residual forging forms the lint fence does not catch**. `tools/lint-fixtures/assert-fence.mjs` says so on
every run rather than reporting the fence airtight, and it fails if the fence starts catching one of them —
so the ADR's stated bound cannot drift out of date silently in either direction.

### Sitting: the hostile MCP boundary — `CR-40`–`CR-42` (2026-09-06)

The phase-2.6.5 hostile-MCP sitting
([phase clause 7](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md)), covering `W4`. The threat
model is [ADR-0088](../decisions/0088-the-mcp-boundary-is-hostile.md): an MCP server is not a library, it is a
remote party that chose its own name, its own tool names, its own schemas and its own descriptions, and it can
change all of them between two calls. Recorded after the wave merged (2026-09-01) rather than with it.

| Control | Adversarial test |
|---|---|
| A DNS answer that rebinds between validation and connect cannot land — the dial carries the validated address | `mcp-fetch.test.ts` (rebind); `mcp-servers.test.ts` — the dialer is handed over and one window covers preflight + connect |
| A redirect is refused rather than followed, including to a sibling port | `mcp-fetch.test.ts` (redirect, sibling port) |
| A local opt-in cannot be aimed at a cloud metadata endpoint | `content.test.ts` — AWS IMDS v6, Alibaba |
| A remote `websocket` server is refused at admission, not mid-session | `mcp-servers.test.ts` — "REFUSES a remote websocket outright, naming the transport that carries it safely", with two controls that stop the refusal being a blanket ban: "still permits a LOCAL opted-in websocket" and "RESOLVES a local websocket and refuses a name that answers PUBLIC". The remedy is stated in the `W4` register rather than left for a user to discover |
| A server's ingress is bounded at two levels, and PAGING STOPS at the bound instead of looping | `ingress-bounds.test.ts` — the measured 50 000-tool catalogue, refused; the paging-stops group; the allowlist-behind-decoys case |
| A tool DEFINITION is untrusted presentation: control/bidi bytes are sanitized at discovery, INCLUDING inside the schema, and semantic fields fail closed | `tool-mapping.test.ts` |
| The model is TOLD a tool description came from a server, so a description cannot impersonate the operator | `agent-session.test.ts` — "prefixes an MCP tool's description with a provenance line" and "states the provenance even when the server supplied NO description" |
| A cross-layer or same-layer tool-name collision is refused rather than resolved silently | `resolve.test.ts` |
| A connect that never settles is bounded, and the cancellation reaches the server | `deadlines.test.ts` — a transport whose `start()` never settles; `network-adapters.test.ts` — a real `McpServer` observing its own cancellation |
| A spawned local server cannot outlive the CLI that spawned it | `mcp-orphan.e2e.test.ts` **and** `tools/cli-smoke/check.mjs` — a real signalled `agent run` subprocess asserted against the process table |

**What the sitting produced**, recorded because a sitting that finds nothing is usually a sitting that did not
look: the wave's own review found **five merge blockers** in `W4`, all reproduced and fixed before it merged,
and one register row named a test file that contained no such test (`#208`'s client-version row pointed at
`errors.test.ts`, which has no version test — nothing covered it until the PR #87 review said so). Three
weaknesses stay open and are in [deferred-tasks.md](../roadmap/deferred-tasks.md) rather than implied here:
the admission and the dialer canonicalize a url differently (fails closed, so it costs usability not safety);
the MCP hop does not go through `withEgressTimeout`; and `allow_local_endpoint` may still name a host whose
resolution a LAN-adjacent attacker steers — narrowed by the dialer's refusal of a public or metadata answer,
not eliminated.

### Sitting: media bytes — `CR-50`, `CR-53`, `CR-54` (2026-09-02)

The phase-2.6.5 media-bytes security sitting
([phase clause 7](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md)). Each line below names the
control and **the adversarial test that exercises it** — a reviewer's assurance is not an entry.

| Control | Adversarial test |
|---|---|
| A public target that REDIRECTS inward is refused, and the inward hop is never dialled | `media-egress.test.ts` — "a public first hop that redirects to a private host is blocked on the STREAM path too" (`169.254.169.254`; control-verified — the same request succeeds when that host resolves public, so the refusal is the private-ness) |
| A redirect that downgrades to `http://` is refused on the streaming path | `media-egress.test.ts` — "a redirect to a non-HTTPS target is blocked on the STREAM path too" |
| The dial carries the VALIDATED address, so a rebinding answer between validation and connect cannot land | `media-egress.test.ts` — "the connection is pinned to the VALIDATED ip, not re-resolved" |
| A body that never ends is abandoned; a body over the ceiling is cut off rather than completed-then-rejected | `media-egress.test.ts` — "ABANDONS a stalled body", "ABORTS mid-flight when the ceiling is crossed" |
| A url's bytes cannot change between two readers of the same run | `engine.test.ts` — "the scope and the durable record carry the SAME handle" and "a `save_to` output writes the SAME bytes the durable record names", both against a host that returns DIFFERENT bytes on a second fetch |
| An untrusted producer cannot compel unbounded egress from one node output | `engine.test.ts` — "REFUSES a node output with more media parts than it will re-host, before fetching any" |
| A failed pin names its reason without leaking the url | `engine.test.ts` — "a failed pin fails the NODE with an actionable reason": asserts the reason IS present and the host is NOT |
| Knowing a sha256 is not authorization | `builtins.test.ts` — "denies (media_scope_denied) when the scope is NOT in allowedScopes", asserted before any delivery |
| A tool cannot put raw bytes into a durable position | `DurableMediaPart` makes the attachment channel handle-only **by type**; `builtins.test.ts` — "never delivers bytes itself — the attachment is a HANDLE, and `readRange` is never called" |

**Two findings the sitting produced, both fixed in the same wave rather than filed:** the streaming egress
was only tested against refusals decided BEFORE a connection opens, so the redirect-based bypass — the one
an attacker actually reaches for — was untested on the newer path; and this document claimed a user-supplied
`url` media source stayed feature-flag-OFF, which had not been true since 1.AE (see the SSRF section above).
Both are the same failure: a control believed rather than measured.

### Sitting: provider and config trust — `CR-80` (2026-09-06)

The phase-2.6.5 provider/config-trust sitting
([phase clause 7](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md)). The threat is a **stored
row the user no longer remembers writing**: a custom `base_url` is persisted once and then read on every
invocation, so a value that was safe when it was typed decides where prompts and API keys go forever after.
Each line names the control and **the adversarial test that exercises it**.

| Control | Adversarial test |
|---|---|
| A rejected custom endpoint NEVER falls back to the official API — the provider refuses instead | `providers.test.ts` — "`CR-80`: a bad (private) custom base_url FAILS CLOSED": asserts the call throws **and** that a stubbed GLOBAL `fetch` recorded zero requests |
| The refusal names the URL's shape and the remedy, and never echoes an embedded credential | `providers.test.ts` — "`CR-80`: the refusal names the URL SHAPE and the remedy": asserts the username and password of `https://alice:hunter2@10.0.0.5/v1` are both absent from the message |
| An `InvalidBaseUrlError` cannot carry `user:pass` even when constructed directly | `openai.test.ts` — "redacts embedded credentials from InvalidBaseUrlError — never leaks user:pass into the error" |
| A bad `--base-url` is refused at the door, before it can ever be stored | `provider.test.ts` — "rejects a non-HTTPS or malformed --base-url (exit 2)" and "rejects a private/loopback or credential-bearing --base-url (fail-fast SSRF, exit 2)" |
| A URL carrying control/bidi characters is neither stored nor echoed back | `provider.test.ts` — "add --base-url REJECTS a control/bidi-bearing URL at the door (never stored or echoed)" |
| A custom endpoint cannot be attached to a provider whose dialect is not OpenAI-compatible | `provider.test.ts` — "refuses a custom --base-url on a NON-OpenAI-compatible provider (anthropic/gemini, exit 2)"; `providers.test.ts` — "SKIPS a custom base_url on anthropic/gemini" |
| A custom endpoint's egress rides the SSRF-validated fetch, not a raw one | `providers.test.ts` — "routes a CUSTOM openai-compatible base_url through the injected validated fetch": asserts the custom host IS dialled and `api.openai.com` is NOT |
| A caller-supplied transport option cannot re-point a provider's base URL or key | `gemini.test.ts` — "strips httpOptions from providerOptions to prevent SSRF via baseUrl redirect" and "strips a caller-supplied httpOptions from the Imagen config" |
| A provider key never reaches an error message, and no nested field carries it either | `providers.test.ts` — "REDACTS the key from a failing-ping message (never the full key, keeps the last-4 hint)" and "does not attach the error as a cause (no nested field a --verbose render could leak)" |
| A key is never read from an interactive terminal, where it would land in shell history | `provider.test.ts` — "refuses to read a typed key from an interactive TTY (errors with a pipe hint, exit 2)" |

**What the sitting produced.** `CR-80` itself was a fail-open **defended by a comment**: the `catch` said
"refuse the custom endpoint, keep the default adapter", which reads as a refusal and is a fallback to
`api.openai.com`. The finding under it is the test. The case was pinned by
`expect(resolver.resolveProvider('openai')).toBeDefined()` — an assertion a REFUSING adapter satisfies just as
well as a fail-open one, so the test could not distinguish the defect from the fix and passed either way. **An
assertion that both the vulnerable and the corrected implementation satisfy is not coverage of that control**,
and it is the same failure the media-bytes sitting recorded in different words: a control believed rather than
measured. The rewritten test stubs GLOBAL `fetch` — not the injected one — because a fallback to the official
endpoint would leave an injected recorder empty too, and the test would have passed for the wrong reason a
second time.

A sweep of the rest of the provider/config path for the same shape found **no second instance**: the key
resolver returns `undefined` for genuine absence and re-raises a non-`KeychainUnavailableError` binding fault
rather than reporting "no key", the `--pricing-url` and `--base-url` parsers throw rather than defaulting, and
`validated-fetch.ts` normalises every escaping error to one reason-only `SafeEgressError` rather than
continuing. Those are recorded here as checked, not assumed.

### Sitting: `history.db` at rest — `CR-71`, `CR-97` (2026-10-02)

W7 step 4's implementation sitting covers model-issued session tool results, durable effect evidence and
its disclosure/retention boundary. Independent acceptance review rounds are recorded at step closure. The
threat is sensitive output recoverable from an unencrypted local database, plus an undisclosed external effect
whose only durable evidence disappears during resume. Keychain custody alone addresses neither threat.

| Control | Adversarial evidence |
|---|---|
| A session result is never serialized, retained, decoded or replayed; run replay is unchanged | `session-effect-journal.test.ts`, `effect-journal-store.test.ts` and `session-effect-privacy.test.ts`: throwing serializers, planted malformed legacy results, exact matching prepare refusal, run replay and committed-NULL refusal controls |
| Legacy clearing preserves state/digest/attempt and follows high-water initialization | `session-effect-privacy.test.ts`: real 0016 upgrade, orphan/unresolved/hidden one-shot rows, unchanged run result and next durable key after sweep |
| Secure deletion AND an after-commit TRUNCATE checkpoint protect post-upgrade freed bytes | Real-file main/WAL scans while the connection remains open; live reader defers erasure, then an empty sweep completes it. Mutations turning secure deletion off or skipping checkpoint both fail the byte assertions |
| Disclosure reads all history and effect metadata in one owned transaction | `session-effect-disclosure.test.ts`: completed empty final behind compaction, concurrent completion on another SQLite connection, corrupt transcript refusal and native/Drizzle outer-transaction refusal. Removing the owned read transaction fails the snapshot assertion |
| Notice delivery and activation precede deletion of exactly captured committed evidence | `effect-retention.test.ts`, actual `chat-effect-activation.test.ts`/`drive-home.test.ts` resume/reseat drivers, mounted `chat-app.test.tsx` and `home-effect-activation.test.ts`: failed reads/sinks/mounts, stale callbacks, discarded builds, synchronous exit during publication/delivery and later commits retain evidence |
| Captured identity and current-state predicates prevent destructive sweep races | Native SQLite post-read commit, state change, foreign session and same-id replacement controls; all chunks roll back on a late refusal. Removing the captured effect-address predicate deletes the replacement and fails the assertion |
| Errored, aborted and crashed turns do not silently lose committed effects | Real MCP + session/persister errored/aborted turns, a real SIGKILL after durable settlement before transcript persistence, disclosure once, then a greater durable key and silent completed-turn control |
| One-shot cleanup requires proven ownership and preserves unresolved effects | Actual `agent-run.test.ts` allocator/host success, failure, abort, teardown rejection and owned setup unwind; a refused collision reservation leaves the prior owner's committed row intact |
| Diagnostics and stored output do not escape into disclosure text | Fixed warnings on DB/read/sink failure, strict content-free snapshot and raw-result suppression; malformed attempt/name metadata is conservative rather than falsely reported as a completed or incomplete turn |

The byte claim starts with the upgrade and requires a successful checkpoint. A busy reader can leave old
bytes in the main file and WAL; pages freed before the upgrade are not retroactively erased. No `VACUUM`,
encryption or session-ownership decision was added. User text, `@` content, `!` output and run tool results
remain sensitive data at rest. The canonical scope is [effect-journal.md §11](../reference/shared-core/effect-journal.md#11-secrets-what-a-row-may-hold),
with the two accepted residuals in [deferred-tasks.md](../roadmap/deferred-tasks.md).

[Step 4 round 1](../reviews/2026-10-02T08-05-02-w7-step-4-round-1-review.md) independently reproduced
premature deletion before the standalone Ink mount. The correction separates session opening from mounted
activation and propagates driver activity into reconciliation. Fresh corrective acceptance review follows.

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
  add to it. A node listing a tool the agent was not granted is refused when the **run plan is built** — a
  `GraphIssue` from `buildRunPlan`, before a run id exists — **but only when the host marks the grant complete**
  (`BuildRunPlanOptions.toolGrantsFinal`). An incomplete grant is not evidence a node is narrow, and the check
  stands down rather than refuse on a partial picture ([ADR-0094](../decisions/0094-a-tool-grant-is-checked-when-the-plan-is-built.md)) —
  with the runtime dispatch check (`resolveGrant`) retained as the floor, so a host that constructs a node
  executor directly is still covered. A node can never silently widen a tool grant. *(This clause said
  "parser-enforced" until 2026-09-02; nothing in the parser ever read `tools` — the guarantee held at
  dispatch, only its stated location was wrong. The refusal locates the offence positionally,
  `node <id>.tools[<index>]`, and never echoes the authored tool value.)*
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
- **A declared child environment may not redirect the interpreter, the loader, or a tool's
  configuration — and the rule is one rule, true of BOTH local-process hosts.** A declared
  `NODE_OPTIONS`, `PATH`, `ZDOTDIR`, `BASH_ENV`, `HOME`, `LD_*`, `DYLD_*`, `GIT_*`, `PYTHON*`,
  `NPM_CONFIG_*`, `BASH_FUNC_*` (and the rest of the list in `@relavium/shared`) is **rejected**,
  case-insensitively, on `run_command`'s `declaredEnv` **and** on an MCP `stdio` server's `env`
  — inline on an agent or registered in config alike. These names turn "run program X" into
  "run attacker code inside X", so a floor on one host and not the other is a floor an
  attacker simply walks around; the shared list exists so the two cannot drift
  ([ADR-0084](../decisions/0084-consent-before-a-local-mcp-spawn.md) §4). The refusal is an
  **authored error at parse**, not a silent drop at spawn: an author who declared it believed
  it would take effect. Executable resolution reads the **ambient** `PATH`, never a declared
  one, so a declared `PATH` cannot select the binary either. `{{secrets.*}}` credential
  references are unaffected.
- **Nothing spawns a local MCP server without the user's consent on that machine.** A `stdio`
  MCP server is a **program the artifact chooses**, so the decision cannot belong to the
  artifact. Every host path that can open an MCP-bearing artifact passes one chokepoint before
  any spawn; consent is recorded per machine against a **fingerprint of the resolved
  executable, its arguments, its environment and its working directory**, so a changed
  declaration re-prompts rather than inheriting trust. The command is resolved to an absolute
  path **before** the decision and that same path is spawned **after** it, so a `PATH` change in
  between cannot substitute a different binary under an approved fingerprint. Where there is no
  one to ask — no TTY, `--json`, or CI — the invocation **refuses** rather than prompting into a
  stream nobody reads. No credential enters the fingerprint or the grant record. The
  cross-surface contract, including the golden vectors a non-TypeScript host is verified
  against, is [mcp-integration.md](../reference/shared-core/mcp-integration.md#consent-before-a-local-stdio-spawn-cross-surface-contract)
  ([ADR-0084](../decisions/0084-consent-before-a-local-mcp-spawn.md)).

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

### CLI terminal-render safety + interactive approval (2.5.E / 2.5-close Step 14)

- **Terminal-control + Trojan-Source floor (a rendering-safety primitive).** Every dynamic
  string written to the terminal — streamed model output, a tool id, a path in an approval
  prompt, a pasted line — passes the shared `stripTerminalControls` sanitizer at the DISPLAY
  boundary (the persisted transcript keeps the raw bytes). It strips ANSI/OSC/DCS escapes, C0/C1
  control bytes, AND the Unicode bidirectional/directional format controls (U+202A–202E,
  U+2066–2069, LRM/RLM/ALM — the CVE-2021-42574 family) so untrusted text cannot inject a
  cursor/title/clipboard escape NOR visually reorder a line to spoof its logical bytes (a faked
  path/command in a consent prompt). ZWJ/ZWNJ are preserved (legitimate in emoji + shaping). The
  provider-URL echo strips a stricter zero-width superset. **Never embed literal bidi bytes in
  source** — the sanitizer regex uses `\u` escapes.
- **Interactive per-tool approval is fail-closed and cannot be widened by a keystroke.** During a
  pending approval the key-swallow answers ONLY `[y]/[a]/[n]/[esc]` plus `[c]` (open a
  reject-with-reason capture) and the VIEW-ONLY reasoning toggle (Ctrl+T — a pure repaint, zero
  session/decision effect). A modified chord (Ctrl/Alt) never silently picks the most-permissive
  approve/reject. The `[c]` reason is a USER-typed reject enrichment only — sanitized (terminal +
  bidi stripped, one line) and length-bounded before it rides the secret-free denial; it never
  changes the floor or "a user deny is final". Off a TTY (`--json` / piped / one-shot `agent run`)
  the one canonical `nonInteractiveApprovalPrompt` DENIES every governed dispatch — never a hang,
  never an auto-approve.
- **A recoverable SCOPE denial is safe by construction.** On the `recoverToolFailures` chat surfaces,
  exactly the two SCOPE denials refused BEFORE any side effect (a media scope denial + the fs pure
  scope-tier escape) are fed back to the model with a **secret-free, path-free** reason so it adapts to
  an in-bounds path — the floor still denies every attempt (no bypass; the bounded workspace-boundary
  signal a probing model could gather is accepted, matching the pre-existing not-found-read feedback).
  Every OTHER `tool_denied` — confidentiality (secret-store read), protected-path, symlink/hard-link,
  egress-SSRF, and user/guardrail — stays FATAL. The authoritative enumeration of which denials are
  `recoverable` and which stay fatal (and why) is the canonical `recoverable` note in
  [tool-registry.md §error taxonomy](../reference/shared-core/tool-registry.md#error-taxonomy) — not
  restated here.

**Machine output has its own arm of that floor, and it is the opposite choice.** Every `--json` record is
serialized with `stringifyJsonLine` (`apps/cli/src/render/sanitize.ts`), never a bare `JSON.stringify`:
`JSON.stringify` escapes `ESC` and stops, leaving `DEL`, the whole C1 block — including `U+009B`, a working
escape-sequence introducer on real terminals — and the Trojan-Source bidi family RAW in content the model, a
tool, or an imported artifact controls. It **escapes** where the human-display path **strips**, because
`--json` is a machine contract: escaping changes the JSON *text* but `JSON.parse` returns the identical value,
so a consumer loses nothing — while stripping would silently hand it different data. The rule is enforced by an ESLint
`no-restricted-syntax` selector rather than by review, because the gap reopened twice when it was not
(`#W15-10`, then `CR-03`). `apps/cli/src/process/render-error.ts` is the single allowlisted exception: it
pre-sanitizes with the stripping sanitizer, so the `--json` ERROR envelope is deliberately lossy.

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
paths), the `run_command` sandbox, **the local-spawn floor — the MCP stdio consent gate, its
fingerprint or canonicalization, the grant store, or the shared declared-environment denylist
([ADR-0084](../decisions/0084-consent-before-a-local-mcp-spawn.md)); a change here decides
whether a program runs on a user's machine, and a weakening is invisible from the outside**,
**the host file reader behind the `read_file` interpolation
filter (`ResolverCapabilities.readFile`) — which must jail to the workspace root and reject path
traversal, a duty the pure engine delegates to each host**, **the CLI chat input layer — the `@`-mention
read path, the `!`-shell `runUserCommand` boundary, the `[chat].allowed_commands` set, or the read-side
confidentiality floor (`isSensitiveReadPath`) ([ADR-0061](../decisions/0061-cli-input-layer-file-injection-and-shell-escape.md))**,
node `tools:` narrowing or `secret`-typed input handling, prompt/tool-call construction, **media byte delivery (`read_media` /
Range / upload) and the media `url` carrier**, the DB encryption path, or a new dependency. For
**managed mode**, also: the gateway authn/z path, key-pool selection, the metering/billing
path, and the master-key vault. When in doubt, run the checklist.
