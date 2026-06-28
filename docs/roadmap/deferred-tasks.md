# Deferred tasks — confirmed review findings not yet actioned

> Status: Living

> Last updated: 2026-06-28

- **Related**: [current.md](current.md), [README.md](README.md), [phases/phase-0-foundations.md](phases/phase-0-foundations.md)

A holding pen so confirmed-but-deferred findings don't get lost. Every item here was
**adversarially confirmed** by a comprehensive review (the Phase-0 97-agent workflow, or a
later per-PR review pass) but was deliberately **not** fixed in that pass — either because it
needs a maintainer decision, is below the bar for its pass, or is an optimization whose
risk/benefit favors waiting. None block a shipped milestone. Pick them up opportunistically
(most fit naturally into the work that first touches the file) or in a dedicated hardening pass.

Severity is the review's verified rating. Check an item off in the PR that resolves it.



## Decisions needed (maintainer call)


### Multimodal forward-obligations (carry the not-yet-coded pieces — see ADR-0031)

- [ ] **⚠ OpenAI Sora 2 + Videos API DEPRECATED — provider shutdown 2026-09-24 (affects 1.AH A3).** OpenAI
  announced the Sora 2 video models (`sora-2`, `sora-2-pro`, `sora-2-2025-10-06`, `sora-2-2025-12-08`,
  `sora-2-pro-2025-10-06`) + the `videos.*` API shut down **2026-09-24**. The 1.AH A3 OpenAI/Sora async-video
  adapter targets exactly these (`videos.create`/`retrieve`/`downloadContent` + `pollMediaJobSora`). **Impact is
  narrow:** only the Sora adapter arm + its tests; the engine async-job LRO ([ADR-0045](../decisions/0045-async-media-job-loop-poll-checkpoint-resume-cancel.md)),
  the shared `encode/decodeMediaJobId` codec, the generative-seam conformance, and the **Gemini/Veo (A4)** adapter
  are provider-agnostic and **unaffected**. No live exposure today — A3 is not runtime-reachable until the
  Phase-2 host `media_surface` wiring. **Action (maintainer call, before 2026-09-24):** when OpenAI announces a
  replacement video model/API, retarget the A3 arm; otherwise **disable/remove** the Sora arm (the `generateMedia`
  `video` dispatch + `pollMediaJobSora` + their tests) leaving the seam + Veo intact. Low priority until a
  replacement lands or the date nears. *(packages/llm/src/adapters/openai.ts; 1.AH/Phase-2)*
- [ ] **Host-side SSRF enforcement in `EgressCapability.fetch` (DNS resolve + connect-by-validated-IP + per-hop redirect re-validation)** — the shared SSRF range-primitive (1.AE) covers the **policy** half
  (literal format checks on URLs and hostnames); the **mechanism** half — resolving a hostname to its
  IP, validating the IP against the same range block, pinning the connection to that IP (connect-by-validated-IP),
  and re-validating on every redirect hop — belongs to the host-side `EgressCapability.fetch` (already
  defined in `packages/core/src/tools/types.ts`). When the desktop or CLI surface implements that fetch
  hook, it must apply these runtime checks. The current `assertHttpsBaseUrl` and `refineInFlightMediaPart`
  URL validation are construction-time / seam-ingestion-time policy; they catch malformed URLs but cannot
  catch DNS rebinding or a public hostname resolving to a private IP. **Scope split (resolving the earlier "Phase 2" framing):** the **media** url-carrier mechanism is **pulled into 1.AF** on a new bytes-shaped media-egress capability ([ADR-0043](../decisions/0043-media-egress-failover-rematerialization-ssrf.md)); the **general tool/MCP** `EgressCapability.fetch` enforcement still lands when the desktop/CLI surface implements that fetch hook. *(packages/core/src/tools/types.ts; security-review.md; media → 1.AF/ADR-0043; tool/MCP → surface fetch hook)*
- [ ] **MCP SDK network transport — upgrade to connect-by-validated-IP ([ADR-0053](../decisions/0053-mcp-network-transport-egress-security.md) §2).** 2.R ships **pre-connect host validation** as the floor for the `http` (Streamable HTTP) / `websocket` MCP transports — the `@modelcontextprotocol/sdk` opens its **own** socket, architecturally distinct from the `EgressCapability.fetch` hook above. When the SDK transport exposes an injectable `fetch`/dialer hook, upgrade to **connect-by-validated-IP**: resolve DNS → validate the IP against the shared range-block primitive → connect to that IP, re-validating on each redirect hop — closing the residual DNS-rebind window. **The dialer + redirect re-validation MUST enforce the authored `host:port`** (ADR-0053 §3 / SEC-EGRESS-3), not just the host: an `allow_local_endpoint` server is permitted exactly its declared `host:port`, so a resolved/redirected target on a *different* port of the same permitted-private host (`:6379`/`:5432`/`:22`/the Docker socket) must be re-blocked. (2.R's pre-connect floor is host:port-safe by construction — the SDK dials exactly the one authored url — so this constraint binds the dialer, not the floor.) Each MCP network mechanism gets a dedicated security-review pass when it lands. *(packages/mcp/src; ADR-0053 §2/§3; ADR-0043 mechanism)*
- [ ] **MCP `stdio` spawn — import-trust/consent gate + `npx` dependency pinning ([ADR-0052](../decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §2).** Spawning a declared `stdio` MCP server runs arbitrary local code / an `npx`-installed package. 2.R treats a server declared in the user's **own** committed YAML as author trust; the **imported/shared untrusted workflow** case is out of baseline scope. When the import/share path matures, gate the first spawn of a server from an untrusted-provenance `.relavium.yaml` behind explicit consent, and pin the `npx` package version/integrity for the built-in auto-install servers. *(packages/mcp/src; apps/cli; ADR-0052 §2; ADR-0029 trust model)*
- [x] **MCP host boundary — strip `McpConnectError.cause` from `--json` / event output (2.R Step 3, [ADR-0052](../decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §2).** *Resolved in the 2.R Step 3 host wiring:* `startMcpClientFailLoud` (apps/cli/src/engine/mcp-servers.ts) wraps an `McpError` into a typed `CliError` whose message is the secret-free MCP summary with **no** `{ cause }` attached, and the top-level `--json` renderer (apps/cli/src/process/render-error.ts) serializes only `{ type, code, message }` — never `cause`. Regression-locked by `run.test.ts` (`expect(err.cause).toBeUndefined()`). *(apps/cli; packages/mcp/src/errors.ts; 2.R Step 3)*
- [ ] **MCP network transport — header-based auth ([ADR-0052](../decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §6).** 2.R injects `{{secrets.*}}` only into a **stdio** child's `env`; the network (`http`/`websocket`) specs carry only `{ url }`, so a network server's `env` is **rejected at parse** (fail-closed, never silently dropped). When network MCP servers need credentials, add a host-resolved auth-header field (e.g. `Authorization: 'Bearer {{secrets.<name>}}'`) wired through the SDK transport's `requestInit`/headers, resolved from the same isolated `mcp-secret:*` namespace and never logged/serialized. *(packages/mcp/src/sdk-http.ts; apps/cli/src/engine/mcp-servers.ts; ADR-0052 §6)*
- [ ] **MCP follow-ups (non-security).** A durable cross-invocation **tool-list cache** (mcp-integration.md ~1h per-`(command,args)`, with a transport-covering key) — 2.R re-runs discovery per process ([ADR-0052](../decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §3); and a generalized **`SecretResolver`** seam beyond the 2.R `mcp-secret:*` keychain namespace ([ADR-0052](../decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §6); and reconciling the `types.ts` `ToolId` "register dynamically" comment to "host-side assembled" when 2.R touches `packages/core`; and **mid-call abort propagation** — the engine's `AbortSignalLike` is not forwarded to the in-flight MCP `tools/call` (the SDK transport wants a DOM `AbortSignal`), so a turn cancel tears the connection down but does not cancel an in-flight call (`@relavium/mcp` `manager.ts`). *(packages/mcp/src; packages/core; Phase-3)*
- [ ] **Streaming media triad (`media_start`/`media_delta`/`media_end`) — host-deferred ([ADR-0046](../decisions/0046-inline-media-out-via-generate-streaming-triad-deferred.md) §4).**
  1.AG Section B delivers inline media-out through the non-streaming `generate()` path (the in-flight
  `media` `ContentPart` is de-inlined at `#emitDurable`). The **streaming** triad stays RESERVED: its Node
  de-inline needs a host hook reaching the *pure* adapter (the output twin of `resolveForEgress`, since
  `media_end` is handle-only and the adapter has no `MediaStore`) or the desktop Rust CAS ([ADR-0032](../decisions/0032-desktop-rust-media-de-inline-amends-0018.md)).
  Acceptable because a media-output turn is typically terminal/single-shot, so token-streaming its short
  accompanying text is low value against a frozen-seam change. Wire at **1.AH** (the progressive-preview surface). *(packages/llm/src/types.ts seam; 1.AH)*
- [ ] **OpenAI agentic image-gen via the Responses API — wire deferred ([ADR-0046](../decisions/0046-inline-media-out-via-generate-streaming-triad-deferred.md) §3).**
  The normalized delivery **shape** is defined (a `providerExecuted: true` `tool_result` carrying a
  normalized `media` part — ADR-0031 §4.3/#7) and 1.AG Section B wires the two Chat-Completions inline
  cases (Gemini `responseModalities` → `inlineData`, OpenAI inline audio → `audio`). OpenAI image output is
  **not** a Chat-Completions modality (`modalities` is `text`/`audio` only); agentic image-gen is the
  Responses API `image_generation` built-in tool — a **separate request surface** the Chat-Completions
  adapter does not call. Wire the Responses-API path (request + `image_generation_call` output-item parse →
  the already-defined providerExecuted media shape) when a Phase-1 model needs it. *(packages/llm/src/adapters/openai.ts; post-1.AG)*
- [ ] **Per-model `media_surface` lookup — HOST WIRING deferred (1.AG Section C → 1.AH).** Section C added
  `AgentRunnerDeps.resolveMediaSurface?(model) → MediaSurface` (the inline-vs-generative routing discriminator,
  default `'chat'`; tests inject it). The production wiring — the host reading `model_catalog.media_surface` (the
  column landed in Section A) and supplying the lookup — is **1.AH host-wiring**, exactly like the D12/D15/D17
  host-wiring obligations. Until then `resolveMediaSurface` is absent and **every** model routes inline (`'chat'`),
  so no generative model is runtime-reachable in Phase 1; the engine mechanism + the OpenAI-image adapter are proven
  via injected-surface tests. *(packages/core/src/engine/agent-runner.ts; host catalog read → 1.AH)*
- [ ] **Verified generative model rates + `MODEL_PRICING` rows (1.AG Section C → 1.AH).** The Section C cost
  mechanism (pre-egress estimate + the one realized `cost:updated`) reuses `estimateMediaCost`/`mediaCost`, which
  **degrade to 0 on a missing rate** (H4). No generative model rows were added to `MODEL_PRICING` — fabricating
  billing rates is a mis-bill risk and the existing rows are all "verified". Add the generative rows (gpt-image-1,
  Imagen, OpenAI-TTS, Sora, Veo) with **verified** `mediaOutputRates` (image per-image; audio/video per-second) when
  the catalog/pricing-page values are confirmed; until then a generative call is correctly gated/folded at 0 cost
  (no mis-bill). **Test follow-up:** the realized-cost vertical (`realizedMediaCost` → a non-zero `cost:updated`)
  cannot be exercised end-to-end until a generative model carries a rate; the cost MATH is unit-tested via
  `mediaCost` against a constructed rate, and a non-zero dispatch assertion lands with these rows. *(packages/llm/src/pricing.ts; verified rates → 1.AH)*
- [ ] **Rate-carrying media representation for raw PCM (1.AH A1 known-limitation).** OpenAI TTS `pcm` is headerless
  16-bit LE PCM at 24 kHz, but the seam's `MediaMimeTypeSchema` forbids MIME parameters, so the bare `audio/L16`
  cannot carry `;rate=24000` (RFC 2586's default is 8 kHz) — a consumer of an `audio/L16` part must assume 24 kHz.
  Mirrors the pre-existing chat-audio `pcm16 → audio/L16` convention; the self-describing containers (mp3/opus/aac/
  flac/wav) are unaffected. A rate-carrying media representation (or dropping bare-PCM from the offered set) is the
  fix. Low priority — opt-in niche format only. *(packages/shared/src/content.ts MediaMimeTypeSchema; packages/llm/src/adapters/openai.ts; low · 1.AH/Phase-2)*
- [ ] **Node-retry of a PARKED media job — deferred (1.AG Section D, ADR-0045 §3 "MAY re-dispatch").**
  The node-retry budget (1.S) wraps the executor `#dispatch`; an async media job parks AFTER dispatch returns, and
  the engine's out-of-band poll loop settles a deadline/poll failure as `node:failed` (retryable for a timeout) directly
  — it does NOT re-enter the node-retry wrapper, so a parked media job is not automatically re-dispatched (a fresh paid
  submit) on a retryable timeout. ADR-0045 §3 makes this a **MAY** ("the loop itself never silently re-submits"), so the
  current behavior is conformant; re-dispatching a parked-then-failed media node through the node-retry budget is an
  additive refinement. *(packages/core/src/engine/engine.ts #pollMediaJob; post-1.AG)*
- [x] **Durable realized cost for a FAILED/CANCELLED paid media job — ✅ Done (PR #52, 2.S Part 3).**
  `node:failed`, `run:cancelled`, AND `run:failed` now each snapshot `cumulativeCostMicrocents` onto the durable
  terminal (the `#emitMediaJobCost` fold runs just before the terminal), so a durable-log reader reconstructs a
  billed-but-failed/cancelled media job's cost from the persisted log, not only the live `cost:updated` stream.
  The checkpoint fold reads cost only from `node:completed`, so resume is unaffected (ADR-0045 §5).
  *(packages/core/src/engine/engine.ts; shared/run-event.ts; PR #52)*
- [ ] **Per-modality pre-egress media cost estimate (A6)** — ADR-0028's governor is token-based and
  cannot price a media-gen call. Add a `[defaults].media_cost_estimate` config default (the media
  analogue of `max_tokens_estimate`, in [config-spec.md](../reference/contracts/config-spec.md)) **and** a
  per-model media rate in `pricing.ts`/`model_catalog`; the governor estimates `units × rate` pre-egress.
  **Decided in [ADR-0044](../decisions/0044-media-access-governance-read-media-save-to-cost.md)** (disjoint cost class folded into the existing `max_cost_microcents` cap — **no new cap dimension**; a distinct media count/bytes cap is deferred as additive). *(config.ts; pricing.ts; database-schema.md; wired at 1.AF)*
- [ ] **`partialRef` partial-write semantics (A3, reserved)** — `media_delta.partialRef` ships in the
  frozen triad (1.AD) but is **reserved, host-implementation-defined**; the `MediaStore` contract defines
  only `put(completeBytes)`. Specify append-vs-per-delta-put semantics when the surface that renders
  progressive previews lands. *(1.AH / Phase E)*
- [ ] **`read_media` `workspace` authz scope kind (A8, reserved)** — `read_media` authz is a generic
  `handle → allowedScopes: Set<Scope>` with `Scope = { kind:'session', id }` today; the
  `{ kind:'workspace', id }` kind is **reserved (documented, not implemented)** so cross-session /
  shared-asset reads are an additive scope kind, no handle-model migration. Implement only when a
  shared-asset feature has a real consumer. *(reserved; [ADR-0044](../decisions/0044-media-access-governance-read-media-save-to-cost.md) ships the `session` kind at 1.AF, defers the `workspace` kind)*
- [ ] **`MediaStore` retention/GC + `media_objects` table (defaulted)** — per-distinct-reference
  `refcount` + `last_referenced_at` + grace window, separate from the 90-day `run_events` prune; GC owner
  is the host (Rust desktop / filesystem CLI). **Decided in [ADR-0042](../decisions/0042-engine-media-storage-substrate-mediastore-deinline-retention.md)** — a `media_references` refcount junction + a 7-day-default grace window + a terminal-state sweep; lands with the table at **1.AF**. *(database-schema.md; 1.AF)*
- [ ] **Retire the `vision` derived alias (OQ6 default)** — `CapabilityFlags.vision` is kept as a derived
  alias of `media.input.image` for live consumers (`db.supports_vision`, adapter `supports.vision`);
  schedule removal once those migrate to `media.input.image`. *(types.ts; a later cleanup)*

### 1.AE forward-obligations (PR #32)

- [ ] **Conformance test additions — image-in, audio-in, pdf-in per provider** — the 1.AE media input
  wiring (OpenAI `image_url`/`input_audio`, Anthropic `image`/`document` blocks, Gemini `inlineData`)
  is unit-tested but the conformance replay fixtures don't yet exercise media-in scenarios. Add recorded
  fixture-replay conformance tests per provider: image-in (all three), audio-in (OpenAI, Gemini), pdf-in
  (Anthropic, Gemini). Requires real API calls to record fixtures, then replay — do in a follow-up after
  the PR lands. *(packages/llm/src/conformance/; 1.AE follow-up)*
- [ ] **`mediaUnits` mapping (OpenAI audio tokens, others nil for now)** — `Usage.mediaUnits` ships as
  an optional field (ADR-0031 decision #4) but no adapter populates it yet. OpenAI reports
  `completion_tokens_details.audio_tokens` which maps to `{ modality: 'audio', direction: 'output',
  units: n, unit: 'count' }` (the RAW token count — audio_tokens are tokens, not seconds); Anthropic and Gemini report no media-specific billing counters in their
  current usage shapes. Wire OpenAI audio-token billing at 1.AF when the engine surfaces usage to the
  session; leave Anthropic/Gemini nil until those providers add billing counters. **Report the raw
  `audio_tokens` count (no fabricated tokens→seconds conversion) to avoid mis-billing** ([ADR-0044](../decisions/0044-media-access-governance-read-media-save-to-cost.md)).
  *(packages/llm/src/adapters/openai.ts; 1.AF)*
- [ ] **OpenAI reasoning-model capability matrix (`OPENAI_REASONING_CAPS`)** — o1/o3/o4-mini have a
  separate media capability surface (no audio input, restricted tools, etc.). The current `openai.ts`
  uses one `OPENAI_SUPPORTS` matrix for all GPT models; reasoning models need their own matrix selected
  by model id, paralleling how DeepSeek already has `DEEPSEEK_SUPPORTS`. Wire when reasoning-model
  media support is specified. *(packages/llm/src/adapters/openai.ts; 1.AF/1.AG)*
- [ ] **Handle and URL media source resolution in adapters (`1.AF` MediaStore integration)** — `handle`
  sources (`media://sha256-<hex>`) and `url` sources are accepted at the seam boundary but skipped
  (not wired) in the adapter content-building functions (`toOpenAiUserContent`, `toAnthropicContentBlocks`,
  `toGeminiMediaPart`) with `// handle: resolved at egress by MediaStore (1.AF)` / `// url/handle
  audio: deferred to 1.AF` comments. The engine's `deInlineMedia` + `MediaStore` contract resolves
  handles at egress; URL sources are fetched through `EgressCapability.fetch` (the SSRF mechanism
  half). Wire when the engine plumbing lands (1.AF). *(packages/llm/src/adapters/{openai,anthropic,gemini}.ts; 1.AF)*

### 1.AF P4 forward-obligations — engine policy landed, HOST WIRING deferred (review 2026-06-19)

> The 1.AF P4 engine-pure **policy** (read_media tool + scope-set authz + Range gate, the D15 load-check,
> the D17 cost governor, the save_to write port, the media-reference store) landed and is fully tested.
> The comprehensive 46-agent review confirmed the **host/surface wiring** below is **not yet present** —
> so D12/D15/D17 are inert end-to-end until a host (CLI/desktop, 1.AH/Phase-2) wires them. Recorded here
> so the roadmap is not read as "live end-to-end." None is a defect in the landed policy; each is the
> deferred mechanism/wiring half. *(1.AF is ✅ Done — all PRs merged #33/#34/#35/#36, 2026-06-20; the items
> below remain: `read_media` (D12) was deferred to 2.M, then **split into a dedicated, security-reviewed follow-up**
> (maintainer-approved, 2026-06-26) — the 2.M chat REPL shipped without it (it is engine/db + cross-surface
> security-sensitive work usable by both `run` and `chat`, orthogonal to the REPL). **D15/D17/D8 are now wired by the
> CLI (✅ PR #52, 2026-06-25, checked off below)** — the desktop/VS Code surfaces reuse the same injectable ports
> (Phase-3/Phase-4); the `save_to` multi-feeder semantics remain.)*

- [ ] **`read_media` host `MediaReadAccess` impl + base64 encoder (D12 mechanism)** — there is no host
  factory that bridges `MediaReferenceStore.describe()` + `MediaStore.readRange()` (which returns
  `Uint8Array`) into the `MediaReadAccess` the tool needs (whose `readRange` returns an in-flight **base64**
  `MediaSource`). Until a host provides one, `read_media` cannot be invoked successfully. *(packages/db; read_media D12 follow-up)*
- [ ] **`read_media` session-scope population (D12 authz data, ADR-0044 §1)** — nothing writes
  `session`/`workspace` `media_references` rows (the only writer, `createMediaReferencePort`, writes `run`
  refs only), so `describe().allowedScopes` is always `[]` and every read denies. The input-transfer
  scope-population at the node/session boundary is unimplemented. *(packages/core engine input-transfer + AgentSession; read_media D12 follow-up)*
- [ ] **`ctx.mediaRead` / `ctx.requestingScope` not wired into the dispatch context** — the AgentRunner +
  AgentSession build `ToolDispatchContext` without these, so `read_media` always throws
  `ToolUnavailableError` in the engine path (fail-closed, no leak). *(packages/core/src/engine/{agent-runner,agent-session}.ts; read_media D12 follow-up)*
- [x] **`validateWorkflowWithCatalog` (D15) — wired by the CLI loader (✅ PR #52).** `run` and `gate` call it
  post-parse via `assertWorkflowCatalogValid` (the shared `drive.ts` helper) over the DB `model_catalog`, so an
  incapable / malformed-generative authored `output_modalities` fails fast at LOAD (exit 2) on a fresh run AND a
  resume — not only at the runtime FallbackChain pre-skip. The desktop/VS Code loaders reuse the same
  `WorkflowModelCatalog` projection (phase-3/phase-4). *(apps/cli; PR #52)*
- [x] **`[defaults].media_cost_estimate` → `AgentRunnerDeps.mediaCostEstimate` (D17) — wired by the CLI (✅ PR #52).**
  `config/resolve.ts` reads the key and `media-wiring.ts` / `build-engine.ts` thread it into the engine, so the
  media cost governor uses the configured per-modality estimate (falling back to `DEFAULT_MEDIA_UNIT_ESTIMATE`
  only when unset). *(apps/cli; PR #52)*
- [x] **`resolveForEgress` (D8) — wired by the CLI host (✅ PR #52).** `build-engine.ts` injects the
  `FilesystemMediaStore.resolveForEgress` re-materialization hook, so a durable handle in a transcript message is
  re-materialized on the failover/egress path rather than sent unchanged. *(apps/cli; PR #52)*
- [ ] **`save_to` multi-feeder output semantics** — an output node with several feeders captures a record;
  `save_to` requires exactly one media handle across it (0/>1 → node failure). Document the "which handle"
  contract + add a mixed-feeder test. *(low · workflow-yaml-spec.md + packages/core; 1.AH)*
- [ ] **`save_to` accepts only the `run.id` namespace at LOAD time** — a non-`run.id` ref in `save_to`
  (e.g. `{{ run.outputs[...] }}`) parses, creates a spurious DAG edge, and fails only at runtime. Add a
  load-time check restricting `save_to` to `run.id` so the author gets an immediate error. *(low · packages/core load path)*
- [x] **CAS-orphan crash window for `save_to` — ✅ Done (PR #52).** The host media GC's CAS-orphan sweep
  (`runHostMediaGc` step 3, ADR-0042 §4) deletes row-less CAS bytes (a crash between `put` and `recordObject`) —
  gated on no other active run AND an `orphanMinAgeMs` age-guard so a concurrent writer's fresh blob is never
  swept. *(apps/cli host GC; PR #52)*
- [x] **Clean-terminal media-reclaim retry — ✅ Done (PR #52).** The host media GC's clean-terminal reclaim-retry
  (`runHostMediaGc` step 1) re-attempts `removeRunReferences` for every settled (terminal/gone) run whose inline
  `#reclaimRunMedia` was dropped by a crash — never the current run (the engine reclaims it inline) and never a
  paused run (its media must survive a resume). *(apps/cli host GC; PR #52)*
- [ ] **`save_to` url double-fetch** — a `url`-sourced media part in a save_to output is fetched twice (the
  save_to de-inline + the node:completed emit de-inline; the put dedupes the bytes). Thread one de-inlined
  result into both paths to fetch once. *(low · packages/core/src/engine/engine.ts `#performSaveTo`)*
- [x] **`save_to` resumer-cwd vs original-run project root — ✅ Done (PR #53).** `run` now persists the run's cwd
  to `runs.project_root` at run-start (threaded through `openHistoryStore` → `RunHistoryStoreDeps.projectRoot`),
  and `loadRunSnapshot` returns it; `gate` re-jails `save_to` under that ORIGINAL root (`snapshot.projectRoot ??`
  the resumer's cwd for a pre-column run), so a run started in dir A and resumed from B writes its deliverables
  under A. The `realpath`+`commonpath` jail holds under either root. *(apps/cli + @relavium/db; PR #53)*
- [ ] **Host-GC orchestration is CLI-local (2.S)** — `runHostMediaGc` (the 3 ordered steps: clean-terminal
  reclaim-retry, grace-window byte reclaim, CAS-orphan sweep + the `orphanMinAgeMs` concurrent-writer age-guard)
  is host-agnostic but lives in `apps/cli/src/engine/media-gc.ts`, so the Phase-3 desktop / Phase-6 cloud hosts
  can't reuse it. When a 2nd host wires media GC, promote the pure orchestration to `@relavium/db` (or a shared
  host-helper) and pin the mechanism in a `docs/reference/` home so the hosts can't drift. *(med · apps/cli → @relavium/db; Phase-3+)*
- [x] **`[defaults].media_gc_grace_days` wired (✅ PR #53).** Added to the config Zod schema; `config/resolve.ts`
  resolves it (last-writer-wins) and normalizes DAYS → ms (`mediaGcGraceMs`); `run`/`gate` thread it into
  `sweepHostMediaBestEffort`'s `graceMs`. Absent ⇒ the built-in `DEFAULT_MEDIA_GC_GRACE_MS` (7-day) default
  (ADR-0042 §4c). *(apps/cli + shared config; PR #53)*
- [ ] **Keychain no-raw-key IPC test (ADR-0044 §4 acceptance gate)** — ADR-0044 §4 makes "the keychain bridge
  never returns a raw key from an IPC command" an **explicit 1.AF test deliverable**, bundled with the media
  IPC/byte-delivery review surface. That IPC surface is the desktop/Tauri command layer, which is **unbuilt at
  1.AF** — there is no keychain IPC command to assert against yet — so the test is deferred to the 1.AH host
  bridge that introduces it. The Node-side keychain seam (ADR-0006) exists, but the *no-raw-key-over-IPC* gate
  is meaningful only once the IPC command exists. **Owner: 1.AH (the keychain/media IPC bridge).** Recorded so
  the ADR-0044 §4 acceptance is not silently dropped. *(apps/desktop keychain IPC + a direct test; 1.AH)*
- [ ] **Surface `Usage.mediaUnits` on `cost:updated` (the disjoint per-unit observability axis)** — ADR-0031 A6
  / ADR-0044 §3 intend the per-unit media usage (image per-count, audio/video per-second; a token-based
  provider's audio as `unit:'count'`) to be observable on the `cost:updated` event. Realized media **spend**
  already folds into `cumulativeCostMicrocents` (D17), but the per-unit **counts** are not surfaced: `CostUpdatedEventSchema`
  lives in `@relavium/shared`, which cannot import `MediaUnitsEntry` from `@relavium/llm` (the layering forbids
  shared→llm). Surfacing it requires **relocating `MediaUnitsEntrySchema` to `@relavium/shared`** (llm re-exports
  it; `UsageSchema` keeps using it) — a seam-shape move that wants its own PR. The canonical docs (sse-event-schema.md)
  now reflect the current state (field deferred). *(low · @relavium/shared seam move + run-event.ts + agent-turn.ts emit; a later PR)*

> **2026-06-19 — second (Sonnet) review pass on PR #35.** A full re-review (9 dimensions, double-verified)
> on top of the first review's fixes confirmed **0 blockers/highs in reachable code**; ~17 small fixes
> landed in the follow-up commit. The items below are the **deferred** remainder — a read_media *result-shape*
> contract that the 1.AH wiring must resolve coherently (it touches the inert read_media path, so fixing it in
> isolation now risks conflicting with the 1.AH host design), plus one test-injection gap.

- [ ] **`read_media` result must be schema-conforming for a multi-turn message (1.AH read_media contract).**
  `read_media` returns a `{ type:'media', source:{ kind:'base64', data } }` MediaPart placed in
  `tool_result.result`; on the **next** LLM call `LlmMessageSchema.superRefine` runs `containsInlineMediaBytes`
  over the tool-result part and **rejects inline base64** — so a wired read_media would break the turn. The
  result should carry a **handle** (durable form, resolved on egress by the seam), not inline base64. **Defer
  with the 1.AH host wiring** (it co-decides base64-vs-handle for `MediaReadAccess`): (a) read_media returns a
  handle source; (b) **narrow `MediaReadAccess.readRange`** from `Promise<MediaSource>` to the chosen base64/
  handle form (today the wide type permits a `url`/`handle` source a host could mis-return → I3/SSRF surface);
  (c) **thread `AbortSignalLike`** into `MediaReadAccess.describe`/`readRange` (the only host-delegated path with
  no cancellation, unlike `MediaStore.readRange`). *(Sonnet review HIGH/MEDIUM, latent — read_media is inert;
  packages/core/src/tools/builtins.ts + types.ts; 1.AH)*
- [ ] **Budget-governor media-cost block/warn/fail path has no non-zero-estimate test.** No shipped model
  carries a `mediaOutputRates` row, so `estimateMediaCost` always returns 0 and the governor's media-driven
  `warn`/`fail`/`pause` arm is never exercised end-to-end (the units×rate math IS covered in `mediaCost`/
  `estimateMediaCost` unit tests). Add coverage when a media-priced model lands (or refactor the governor to
  accept an injectable estimator). *(low test gap · packages/core/src/engine/budget-governor.test.ts)*

### Engine/seam policy & surface follow-ups (2026-06-09 hardening-analysis pass)

> A hardening-analysis pass over the seam / fallback / byte-delivery / i18n surfaces (validated against the
> current ADRs) produced these recorded rulings and deferrals. Each stands on Relavium's own architecture.

- [ ] **Score-threshold / partial-success fallback — DECIDED out-of-scope for Phase 1 (Y2).** `FallbackChain`
  (1.K) routing is **binary** classified-retryable-vs-fatal only ([phase-1](phases/phase-1-engine-and-llm.md)
  1.K acceptance); a cross-provider *quality* judgment is a provider-superior decision that ADR-0011's
  capability-gated **lowest-common-denominator** seam explicitly fences out. Quality/score fallback stays an
  **author/node concern** (a judge / `condition` node + branch in the DAG), **not** an `LLMProvider`-seam or
  1.K concern — do **not** fold it into 1.K under any framing. Promote to a separate candidate-ADR **only** if
  a concrete multi-workflow demand for engine-native quality-fallback appears, and even then it must sit
  **above** the seam, never amend the `LLMProvider` contract. *(in-1.K scope: the fallback trigger is a typed
  `LlmError`/run-event, never a string-sentinel — see phase-1 1.K acceptance.)* *([ADR-0011](../decisions/0011-internal-llm-abstraction.md); 1.K)*
- [ ] **Per-host/per-provider TLS-verify granularity — DEFERRED draft-proposal (MD-TLS).** The stance today
  is a single global never-disable ([security-review.md](../standards/security-review.md)), which is strictly
  safer. Per-host granular TLS (for a self-signed / private-CA local gateway) reintroduces the MITM surface
  and would need its own ADR + opt-on/opt-out tests. **Decided: keep the global never-disable stance**;
  revisit a per-host **opt-IN** only when a real private-CA self-hosted consumer lands (the BYOK
  custom-baseURL opt-in-local path already covers the realistic local-endpoint case). *(security-review.md)*
- [ ] **Run-submission idempotency / request-dedup (open — evaluate carefully).** Distinct from the content-addressed
  media cache and any managed-mode metering `request_id`: should an identical run-create request be
  de-duplicated so a double-submit does not start two runs? **Open:** a Phase-1 engine run-create hook vs a
  surface concern. Low-stakes; recorded so it is not lost. *(WorkflowEngine run-create; 1.N)*
- [ ] **i18n CI key-parity + data/code separation (Phase 2+ surface).** When the desktop / CLI / VS Code
  surfaces add i18n: a CI test that **fails** on a missing/extra translation key (parity), **zero conditional
  logic in translation data** (data ≠ code), and a dead/unused-string lint. Recorded now; lands with the
  Phase-2/3/4 surface i18n work (no consumer yet). *(a `docs/standards/` entry or skill; Phases 2–4)*
- [ ] **Pre-egress token-estimate accuracy — watch item (1.AC).** The ADR-0028 governor blocks on
  `worstCaseNextEstimate(maxTokens)` from `[defaults].max_tokens_estimate`. Record the open
  question: does the estimate need provider-accurate token counting (from the seam's model meta /
  usage feedback) to avoid systematic over/under-blocking, or is the declared estimate enough?
  No change now — re-evaluate with real 1.AC telemetry. *(1.AC; ADR-0028)*
- [ ] **Configurable sub-100% budget warning threshold (ADR-0028 amendment).** `budget:warning`
  today is emitted only when a pre-egress estimate would already exceed the cap, on the `on_exceed: warn`
  path (`thresholdPct` reports the observed spent/limit fraction at that point). A user-facing
  early-warning threshold (e.g. `warn_at_pct: 80`) requires amending ADR-0028 to add both a
  config default and a per-workflow `budget.warn_at_pct` field, plus a decision on whether it
  throttles/queues subsequent egresses or only surfaces a one-time advisory event. Deferred until
  there is concrete surface demand or telemetry showing operators need an earlier signal.
  *(1.AC; ADR-0028; config-spec.md; workflow-yaml-spec.md)*

## Interpolation engine (1.L2) follow-ups

> A comprehensive multi-dimensional pre-merge review of **1.L2** (PR #15, merged 2026-06-12) confirmed
> the engine sound and folded every actionable finding. Two cross-layer forward-obligations were
> deliberately deferred (each marked in a code comment); recorded here so the 1.M / 1.R implementers
> see them. The security-critical deferrals — re-tainting `run.outputs` for a secret-derived node
> output, and carrying resolved-interpolation provenance into the untrusted-content-as-data boundary —
> are already **1.O acceptance criteria** (phase-1 §1.O), so they are not duplicated here.

- [ ] **Frozen `ctx` checkpoint transport must use `structuredClone` (→ ctx-threading, not 1.R).**
  `resolveContext` returns an `Object.freeze`d **null-prototype** map so a `__proto__`/`constructor`
  context key is a safe own property. That guard is in-memory only: persisting/transporting it via
  `JSON.stringify` → `JSON.parse` (esp. with a reviver, or merged into `{}`) can re-materialize
  `__proto__` as a real setter. **NB (2026-06-15): ctx-threading landed (the ctx-threading PR) and RE-RESOLVES `ctx` at
  run start AND on resume — it is never carried in `CheckpointState`, so there is nothing to transport.**
  This obligation therefore stays dormant; it only becomes live if a future revision decides to CHECKPOINT
  `ctx` (instead of re-resolving it), at which point that transport MUST use `structuredClone` (never a
  JSON round-trip) and pin it with a test. *(packages/core/src/interpolation/resolve.ts)*

## AgentRunner (1.O) / reasoning-replay follow-ups

> **2026-06-14 1.O pre-implementation review.** [ADR-0039](../decisions/0039-same-provider-reasoning-replay.md)
> scopes the same-provider signed-reasoning replay to **Anthropic signed (non-redacted) thinking** — the case
> 1.O's headline acceptance needs. Two harder per-provider cases are explicitly deferred (recorded here, not
> shipped half-built) because each needs a canonical opaque-continuation carrier (a seam-shape addition tracked
> against [ADR-0030](../decisions/0030-llm-seam-shape-amendment-reasoning-response-format-provider-executed.md)).

- [ ] **Anthropic `redacted_thinking` replay** — the inbound fold drops the opaque `data`
  (`{ type: 'reasoning', text: '', redacted: true }`), so a redacted block can never be lowered back. Faithful
  replay needs the canonical reasoning `ContentPart` to carry an opaque continuation payload; until then a
  `redacted` part is carried as-is and not replayed, and redacted-thinking continuations are out of 1.O scope.
  *(high · packages/llm/src/adapters/anthropic.ts:126-127, packages/shared/src/content.ts:447-450; ADR-0030 follow-up)*
- [ ] **Gemini part-level `thoughtSignature` replay** — Gemini carries the continuity signature on **any** `Part`
  including a `functionCall`; the adapter drops it (`mapContent` reads only name/args) and the canonical
  `tool_call` part has no field for it, so Gemini 3 function-calling continuations cannot replay it (and can
  themselves 400). Needs a continuation-metadata carrier on the canonical `tool_call`/`reasoning` parts plus
  adapter capture/replay. *(high · packages/llm/src/adapters/gemini.ts:193-198, packages/shared/src/content.ts:419-441; ADR-0030 follow-up)*
- [ ] **`output_schema` deep JSON-Schema conformance** — 1.O validates an `agent` node's `output_schema`
  node-side but **parse-as-JSON only** (the seam's `responseFormat` is a request hint; a
  schema-violating-but-valid JSON output, e.g. `{"wrong":true}` for a `{ n: number }` schema, currently
  passes as `completed`). **1.P shares this gap for the `transform` node's optional `output_schema`** — the
  sandbox guarantees the result is JSON-serializable but does **not** check it against the declared schema.
  Deep conformance needs a JSON-Schema validator (Zod cannot consume an arbitrary JSON-Schema), which is a new
  runtime dependency requiring an ADR. *(medium · packages/core/src/engine/agent-runner.ts,
  packages/core/src/engine/node-handlers/transform.ts; error-handling.md)*
- [ ] **Per-attempt model attribution for `agent:token`** — `cost:updated` is always per-attempt-accurate, but
  `agent:token.model` uses `activeModel` (updated from the *succeeding* attempt record, which fires after the
  stream), so a *cross-model pre-content failover* attributes that turn's tokens to the prior model. A precise
  fix needs a `FallbackChain` `onAttemptStart`/attributed-stream hook (a seam change). *(low · packages/core/src/engine/agent-turn.ts; packages/llm/src/fallback-chain.ts)*
- [ ] **Multi-tool result ordering in the turn core** — `dispatchToolCalls` appends tool-result messages in
  dispatch-completion order; for v1.0 (single tool call per `tool_use` stop) this is moot — and 1.V now reuses
  the core on that single-tool path. A parallel-tool provider should order by the accumulator's `toolOrder`;
  re-home to whatever future parallel-tool work first enables it. *(low · packages/core/src/engine/agent-turn.ts; future parallel-tool)*

> **2026-06-14 (PR #18 final review follow-ups).** Confirmed by the multi-dimensional pre-merge review;
> non-blocking, recorded so they aren't dropped.

- [ ] **Parse-time `run.outputs`/`read_file` gate on system-bound fields** — 1.O assembles `system` from
  authored text only (secure), but `system_prompt_append` is collected as a `{{ … }}` reference site
  (`collect.ts`) so the contract *implies* dispatch resolution. A future PR that admits **trusted**
  `{{ inputs }}`/`{{ ctx }}` in system fields must add a parse-time gate **rejecting** untrusted
  `run.outputs`/`read_file` references there (analogous to the secret-taint gate — do **not** drop the field
  from `nodeReferenceSites`, which would remove the existing secret-leak protection). A pinning test already
  asserts an untrusted `run.outputs` value never reaches the system string. *(medium · packages/core/src/interpolation/analyze.ts, collect.ts; SEC-1)*
- [ ] **Multimodal tool-result through the adjacent-message + redaction paths** — all 1.O coverage exercises
  text/JSON tool args + content; confirm image/media tool-result blocks survive the Anthropic adjacent-role
  merge (no dropped blocks / no double-merge with `stripReasoningParts`) and the redaction path. *(low · packages/llm/src/adapters/anthropic.ts; 1.AF)*
- [ ] **Checkpoint/resume of a mid-tool-loop turn** — whether a run paused/resumed between tool dispatches
  reconstructs the message history (assistant turn + partial tool results) consistently. **NB (2026-06-15):
  1.R (PR #22) resumes only at GATE boundaries; a crash mid-tool-loop is non-resumable → reconciled to
  `run:failed` (a started-but-unfinished node re-runs from `pending`). Faithful mid-loop resume needs
  persisted agent message history (`CheckpointState` carries none today) → Phase-2.** *(medium · 1.R/Phase-2)*

## Node-type handlers (1.P) follow-ups

> **2026-06-14 1.P implementation + pre-merge review.** The six non-agent handlers (condition / transform /
> fan_out / fan_in / input / output) landed behind the 1.N seam. A comprehensive multi-dimensional review
> confirmed 18 findings; all blocker/high/medium/low/nit items were folded **in the 1.P PR** — including a
> BLOCKER secret-leak (the `input` handler emitted raw `secret`-typed inputs into events; fixed by threading
> `secretInputNames` onto `NodeExecContext` and masking in the input handler + the expression scope). The
> items below are the deliberately-deferred forward work (maintainer-approved), recorded so they aren't lost.

- [ ] **True `wait_first` early-cancellation of losing branches** — `merge_strategy: first` is implemented
  executor-only: the engine still waits for all branches to settle, then the `fan_in` handler takes the first
  by `branchNodeIds` order. Genuine early-cancel (abort the still-running sibling branches the moment the
  first settles) needs an **engine-owned per-branch cancellation primitive** — the current single run-wide
  `AbortSignal` cannot cancel one branch without cancelling the run, and a handler cannot cancel sibling
  vertices. The engine authors already flagged this as a "1.P refinement" (engine.ts:26-28). Promote to a
  scoped 1.N/engine change (possibly an ADR) only when a real workflow needs it. *(low · packages/core/src/engine/engine.ts, packages/core/src/engine/node-handlers/fan-in.ts; run-plan.md §fan-in)*
- [x] **`secret`-typed input flowing into an agent prompt (1.O parallel to the 1.P fix)** — the AgentRunner
  resolves `{{ inputs.<name> }}` in a `prompt_template` against the **raw** `RunScope` (agent-runner.ts), so a
  `secret`-typed input interpolates raw into a USER message sent to the provider. This is provider **egress**
  the author opted into (not an event-payload leak, so it does not violate the events rule the 1.P fix
  enforces), but whether a `secret`-typed input should be silently interpolated into a prompt — vs masked /
  rejected at parse — is a policy call. **Decided (2026-06-21, maintainer): REJECT AT PARSE** — a
  `{{ inputs.<secret_name> }}` reference inside a `prompt_template` is a parse-time error with a clear
  message (secure-by-default; surfaces author intent explicitly rather than silently egressing or silently
  masking). **Resolved — verified already-satisfied during 2.D (2026-06-22).** The decided policy was
  already enforced by the 1.L2 parse-layer taint analysis: `collectReferences` covers the agent node's
  `prompt_template` (`collect.ts`), `analyzeSecretTaint` flags any tainted reference reaching model-visible
  text, and `parseWorkflow` turns a non-empty result into a `WorkflowSecretLeakError` (`secret_interpolation`)
  before a `WorkflowDefinition` is ever produced — so a run never starts on such a file. Covered by tests for
  the direct case (`analyze.test.ts` "rejects a secret-typed input interpolated directly into a prompt"), the
  transitive-via-`context` case, and `$ref`/registry agents (`analyzeResolvedAgentTaint`). 2.D made
  `relavium run` the first live `prompt_template` consumer and confirmed the guard holds end-to-end; no new
  code was required. *(low → 2.D · packages/core/src/interpolation/analyze.ts + collect.ts + parser.ts;
  security-review.md)*

## Node retry (1.S) follow-ups

> **2026-06-15 1.S implementation (ADR-0040).** The above-chain node-retry budget (Part A — the run loop
> re-dispatches a whole node on a retryable failure, with backoff, bounded by `retry.max`, applied to
> agent/condition/transform/merge nodes) landed. Part B is deferred:

- [ ] **retry-from-node — re-run a settled run from a chosen node (ADR-0040 Part B) → Phase-2.** Deferred
  because the in-memory engine cannot satisfy the design intent simultaneously: re-running on the **same
  `runId`** (so the host dedups completed-upstream side effects via `runId+nodeId+retryCount`) would append
  a **second terminal event** to a settled run, breaking the exactly-one-terminal invariant (ADR-0036) and
  the 1.R Checkpointer fold; a **new `runId`** keeps a single terminal but loses upstream side-effect dedup.
  Reconciling both needs the real persistent store + a **run-attempt model** (a re-run row referencing the
  original) — Phase-2, which already owns the surface trigger. The in-run budget (Part A) is the landed 1.S
  deliverable. *(medium · packages/core/src/engine/engine.ts; ADR-0040 Part B; Phase-2)*

## Checkpoint/resume + human gate (1.R / 1.Q) follow-ups

> **2026-06-15 1.R/1.Q implementation + two pre-merge review passes (PR #22).** The derived `Checkpointer`
> + cross-process `resumeFromCheckpoint` and the `human_in_the_loop` gate (suspend/resume + one-shot
> `setTimer` timeout port) landed; both review rounds' findings were folded in the PR. The items below are
> the deliberately-deferred forward work — each is a **Phase-2** concern that needs real persistence and/or
> a store-level guarantee the in-memory reference cannot provide, recorded so it isn't lost.

- [ ] **Re-arm a still-pending gate's timeout on cross-process rehydration** — `resumeFromCheckpoint` applies
  the target gate's decision immediately, but a *remaining* pending gate (multi-gate run, crash-while-paused)
  is rehydrated without re-arming its timer, so its deadline is lost until the next restart. The data needed
  (`timeoutAction` + `expiresAt`) is now persisted on `human_gate:paused` (PR #22), so no backfill — Phase-2
  crash-reconciliation re-arms from the log against a real clock. *(low · packages/core/src/engine/engine.ts `#seedFromCheckpoint`; Phase-2)*
- [ ] **Content-level workflow-identity guard on resume** — `resumeFromCheckpoint` compares the surrogate
  `workflowId` (catches resuming a *different* workflow → `workflow_mismatch`), but not a *same-slug,
  edited-content* workflow. The stronger guard rides on the frozen `runs.workflow_definition_snapshot` column
  ([database-schema.md](../reference/desktop/database-schema.md)) — a Phase-2 persistence concern wired with
  the real `RunStore`, not the event-derived in-memory state. *(low · packages/core/src/engine/engine.ts; Phase-2)*
- [ ] **Cross-process concurrent gate-resolve (TOCTOU)** — idempotent re-delivery holds within a process
  (`#resolvedGates`) and across processes once the prior process's `human_gate:resumed` is persisted (the
  checkpoint reconstructs `resolvedGateIds`). The residual window — two processes loading the *same* still-pending
  gate before either persists — is closed by a store-level uniqueness constraint on `human_gate:resumed` per
  `(runId, gateId)`, a Phase-2 SQLite/cloud-store guarantee, not the in-memory reference. *(low · checkpoint.ts/engine.ts; Phase-2 store)*

## AgentSession (1.V) follow-ups

> **2026-06-16 — 1.V `AgentSession` (ADR-0024) + 1.AC budget governor (ADR-0028) merged in PR #26** (after two
> pre-merge review passes + a Sonnet multi-dimensional review). The in-memory `AgentSession` entry point landed —
> multi-turn `start`/`sendMessage`/`cancel` over the **shared turn core** (`runAgentTurn`), the hard turn cap →
> `turn_limit`, session-wide cost, emission via an injected `SessionEventSink`. The deferrals below were decided
> while building it; each has a clear later home, recorded so it isn't lost. The still-open follow-ons are **1.W**
> (wire the `SessionEventSink` onto the `RunEventBus` + per-session `sequenceNumber`/`SessionHandle`), **1.X**
> (session persistence + the durable `SessionMessage` schema), resume **1.Y**, export **1.Z**, and the deferred
> cost-event persistence (below) — those are workstreams, tracked in
> [phase-1-engine-and-llm.md](phases/phase-1-engine-and-llm.md), not deferred items.

- [ ] **Faithful cross-turn transcript (tool + reasoning history) → 1.X/1.Z.** 1.V appends only the final
  assistant **text** across turns: the turn core keeps the within-turn `tool_use`/`tool_result` pairs internal
  (so the transcript carries no orphaned `tool_use` and stays protocol-valid), and reasoning is dropped (a
  `signature` is a within-turn same-provider replay token — ADR-0030/0039 — that must not span turns). Carrying
  the full per-turn tool/reasoning history needs the turn core to **expose its intermediate messages**
  (`runAgentTurn` copies its input and returns only final content) — revisit when 1.X persistence / 1.Z export
  needs faithful turns, once `agent-turn.ts` is settled. *(medium · packages/core/src/engine/agent-session.ts + agent-turn.ts; 1.X/1.Z)*
- [ ] **Session budget pause/resume (1.V × 1.AC).** `AgentSession` threads the ADR-0028 `preEgress` hook as a
  pass-through but does **not** handle a `BudgetPauseError`: a non-`AgentTurnError` throw rolls the user message
  back and re-raises (a session has no pause/resume gate machinery in 1.V). The run path maps a budget pause to
  a `paused` node outcome via the human-gate seam; a budgeted session needs the analogous suspend/resume
  lifecycle. Wire it when sessions gain a budget (surface phases). *(medium · packages/core/src/engine/agent-session.ts; ADR-0028)*
- [ ] **Per-session tool narrowing (ADR-0029 narrow-only).** 1.V grants the bound agent's `tools` verbatim; a
  session cannot yet **narrow** them per-session (it may only ever narrow, never widen). Add a session-level
  narrow when a surface needs to restrict a session's tools below the agent's grant.
  *(low · packages/core/src/engine/agent-session.ts; ADR-0029)*
- [ ] **`[chat].max_turns` surface wiring.** The hard turn cap is an **engine-API** knob in 1.V
  (`SessionDeps.maxTurns`, finite default 50); mapping the `[chat]` config default onto it is a surface task
  (the CLI/desktop read `[chat]` and pass `maxTurns`). It is deliberately **not** a Phase-1 `[chat]` field.
  *(low · config-spec.md + surfaces; Phase 2+)*
- [ ] **Session `output_schema`.** 1.V ignores `agent.output_schema` (a chat session is free-form text);
  structured output stays a workflow concern. If a session ever needs it, lower it to `responseFormat` +
  validate node-side (as the AgentRunner does for an `agent` node). *(low · packages/core/src/engine/agent-session.ts)*
- [ ] **Session `{{ctx.*}}` prompt interpolation (surfaced by 2.Q `agent run --input`).** `AgentSession.#runTurn`
  passes the agent's `system_prompt` **verbatim** — it does NOT `resolveTemplate` it against
  `#context.variables` the way the workflow `AgentRunner` interpolates an `agent` node's prompt. So
  `relavium agent run --input k=v` (2.Q) carries the variables in `SessionContext` (visible on `session:started`)
  but a `{{ctx.k}}` placeholder in the agent's prompt is sent to the model **literally**. Wire a `resolveTemplate`
  pass over the session prompt against a `RunScope` built from `context.variables` (deliberately deferred —
  no surface needed it before 2.Q). *(medium · packages/core/src/engine/agent-session.ts)*

## Phase-2 CLI (2.D) follow-ups

> **2026-06-22 2.D (`relavium run`) implementation.** The CLI was wired to `@relavium/core` — the first
> real engine consumer. The planned scope-splits it leans on (rich `ink` TUI → 2.E; finalized `--json`
> envelope → 2.F; interactive gate prompt + `relavium gate` resume → 2.G; durable run history → 2.H;
> provider keys from the OS keychain → 2.C) are tracked as their own workstreams in
> [phases/phase-2-cli.md](phases/phase-2-cli.md) and summarized in the `### relavium run` *Implementation
> status* note in [../reference/cli/commands.md](../reference/cli/commands.md), so they are **not**
> duplicated here. The one item below is an unscheduled security follow-up with no numbered workstream yet.

- [ ] **CLI `ToolHost` is fail-closed — built-in tool host capabilities (filesystem / process / egress)
  are not wired.** 2.D builds the engine's tool registry with an empty `ToolHost` (`createToolRegistry({
  tools: BUILTIN_TOOLS, host: {} })`), so every built-in tool that needs a host capability is cleanly
  *unavailable* rather than backed by an insecure stub. Wiring these capabilities is deliberately deferred
  to a dedicated, **security-reviewed** workstream: the egress half is the existing host-side SSRF item
  above (DNS-resolve + connect-by-validated-IP + per-hop redirect re-validation in `EgressCapability.fetch`),
  and the filesystem/process halves need their own scope/permission model ([security-review.md](../standards/security-review.md)).
  Until then, a workflow whose agent calls a capability-backed built-in tool surfaces a clean "tool
  unavailable" failure, never a half-implemented or unsafe execution. *(medium · apps/cli/src/engine/build-engine.ts;
  security-review.md; egress → the SSRF item above)*
- [ ] **`relavium run` maps any `run:paused` to exit 3 (gate-paused); revisit when media host-wiring lands.**
  `run.ts` returns `EXIT_CODES.gatePaused` (3) for any `run:paused`, which is correct in 2.D because a
  human gate is the **only** `run:paused` source (no `mediaStore`/media-job host is wired, so a media-only
  park — a valid `run:paused` carrying `pendingMediaJobNodeIds` and no gates, per `RunPausedEventSchema` /
  1.AG §D — can never be emitted). When the media host capability lands (the same surface as the deferred
  media-egress work, ~2.S), a media-only park would be reported as "gate-paused" with no gate; at that point
  decide whether exit 3 (and the rendered message) should distinguish a gate park from a media park.
  *(low · apps/cli/src/commands/run.ts; media host-wiring / 2.S)*
- [ ] **`relavium budget resume <runId> [--approve | --abort]` is documented but has no numbered
  workstream.** [commands.md](../reference/cli/commands.md) (canonical) specifies it as the non-interactive
  operator path for a run suspended at a budget cap (`budget:paused`, `on_exceed: pause_for_approval` —
  [ADR-0028](../decisions/0028-workflow-resource-governance.md)), but no Phase-2 workstream implements it. It
  reuses **2.G's** cross-process resume substrate (a budget pause resolves through the same checkpoint reload
  + resume path as a human gate, behind a budget-specific command + flags), so it is a small follow-up once
  2.G lands — candidate home: alongside 2.I, or its own short workstream. **Deliberately out of 2.G** (a
  distinct ADR-0028 surface, not in 2.G's acceptance). *(low · apps/cli/src/commands/; ADR-0028)*
- [ ] **Re-provide `secret`-typed inputs on cross-process resume.** The durable `run:started.inputs` are
  **masked** (a `secret` input is persisted as `{ secret: true, ref }`, never plaintext — ADR-0006/0036), so a
  fresh-process `relavium gate` resume cannot restore the real value. 2.G **fails closed (exit 2)** when a
  restored input is a `MaskedSecret` (`assertNoMaskedSecretInputs`, gate.ts) rather than resume with a broken
  value. The proper fix lets the operator re-supply the secret on resume (e.g. `relavium gate <runId> --secret
  token=…` read from stdin like `provider set-key`, or a keychain/env re-resolution keyed by the input
  `ref`) so a secret-bearing run becomes resumable. Until then the fail-closed + the
  [commands.md](../reference/cli/commands.md) note stand. *(medium · apps/cli/src/commands/gate.ts; ADR-0006)*

### 2.I read-command follow-ups (PR #48 multi-agent review, 2026-06-24)

> The PR #48 review (7-dimension multi-agent pass) returned **0 blocker / 0 major**; the fix-now items (the
> catalog special-file guard + the doc/contract corrections) and the cheap test/code nits landed in the PR.
> The items below were verified-real but graded **fix-followup** — none blocks merge.

- [ ] **History-read query indexes + pagination.** `listRuns`/`listActiveRuns` sort with a `USE TEMP B-TREE`
  filesort (no `(created_at DESC, id DESC) WHERE deleted_at IS NULL` index), and `listRuns`/
  `loadLatestRunPerWorkflow` are unbounded (no `LIMIT`/pagination). Sub-millisecond at single-user CLI scale;
  add a partial index + a paging API before the desktop/cloud surfaces drive these reads at volume.
  *(low → scale · packages/db/src/run-history-store.ts; database-schema.md)*
- [ ] **`AgentParseError` carries no line/column on a YAML syntax fault** — parity gap with `parseWorkflow`
  (which threads `LineCounter` positions into `WorkflowSyntaxError`). Add line/col before the 2.J authoring
  commands surface agent-parse errors to a user. *(low · packages/core/src/agent-parser.ts; before 2.J)*
- [ ] **Residual read-command test pins.** A few low-risk coverage gaps remain after the PR's test additions:
  `pendingHumanGates` with `expiresAt` present and with multiple simultaneous gates; `list --json` no-project
  stderr + invalid-entry `error` machine-contract; the `status` "no node activity" fallback. The production code
  is correct (verified); these are operator-surface pins. *(low · apps/cli/src/**/*.test.ts; testing.md)*
- [ ] **Phase-doc structural views still omit `gate list`.** The §2.I heading + acceptance now name `gate list`,
  but the two Mermaid graphs and the from-scratch wave/dependency tables describe the original plan node and
  were left unchanged (they are the plan, not a live tracker). Fold `gate list` in if those diagrams are ever
  regenerated. *(nit · docs/roadmap/phases/phase-2-cli.md)*

## Phase 2.5.A (tool-environment factory) follow-ups

> **2026-06-28 2.5.A ([ADR-0055](../decisions/0055-cli-host-capability-seam-tool-environment-factory.md)).**
> The shared CLI **tool-environment factory** landed the `fs` + `process` `ToolHost` arms behind one
> `assembleToolEnv({ profile, fsScopeTier, workspaceDir })` seam (read-only chat / read-write run), the
> advertise-filter, the `tool_unavailable` (EA1) fail-closed backstop, and real failed-turn usage (EA2). This
> directly advances the 2.D *"CLI `ToolHost` is fail-closed"* item above — the **fs** and **process** halves are
> now wired and security-reviewed; the **egress** and **os** halves remain deferred (below). The items here were
> confirmed by the PR #60 review passes (a 10-lens excellence workflow + two verify-against-code rounds) and
> deliberately **not** taken in-PR — none blocks the milestone.

- [ ] **`egress` + `os` host arms are still unwired (fail-closed).** 2.5.A wired only `fs`/`process`; a built-in
  needing `egress` (`http_request`/`web_search`) or `os` surfaces a clean `tool_unavailable` (EA1). `egress`
  lands with [ADR-0057](../decisions/0057-cli-chat-modes-and-per-tool-approval.md)/2.5.E behind the per-tool
  approval floor + the existing host-side SSRF primitive (DNS-resolve + connect-by-validated-IP + per-hop
  redirect re-validation); `os` follows the same approval-gated path. *(medium · apps/cli/src/engine/tool-host/;
  security-review.md; the 2.D ToolHost item above)*
- [ ] **Project-tier path-allowlist (`extraRoots`) not yet passed by the factory.** The `project` tier therefore
  behaves as **workspace-only** (it can only narrow the jail, never open a hole — `project` ==
  `sandboxed`-minus-tmp). The real path-allowlist + the native first-run approval arrive with the approval-gated
  surface in 2.5.E. *(medium · apps/cli/src/engine/tool-host/assemble.ts; ADR-0057; built-in-tools.md fs-tier note)*
- [ ] **Write-capable chat is deferred to 2.5.E.** The `relavium chat` default profile is **read-only**, so
  `write_file` is `tool_unavailable` and a declared `full` tier is **clamped to `project`** (an unjailed read
  could exfiltrate `~/.ssh` / `~/.aws`). Per-tool approval ([ADR-0057](../decisions/0057-cli-chat-modes-and-per-tool-approval.md))
  is the gate that unlocks a write-capable / `full` chat. *(medium · apps/cli/src/chat/session-host.ts; ADR-0057)*
- [ ] **Profile-unaware advertise-filter.** `wiredToolIds` narrows the grant by which `ToolHost` **arm** is wired,
  not by the profile's *read-only* posture — `write_file` is still advertised on a read-only chat host and only
  fail-closes at dispatch (`tool_unavailable`). Correct and safe (the dispatch backstop is authoritative), but a
  profile-aware advertise-filter would stop offering an always-denied tool. *(low · apps/cli/src/engine/tool-host/assemble.ts)*
- [ ] **Windows `O_NOFOLLOW` is a no-op (residual append-race).** `O_NOFOLLOW` is `0` on Windows, so the
  symlink-swap TOCTOU on the append path rests on the pre-write `lstat` alone (the non-race case). Append is the
  author-trusted workflow-run path (chat is read-only), so the residual race is accepted for 2.5.A; revisit if a
  write-capable chat lands on Windows. *(low · apps/cli/src/engine/tool-host/fs.ts; Windows-only)*
- [ ] **Deliberate non-fixes from the PR #60 excellence review (recorded, not bugs).** Each was weighed and
  skipped with a reason: (a) **no host-arm memoization** (fs scope-checker, process base-env, exec cache) —
  each would cache a security-relevant `realpath` on an I/O-dominated cold path, defeating the per-call
  re-resolution that catches a mid-session symlink swap; (b) **no tool-name prefix on the shared fs helper
  errors** (`jailExisting`/`assertInScope`/`lexicalTarget`) — they back read/write/list, so a single prefix
  would need `toolName` threading for marginal gain (write-only messages *are* prefixed); (c) the generic
  `guarded()` catch-all stays **reason-only** (the I3 boundary). Re-open only if a concrete need appears.
  *(nit · apps/cli/src/engine/tool-host/)*
- [ ] **Two transitively-covered test gaps.** A chat-session-dispatches-`git_status` e2e (the process arm + the
  session→host dispatch are each tested; the union covers it) and a persister fold of a failed-turn's **real**
  tokens (the fold is error-agnostic and tested; the failed-turn flush fires `turn_completed`). Add explicit
  pins opportunistically. *(low · apps/cli/src/**/*.test.ts; testing.md)*

## Schema / validation hardening

- [ ] **`z.unknown()` payload presence** — `agent:tool_call.toolInput`, `node:completed.output`,
  `human_gate:resumed.payload` validate even when absent. Decide presence per field (force the
  key via a `.superRefine` hasOwnProperty check, or document absence is OK) and add accept/reject
  tests. *(minor · run-event.ts:64,93,124)* **Deferred 2026-06-07:** the obvious per-member
  `.superRefine` is infeasible — these events are members of `z.discriminatedUnion`, which rejects a
  `ZodEffects` member; the correct fix adds the `hasOwnProperty` check to the existing outer
  `RunEventSchema.superRefine` (where the runId/sessionId cross-check already lives). Low value, left
  for the consumer that needs the guarantee.

## Test depth

- [ ] **dist-resolution packaging test** — the migration runner is tested only from `src/`; add
  a smoke test that imports built `dist/index.js` and runs `runMigrations` (the path consumers
  use). *(minor · packages/db/src/client.test.ts)* **Deferred 2026-06-07:** fragile as a Vitest unit
  test (it must import `dist/` which only exists after `turbo run build`, so it would skip or fail
  depending on run order). Belongs in a dedicated post-build packaging-smoke step, not the unit suite.

## Tooling / CI

- [ ] **Local `format:check` via turbo** — CI now runs `turbo run format:check`; consider routing
  the root `format:check` npm script through turbo too so local + CI share the cache. *(minor · package.json:21)*
  **Deferred 2026-06-07:** low-value cache nit that needs a task rename to avoid turbo recursion
  (`//#format:check` is bound by name to the `format:check` script); CI already runs through turbo,
  so only the local cache-share is missing. Not worth the rename churn now.
- [ ] **Enable the live-nightly conformance lane** — the per-provider conformance suite runs in
  fixture mode on every PR, but the scheduled live-API lane is still reserved/commented in `ci.yml`
  (the "enable with the first provider adapter" TODO), and the adapters have now landed (PR #9, M1).
  `1.J` accepted M1 with the live lane **explicitly pending keys**; to actually exercise it,
  uncomment the `schedule:` lane and add the provider API keys (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
  / `GEMINI_API_KEY` / `DEEPSEEK_API_KEY`) as CI secrets. Until then live coverage is a known gap.
  **Decided (2026-06-21, maintainer): defer to Phase-2 workstream 2.K** — enable the live-nightly lane
  together with the 2.K regression harness rather than as a pre-Phase-2 ops chore; fixture coverage holds
  the line until then.
  *(minor → keys · ci.yml, packages/llm/src/conformance/*.conformance.test.ts)*
- [ ] **Leakwatch secret-scanning CI gate** — CI has no secret-scan step. The HodeTech standard
  scanner is **Leakwatch** (never gitleaks); the blocking `ci.yml` step is wired once a
  distribution path for the binary onto Actions runners exists (private release / action). Until
  then scanning runs locally with the installed binary, and test fixtures keep building any
  key-shaped strings via `join()` so no contiguous key literal ever sits in the tree. Exceptions,
  when the gate lands, are documented per finding — never blanket-ignored.
  *(blocked → distribution path · ci.yml, security-review.md)*
- [ ] **Dependency-bump cooling window** — adopt a "no same-day upgrades" posture for runtime
  dependency bumps: a freshly published version waits a cooling period before entering the
  lockfile (supply-chain compromise of a new release is typically detected within days), with a
  documented security-exception path (a CVE fix may skip the window, recorded in the PR). pnpm 9
  has no native knob for this; enforce as review policy now and revisit native enforcement
  (e.g. a minimum-release-age setting) when the toolchain moves to a pnpm major that has one.
  *(policy now, tooling later · pnpm-workspace.yaml, architectural-principles.md)*

## Sonar code-quality backlog

> **2026-06-14 (PR #18 review).** Verified Sonar findings in **already-merged** code (1.L/1.L2/1.T/0.x),
> outside the 1.O diff — kept out of the 1.O feature PR (a behaviour-preserving refactor of merged,
> tested code is its own change, not feature scope). Pick these up in a dedicated `chore: sonar cleanup`
> pass. The 1.O-diff findings (the `tryParseJson` fence regex → string ops, and the `#nodeEmit`
> duplicate cases → fallthrough) were fixed in PR #18; they are **not** listed here.

- [ ] **Duplicated SQL literal in the initial migration (0.x)** — Sonar flags a 4× literal in the
  generated drizzle migration. Migrations are **append-only / generated** (never hand-edited), so this is
  informational — only act if the literal recurs in the *schema source* a future migration regenerates.
  *(critical-by-Sonar / likely won't-fix · packages/db/drizzle/0000_organic_the_santerians.sql:118)*

> **Intentional — not a defect (do not "fix"; recorded so Sonar's generic suggestion isn't re-litigated):**
> `bounding.ts` uses `charCodeAt` deliberately for **WTF-8 lone-surrogate** byte counting (and the
> matching test asserts surrogate pairs per UTF-16 unit) — `codePointAt` would merge pairs and break the
> pinned tests. `type ToolId = string` is a deliberate **semantic domain alias** for readability, not a
> redundant alias.
