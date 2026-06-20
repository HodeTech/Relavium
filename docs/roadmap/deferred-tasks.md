# Deferred tasks — confirmed review findings not yet actioned

> Status: Living

> Last updated: 2026-06-19

- **Related**: [current.md](current.md), [README.md](README.md), [phases/phase-0-foundations.md](phases/phase-0-foundations.md)

A holding pen so confirmed-but-deferred findings don't get lost. Every item here was
**adversarially confirmed** by a comprehensive review (the Phase-0 97-agent workflow, or a
later per-PR review pass) but was deliberately **not** fixed in that pass — either because it
needs a maintainer decision, is below the bar for its pass, or is an optimization whose
risk/benefit favors waiting. None block a shipped milestone. Pick them up opportunistically
(most fit naturally into the work that first touches the file) or in a dedicated hardening pass.

Severity is the review's verified rating. Check an item off in the PR that resolves it.

> **2026-06-07 hardening pass + maintainer decisions:** the built-package items (shared / db / llm /
> root tooling / docs) were re-verified against current code and **29 were resolved**, then the seven
> open decisions were ruled: **`$ref`** (keep the door open — schema now accepts the union, engine
> resolves the file), **config strictness** (`.strict()`), **`engine-strict`** (enforce), **branded
> ids** (plain strings stay — code-style note), and **turbo `inputs`** (keep the safe default) are all
> settled and checked off. **Still open:** the **`LICENSE`** (HodeTech is drafting its own commercial
> license), **blocked** work (live-nightly keys, non-Anthropic pricing — needs the live pages), and
> **three explicitly deferred** items (each annotated with why: the `z.unknown()` presence check, the
> dist packaging smoke test, and local `format:check` via turbo).
>
> **2026-06-08 multimodal decision pass:** **first-class multimodal I/O** is now fully designed and
> decided — the analysis ([multimodal-io-design-2026-06-07.md](../analysis/multimodal-io-design-2026-06-07.md)),
> [ADR-0031](../decisions/0031-llm-seam-shape-amendment-multimodal-io.md) (seam) +
> [ADR-0032](../decisions/0032-desktop-rust-media-de-inline-amends-0018.md) (desktop Rust de-inline)
> landed, nine maintainer decisions (A1–A9) ruled, and implementation scheduled as the **1.AD–1.AH**
> sub-spine (1.m6). The item is checked off; its **not-yet-coded pieces are carried as the seven
> multimodal forward-obligations** below (SSRF primitive, async-job ADR, media cost estimate, `partialRef`
> semantics, `workspace` authz scope, retention/GC table, `vision`-alias retirement) so nothing is lost.

> **2026-06-10 engine/tooling review pass (landed in PR #12, merged 2026-06-11):** a review of the
> engine, tool, and CI surfaces against the current contracts produced a small set of additions,
> recorded in their sections below: the **tool-output size gate + spill-to-disk** (1.T),
> **conformance tool-loop / cache-hit scenarios** (1.F follow-up), a **token-estimate accuracy** watch
> item (1.AC), the **Leakwatch CI gate** (deferred pending a distribution path), and a
> **dependency-bump cooling window** (pending a pnpm major). The same pass settled three decisions
> outside this file: the MCP client dependency and scheduling (ADR-0034 / workstream 2.R), the
> reserved `on_error` edge kind (workflow-yaml-spec.md), and the `turn_limit` `ErrorCode`
> (constants.ts + sse-event-schema.md). It also landed a CI **engine dependency-allowlist guard**
> (`tools/engine-deps/check.mjs`) and the pnpm **install-script allowlist**.

## Decisions needed (maintainer call)

- [x] **Workflow `agents:` `$ref` support** — the
  [workflow YAML spec](../reference/contracts/workflow-yaml-spec.md) allows an `agents:`
  entry to be a `$ref` to an external `.agent.yaml`, but `WorkflowSpecSchema.agents` accepted
  inline `AgentSchema` only. **Decided (2026-06-07): keep the door open** — `agents:` now accepts
  `z.union([AgentSchema, AgentRefSchema])` (`{ $ref }`, `.strict()`); the duplicate-id check skips
  `$ref` entries; **file/path resolution + path-traversal/SSRF hardening stay the engine's job**
  (the pure/sync shared schema never reads files). Code now matches the spec. *(workflow.ts)*
- [x] **Branded id types** — `runId`/`nodeId`/`gateId`/`workflowId`/`agentId` are all plain
  `string`. **Decided: plain strings stay** (deliberate) — recorded in
  [code-style-typescript.md §Naming](../standards/code-style-typescript.md); validation is at
  the Zod boundary and branding adds cross-seam friction for little payoff. Revisit via an ADR if a
  real id-mixup bug class appears. *(minor · packages/shared/src/run.ts, node.ts)*
- [ ] **`LICENSE` file + root `license` field** — the public repo has neither.
  **Decided (2026-06-07): HodeTech will author its own commercial/proprietary license** — left open
  until that license text is drafted (do NOT drop in an `UNLICENSED`/OSS placeholder in the
  meantime). When ready, add the `LICENSE` file + the root `package.json` `"license"` string.
  *(nit → pending the drafted license · package.json, repo root)*
- [x] **`node:started.nodeType` enum vs free string** — currently an unconstrained
  `nonEmptyString`. Decide whether the SSE event should carry the engine node-type enum
  (add `ENGINE_NODE_TYPES` to constants and `z.enum(...)`) or stay free-string for
  forward-compat, and record the choice. *(nit · packages/shared/src/run-event.ts:47)*
- [x] **`MaskedSecret` named contract** — `run:started.inputs` documents secret masking only
  in a comment. Export a `MaskedSecret` type/schema (`{ secret: true; ref: string }`) so the
  masked shape is a named contract every surface renders. *(nit · run-event.ts:39)*
- [x] **`composite`/project references (reconcile 0.B)** — phase-0-foundations.md 0.B calls
  for `composite`/project-reference tsconfig fields that were not implemented. Either add a
  `packages/*` library base with `composite: true` + `references` (db → shared) and build via
  `tsc -b`, or record that turbo `^build`-ordering is the deliberate final design and update
  the 0.B callout. *(minor · tsconfig.base.json, packages/*/tsconfig.json)*
- [x] **First-class multimodal I/O (the `vision` flag is only the tip)** — `vision: true` is set for
  Anthropic / OpenAI / Gemini, yet `ContentPart` had no media arm, so media could only reach a provider
  through the `providerOptions` escape hatch in a vendor-specific shape. **DONE (2026-06-08): analysis +
  ADRs landed, decisions ruled, scheduled.** The design analysis is
  [multimodal-io-design-2026-06-07.md](../analysis/multimodal-io-design-2026-06-07.md) (three-perspective
  adversarial review, 8 blocking issues resolved); the binding records are
  [ADR-0031](../decisions/0031-llm-seam-shape-amendment-multimodal-io.md) (the seam amendment — media
  `ContentPart`/`StreamChunk` arms, `CapabilityFlags.media` with `input{image,audio,video,document}` +
  `outputCombinations`, `Usage.mediaUnits`, `LlmRequest.outputModalities`, reserved
  `generateMedia?`/`pollMediaJob?`, the `MediaStore`/`deInlineMedia`/handle model) and
  [ADR-0032](../decisions/0032-desktop-rust-media-de-inline-amends-0018.md) (desktop Rust-side
  de-inline). **Nine maintainer decisions (A1–A9)** are recorded in ADR-0031's *Maintainer decisions*
  table. **Implementation is scheduled as the 1.AD–1.AH sub-spine (1.m6,
  [phase-1](phases/phase-1-engine-and-llm.md))** — 1.AD (seam shape) lands before 1.K/1.O; 1.AE–1.AH are
  additive. The residual forward-obligations below carry the not-yet-coded pieces so nothing is lost.
  *(content.ts; the adapters' `*_SUPPORTS`; [llm-provider-seam.md](../reference/shared-core/llm-provider-seam.md))*

### Multimodal forward-obligations (carry the not-yet-coded pieces — see ADR-0031)

- [x] **Media-arm integrity metadata (Y3) — DECIDED 2026-06-09 (ADR-0031 amended), land at 1.AD.** The
  durable form (`DurableMediaPart`) carries an optional **`byteLength?`** + audio/video **`durationMs?`**,
  host-populated at the `deInlineMedia` boundary; **no `checksum`** (the `media://sha256-<hex>` handle IS
  the sha256); **no `width`/`height`** in Phase A (render-only). **Must ship in the 1.AD seam shape**
  (before 1.K/1.O exhaustive consumers) — adding a union-arm field later is breaking. `byteLength` is what
  the byte-delivery Range check bounds against. *(ADR-0031 "Amended 2026-06-09"; multimodal-io-design §3.2; 1.AD)*
  **✅ Landed at 1.AD (PR #11, 2026-06-10):** `byteLength?`/`durationMs?` ship on `DurableMediaPart` only
  (the in-flight arm stays lean — parse-stripped, tested), with the `durationMs`-is-audio/video-only rule
  enforced on both the standalone schema and the durable union.
- [x] **Shared SSRF range-primitive (the `url`-carrier precondition)** — the one shared HTTPS-only /
  block-private-loopback-link-local-metadata-CGNAT / DNS-resolution + per-hop-redirect-revalidation /
  IPv4-mapped-IPv6-decode primitive that `assertHttpsBaseUrl` (openai.ts) is the best-effort placeholder
  for. security-review.md mandates **one** primitive across all egress paths; the media `url` carrier
  (input + provider-returned output) is gated **feature-flag-OFF** until it lands. **Landing (1.AE, PR #32):**
  `isPrivateOrLocalHost()`, `extractHttpsHost()`, `urlHasCredentials()` shipped in `@relavium/shared`
  (pure sync, platform-free) with 40+ SSRF tests. `assertHttpsBaseUrl` in openai.ts delegates to the
  shared functions + `new URL()` normalization. `MEDIA_URL_SOURCE_ENABLED` flipped to `true` with
  per-URL SSRF validation at the seam boundary (`refineInFlightMediaPart`). The host-side DNS/connect
  enforcement for the **media** url path is pulled into 1.AF on a new bytes-shaped media-egress capability ([ADR-0043](../decisions/0043-media-egress-failover-rematerialization-ssrf.md)); the general tool/MCP fetch enforcement lands with that surface hook (see below).
  *(security-review.md; openai.ts; 1.AE)*
- [ ] **Host-side SSRF enforcement in `EgressCapability.fetch` (DNS resolve + connect-by-validated-IP + per-hop redirect re-validation)** — the shared SSRF range-primitive (1.AE) covers the **policy** half
  (literal format checks on URLs and hostnames); the **mechanism** half — resolving a hostname to its
  IP, validating the IP against the same range block, pinning the connection to that IP (connect-by-validated-IP),
  and re-validating on every redirect hop — belongs to the host-side `EgressCapability.fetch` (already
  defined in `packages/core/src/tools/types.ts`). When the desktop or CLI surface implements that fetch
  hook, it must apply these runtime checks. The current `assertHttpsBaseUrl` and `refineInFlightMediaPart`
  URL validation are construction-time / seam-ingestion-time policy; they catch malformed URLs but cannot
  catch DNS rebinding or a public hostname resolving to a private IP. **Scope split (resolving the earlier "Phase 2" framing):** the **media** url-carrier mechanism is **pulled into 1.AF** on a new bytes-shaped media-egress capability ([ADR-0043](../decisions/0043-media-egress-failover-rematerialization-ssrf.md)); the **general tool/MCP** `EgressCapability.fetch` enforcement still lands when the desktop/CLI surface implements that fetch hook. *(packages/core/src/tools/types.ts; security-review.md; media → 1.AF/ADR-0043; tool/MCP → surface fetch hook)*
- [ ] **Async media-job ADR (`generateMedia`/`pollMediaJob` behavior, A5)** — the seam shape is reserved
  now (1.AD); the engine-owned **poll / checkpoint / resume / cancel loop** for minute-scale LROs
  (Sora/Veo) — in the run loop (1.N) + checkpointer (1.R), reusing `LlmError` classification — gets **its
  own ADR written at 1.AG (Phase D)**. Highest behavioral complexity in the multimodal design. *(1.AG)*
  **Section-C wiring obligation (from 1.AG Section B):** the `requestsMediaOutput` guard in
  [`agent-turn.ts`](../../packages/core/src/engine/agent-turn.ts) currently routes a media-output turn to the
  inline `generate()` path on the non-text-`output_modalities` signal ALONE — ADR-0046 §1's full condition is
  `media_surface: 'chat'` **and** a non-text `output_modalities`. The `'chat'` conjunct is vacuously true in
  Section B (every media-capable model is `'chat'`), so it is omitted with a forward-`NOTE` in the guard's
  JSDoc. When the generative dispatch lands (Section C, ADR-0045), the guard MUST additionally require the
  resolved model's `media_surface === 'chat'`: a `'generative'` model routes to `generateMedia`, not here. *(1.AG Section C)*
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
- [ ] **`generateMedia` for OpenAI-TTS audio + Gemini-Imagen — adapter wires deferred (1.AG Section C → 1.AH).**
  Section C wires `generateMedia` SYNC for **OpenAI image** (gpt-image-1 `images.generate` → base64), proving the
  full engine→adapter→de-inline vertical. The remaining generators are bounded follow-ups: **OpenAI-TTS audio**
  (`audio.speech` returns raw bytes → the adapter must base64-encode them + map the requested `response_format` →
  MIME) and **Gemini-Imagen** (`generateImages` → `generatedImages[].image.imageBytes`, which needs a
  `GeminiTransport.generateImages` extension to keep conformance vendor-free). Neither is runtime-reachable until the
  per-model surface lookup is host-wired (above), so they land with that 1.AH wiring. Two bounded image follow-ups
  ride along: (a) **multi-image `count > 1`** — the SYNC `MediaGenResult.media` carries a SINGLE part, so the OpenAI
  adapter currently rejects `count > 1` (never bill-N-deliver-1); delivering N needs an additive `media: MediaPart[]`
  seam amendment (ADR-0031). (b) **image-gen knobs** (`size`/`quality` via `MediaGenRequest.providerOptions`) — the
  engine does not yet populate `providerOptions` for a generative call, so the adapter threads only the output format
  (`req.mimeType`); a typed per-knob passthrough lands when the engine wires image knobs. *(packages/llm/src/adapters/{openai,gemini}.ts; types.ts MediaGenResult; 1.AH)*
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
> below remain, owned by 1.AH.)*

- [ ] **`read_media` host `MediaReadAccess` impl + base64 encoder (D12 mechanism)** — there is no host
  factory that bridges `MediaReferenceStore.describe()` + `MediaStore.readRange()` (which returns
  `Uint8Array`) into the `MediaReadAccess` the tool needs (whose `readRange` returns an in-flight **base64**
  `MediaSource`). Until a host provides one, `read_media` cannot be invoked successfully. *(packages/db; 1.AH)*
- [ ] **`read_media` session-scope population (D12 authz data, ADR-0044 §1)** — nothing writes
  `session`/`workspace` `media_references` rows (the only writer, `createMediaReferencePort`, writes `run`
  refs only), so `describe().allowedScopes` is always `[]` and every read denies. The input-transfer
  scope-population at the node/session boundary is unimplemented. *(packages/core engine input-transfer + AgentSession; 1.AH)*
- [ ] **`ctx.mediaRead` / `ctx.requestingScope` not wired into the dispatch context** — the AgentRunner +
  AgentSession build `ToolDispatchContext` without these, so `read_media` always throws
  `ToolUnavailableError` in the engine path (fail-closed, no leak). *(packages/core/src/engine/{agent-runner,agent-session}.ts; 1.AH)*
- [ ] **`validateWorkflowWithCatalog` (D15) is called by no production loader** — exported + tested, but
  no parse/load path invokes it, so authored `output_modalities` are not load-validated (the runtime
  FallbackChain pre-skip — now wired onto the request — is the only backstop). A host should call it
  post-parse with the DB `model_catalog`. *(CLI/desktop load path; 1.AH/Phase-2)*
- [ ] **`[defaults].media_cost_estimate` → `AgentRunnerDeps.mediaCostEstimate` (D17)** — the config key +
  the dep both exist but nothing reads the config and threads it into `createAgentNodeExecutor`, so
  `buildMediaUnitsEstimate` always uses the built-in `DEFAULT_MEDIA_UNIT_ESTIMATE`. *(host executor construction; 1.AH/Phase-2)*
- [ ] **`resolveForEgress` (D8) not wired in the engine path** — the FallbackChain re-materialization hook
  is never injected by the AgentRunner, so a durable handle in a transcript message is sent unchanged (no-op);
  the D7/D8 failover re-materialization is inert until the host wires `resolveForEgress`. *(packages/core/src/engine/agent-runner.ts; 1.AH/Phase-2)*
- [ ] **`save_to` multi-feeder output semantics** — an output node with several feeders captures a record;
  `save_to` requires exactly one media handle across it (0/>1 → node failure). Document the "which handle"
  contract + add a mixed-feeder test. *(low · workflow-yaml-spec.md + packages/core; 1.AH)*
- [ ] **`save_to` accepts only the `run.id` namespace at LOAD time** — a non-`run.id` ref in `save_to`
  (e.g. `{{ run.outputs[...] }}`) parses, creates a spurious DAG edge, and fails only at runtime. Add a
  load-time check restricting `save_to` to `run.id` so the author gets an immediate error. *(low · packages/core load path)*
- [ ] **CAS-orphan crash window for `save_to`** — `#performSaveTo` puts bytes (CAS) before the
  node:completed emit records the `media_objects` row; a crash between them leaves row-less CAS bytes that
  `reclaimExpired` (which keys off rows) can never reclaim. Needs a host CAS-orphan sweep. *(low · packages/db host GC; 1.AH/Phase-2)*
- [ ] **Clean-terminal media-reclaim has no retry** — `#reclaimRunMedia` is best-effort at the terminal;
  a transient async-host rejection on a cleanly-completed run leaves the `run` refs (resume short-circuits
  on a terminal checkpoint). Consider a host periodic sweep keyed on terminal run events. *(low · host GC; 1.AH/Phase-2)*
- [ ] **`save_to` url double-fetch** — a `url`-sourced media part in a save_to output is fetched twice (the
  save_to de-inline + the node:completed emit de-inline; the put dedupes the bytes). Thread one de-inlined
  result into both paths to fetch once. *(low · packages/core/src/engine/engine.ts `#performSaveTo`)*
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
- [x] **Tool-output size/token gate + spill-to-disk (1.T).** Today only the *event* `outputSummary` is
  truncated; the tool result handed back to the model has no bound, so one oversized `read_file` /
  `http_request` / MCP result can blow the context window (a cost/DoS surface ADR-0028's pre-egress
  governor cannot see, since the damage lands in the *next* request). Add to the `ToolRegistry`
  dispatch path (1.T): a byte/token ceiling per tool result with an explicit truncation marker, and
  for over-threshold output (e.g. >2000 lines / >50KB) spill the full output to a workspace-scoped
  file and hand the model a bounded preview + the path (readable via the normal FS-scope-tiered
  tools). Behavior belongs in [built-in-tools.md](../reference/shared-core/built-in-tools.md) when
  implemented. *(1.T; built-in-tools.md)* **✅ Landed in 1.T:** `boundForModel` (bounding.ts) applies a
  byte+line ceiling, emits a head/tail preview + explicit truncation marker, and spills the full text to
  the host's run-scoped `outputStore` (handle in the marker); applied in `registry.dispatch` (returns
  `truncated`) under the one cancellation-precedence ladder. Documented in
  [tool-registry.md §result-bounding-and-spill-to-file](../reference/shared-core/tool-registry.md#result-bounding-and-spill-to-file).
- [x] **Cumulative cost is not restored on cross-process resume (cost-event persistence) — 1.AC/1.R.** **Done
  (maintainer-approved, the node:completed-carry variant).** `cost:updated` is streamed (`#nodeEmit` → bus),
  not persisted, so the `reconstructCheckpointState` fold never saw it — a resumed run's
  `cumulativeCostMicrocents` (and the governor) restarted near 0. **Fix:** the durable `node:completed` now
  carries an optional `cumulativeCostMicrocents` (run-event.ts) — a snapshot of the run-wide running total at
  the node boundary, populated by the engine (`#completeNode`) and folded on resume with a monotonic `Math.max`
  that reconciles with the existing `budget:paused.spentMicrocents` restore (checkpoint.ts). So a run paused at
  **any** gate (plain human OR budget) now resumes with the right spend; a gate-less crashed-mid-run is
  reconciled to `run:failed` (not resumed), so its cost-loss is moot. Chosen over persisting `cost:updated`
  (which would add hot-path durable writes + a delivery-ordering change): zero new events, one additive
  forward-compatible field, folds at boundaries the store already persists — no ADR needed. Pinned by a
  checkpoint.test.ts unit test (plain-human-gate restore) + the 1.U flagship harness (post-resume
  `run:completed.totalCostMicrocents` reflects the pre-gate cost). *(packages/core/src/engine/engine.ts `#completeNode` + checkpoint.ts; packages/shared/src/run-event.ts; 1.AC/1.R)*
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

- [x] **Structured-default reference flow (→ 1.M).** *Resolved in 1.M.* Boundary **decided and
  pinned**: a structured input default is **opaque data**, never template-interpolated — only **string**
  defaults carry templates. A `{{ … }}` nested in a structured default (`default: { token: '{{secrets.x}}' }`)
  is therefore neither resolved nor taint-scanned, and is not a leak vector (`resolveTemplate` is
  single-pass, so `{{inputs.cfg | json}}` emits the literal `{{secrets.x}}`, not a resolved secret). Pinned
  by `analyze.test.ts` ("treats a STRUCTURED input default as opaque data"). *(packages/core/src/interpolation/analyze.ts)*
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
- [x] **DeepSeek surviving-reasoning replay** — **Confirmed correct + locked (engine-hardening pass).** The
  OpenAI-compatible adapter CAPTURES `reasoning_content` inbound (`mapContent` → a `reasoning` part) but
  intentionally **drops it on egress** (`toOpenAiMessages` lowers only text + tool_call parts; openai.ts:256-260,
  "reasoning is ephemeral and never replayed, ADR-0030"). For DeepSeek this is the CORRECT direction:
  `reasoning_content` is output-only — the API 400s if it is echoed back in an input message, and
  deepseek-reasoner does not need prior reasoning to continue. So no seam-shape carrier is needed (unlike the
  Anthropic-redacted / Gemini-thoughtSignature items above). Pinned by an openai.test.ts lock-test (a prior-turn
  reasoning part never reaches the request body). *(packages/llm/src/adapters/openai.ts; ADR-0030/0039)*
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
- [x] **Per-attempt pre-egress budget gate (1.AC)** — closed by 1.AC (PR #26). The precise per-egress budget
  check now rides the `FallbackChain` **pre-attempt** hook, so every attempt — including a failover to a pricier
  model — is capped; the loop-top `awaitPreEgress` in `runAgentTurn` adds the zero-egress-on-cancel guard +
  primary-model early check (the intentional double gate). *(closed · ADR-0028; ADR-0038; 1.AC, PR #26)*
- [ ] **Multi-tool result ordering in the turn core** — `dispatchToolCalls` appends tool-result messages in
  dispatch-completion order; for v1.0 (single tool call per `tool_use` stop) this is moot — and 1.V now reuses
  the core on that single-tool path. A parallel-tool provider should order by the accumulator's `toolOrder`;
  re-home to whatever future parallel-tool work first enables it. *(low · packages/core/src/engine/agent-turn.ts; future parallel-tool)*
- [x] **Secret-into-`run.outputs` runtime taint (ADR-0029(c) follow-up)** — an `agent` node cannot launder a
  secret into `run.outputs` (it emits LLM text only), so this is **not** 1.O's to own; it belongs to the
  `transform` / sandbox node (1.P / 1.AB) that can return a secret-derived value. 1.O's only obligation is to
  refuse a tainted `{{ run.outputs[…] }}` reference *if* such a marker reaches it; the static parse-time
  `analyzeSecretTaint` gate covers the authored template graph. Record as a scoped ADR-0029 amendment when 1.P/1.AB
  lands. *(medium · packages/core/src/interpolation/analyze.ts; ADR-0029(c), 1.P/1.AB)* **✅ Closed at the source
  by 1.P (PR #20):** `buildExpressionScope` (scope.ts) masks `secret`-typed inputs out of the sandbox scope, so a
  `transform` / `condition` / fan_in `merge_fn` reads the `{ secret, ref }` marker — never the raw secret — and
  therefore cannot derive a secret value to launder into `run.outputs`. The vector is cut at the read, so no runtime taint
  on the output is needed. (The only remaining secret-into-egress path is the agent prompt — tracked separately
  below as a 1.O policy item, and it is provider egress, not an event-payload leak.)

> **2026-06-14 (PR #18 final review follow-ups).** Confirmed by the multi-dimensional pre-merge review;
> non-blocking, recorded so they aren't dropped.

- [ ] **Parse-time `run.outputs`/`read_file` gate on system-bound fields** — 1.O assembles `system` from
  authored text only (secure), but `system_prompt_append` is collected as a `{{ … }}` reference site
  (`collect.ts`) so the contract *implies* dispatch resolution. A future PR that admits **trusted**
  `{{ inputs }}`/`{{ ctx }}` in system fields must add a parse-time gate **rejecting** untrusted
  `run.outputs`/`read_file` references there (analogous to the secret-taint gate — do **not** drop the field
  from `nodeReferenceSites`, which would remove the existing secret-leak protection). A pinning test already
  asserts an untrusted `run.outputs` value never reaches the system string. *(medium · packages/core/src/interpolation/analyze.ts, collect.ts; SEC-1)*
- [x] **Concurrent-agent dispatch coverage** — N agent nodes run in parallel under `max_parallel`, each
  calling `runAgentTurn` against the **shared** `ToolRegistry`. Verified reentrant (per-call locals; each node
  builds its own `FallbackChain` + `CostTracker`), but there is **no** concurrency test. Add one: two agent
  vertices dispatching the same tool in parallel, asserting gap-free per-node event sequences and no
  cross-node cost/emit bleed. *(low · packages/core/src/engine/agent-runner.ts; engine `max_parallel`)*
  **✅ Added (hardening pass):** `agent-runner.e2e.test.ts` "runs two agent nodes concurrently against the
  shared executor" — `max_parallel: 2`, two agent vertices on one executor instance, asserting a gap-free
  global sequence and that each node's `agent:token` events carry their own `nodeId` (no cross-node bleed).
- [x] **Combined tool-loop DoS bound (turns × corrections)** — **Done (engine-hardening pass).** The
  "product" framing was imprecise: the bounds are NOT multiplicative. `maxToolTurns` is the worst-case
  **egress ceiling** (≤ `maxToolTurns + 1` provider calls); `maxToolCorrections` is a **monotonic sub-budget**
  that can only end the turn EARLY with `tool_failed` (a genuine round never resets it). Documented on
  `AgentTurnLimits` (agent-turn.ts) and pinned by an interleaving test (correctable / genuine / correctable /
  correctable → `tool_failed` at turn 4, far under `maxToolTurns`), asserting corrections accumulate across the
  interleaved genuine round and egress stays bounded. *(low · packages/core/src/engine/agent-turn.ts)*
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
- [x] **Workflow-context (`ctx.*`) threading into expression/agent scope** — the `condition`/`transform`/
  `merge_fn` sandbox scope (and the AgentRunner's prompt `RunScope`) bound `ctx: {}` — the authored
  `context:` namespace was not resolved/threaded (a `{{ctx.key}}` template resolved, but a bare `ctx.key`
  JS-expression read saw `{}`). **✅ Fixed (the ctx-threading PR, 2026-06-15):** the engine resolves the workflow
  `context:` once at run start (a new `#resolveContextOrFail` step using injected
  `WorkflowEngineDeps.resolverCapabilities`, with a `validation` failure path that closes the run), threads
  the frozen `ctx.*` via the new `NodeExecContext.ctx` seam field, and both consumers (`buildExpressionScope`,
  the AgentRunner's `resolvePrompt`) read it; `ctx` is **re-resolved on resume** (not checkpointed). Pinned by
  engine e2e + a transform unit test. *(packages/core/src/engine/engine.ts, node-handlers/scope.ts, agent-runner.ts)*
- [ ] **`secret`-typed input flowing into an agent prompt (1.O parallel to the 1.P fix)** — the AgentRunner
  resolves `{{ inputs.<name> }}` in a `prompt_template` against the **raw** `RunScope` (agent-runner.ts), so a
  `secret`-typed input interpolates raw into a USER message sent to the provider. This is provider **egress**
  the author opted into (not an event-payload leak, so it does not violate the events rule the 1.P fix
  enforces), but whether a `secret`-typed input should be silently interpolated into a prompt — vs masked /
  rejected at parse — is a policy call. Evaluate alongside the secret-handling story; if masked, reuse
  `maskSecretInputs`. *(low · packages/core/src/engine/agent-runner.ts; security-review.md)*
- [x] **Reject a plain (handle-less) edge whose `from` is a `condition` node (1.M validation)** — a `condition`
  routes only via `branches[].target_node`/`default` (materialized edges); a separately-authored plain edge
  `from: <condition>` (no `:handle`) makes its target a dependent that the handler's `selected` never names, so
  the run loop skip-propagates it — a silently-dead downstream rather than a parse error. Add a structural
  validation in `dag.ts` (`validateStructuralEdge`) rejecting a handle-less edge out of a condition (reuse
  `invalid_handle`, or a `condition_requires_handle` kind). Pre-existing 1.M edge-validation gap, not a 1.P
  handler defect. *(low · packages/core/src/dag.ts; workflow-yaml-spec.md §edges)* **✅ Fixed (2026-06-14
  hardening pass):** `validateStructuralEdge` rejects a handle-less edge from a `condition` with an
  `invalid_handle` issue (no existing fixture/spec used one — the spec routes via `branches` + `nodeId:when`
  handles); pinned by `dag.test.ts` and documented in workflow-yaml-spec.md §edges.

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

## Schema / validation hardening

- [ ] **`z.unknown()` payload presence** — `agent:tool_call.toolInput`, `node:completed.output`,
  `human_gate:resumed.payload` validate even when absent. Decide presence per field (force the
  key via a `.superRefine` hasOwnProperty check, or document absence is OK) and add accept/reject
  tests. *(minor · run-event.ts:64,93,124)* **Deferred 2026-06-07:** the obvious per-member
  `.superRefine` is infeasible — these events are members of `z.discriminatedUnion`, which rejects a
  `ZodEffects` member; the correct fix adds the `hasOwnProperty` check to the existing outer
  `RunEventSchema.superRefine` (where the runId/sessionId cross-check already lives). Low value, left
  for the consumer that needs the guarantee.
- [x] **Standalone `MergeNodeSchema` gap** — `merge_strategy:custom` without `merge_fn` only
  fails at `WorkflowSchema` level (a discriminated-union member can't carry the cross-field
  rule). Document the partial node-level validation and add a `node.test.ts` case pinning the
  gap as intentional. *(minor · node.ts:85-92, workflow.ts:104-113)*
- [x] **O(n²) duplicate-id check in `AgentSchema`** — uses `indexOf`-in-`filter` while
  `workflow.ts` uses an O(n) `Set`. Reuse a shared `reportDuplicates` helper so both schemas
  share the single O(n) implementation. *(nit · agent.ts:109-110)*
- [x] **Per-provider temperature ranges** — the shared `temperatureSchema` is the
  provider-agnostic `[0, 2]` envelope, but Anthropic accepts only `[0, 1]`. Enforce/clamp the
  provider's real range in the `@relavium/llm` adapter (Phase 1, where request validation
  lives) so a `provider: anthropic` + `temperature > 1` agent fails fast — without coupling the
  shared contract to a provider's current API limit. *(review · agent.ts, common.ts)*
- [x] **Config-schema strictness parity** — `GlobalConfigSchema` / `ProjectConfigSchema` /
  `ChatConfigSchema` were **not** `.strict()`, so a typo in a committed `config.toml` /
  `project.toml` key was silently dropped — asymmetric with the authored-YAML strictness
  ([ADR-0023](../decisions/0023-strict-authored-yaml-validation.md)). **Decided: fail loud** — all
  three (and their nested `preferences`/`defaults` objects) are now `.strict()`; a typo'd config key
  is rejected at parse. *(minor · packages/shared/src/config.ts)*
- [x] **Codify `ContentPart` / `StopReason` canonical home in the seam doc** — both are intended
  to be **owned by `@relavium/shared`** and re-exported by the `@relavium/llm` seam, never imported
  by shared from llm (which would invert the package dependency). `StopReason` already lives in
  `@relavium/shared` (constants.ts, used by `session:turn_completed`); `ContentPart` lands when
  `SessionMessageSchema` / `AgentSessionSchema` do (1.V/1.X). The seam doc
  ([llm-provider-seam.md](../reference/shared-core/llm-provider-seam.md)) still shows both only as
  local TS shapes with no ownership/re-export statement — annotate them there so the seam doc and
  the `constants.ts` / `run-event.ts` comments stay aligned. *(nit → 1.A/1.V · llm-provider-seam.md)*
- [x] **`AgentSchema` `input_schema` / `output_schema`** — agent-yaml-spec.md lists both as optional
  agent-level fields ("purely additive metadata"), and names `AgentSchema` as their validator, but
  `AgentSchema` is `.strict()` and declares neither — so an authored agent using a spec-sanctioned
  `output_schema` is rejected at parse. Pre-existing (agent.ts untouched by 1.L.0, which scopes
  `output_schema` to the agent/transform *nodes* only); add both as `OutputSchemaSchema.optional()`
  (the node.ts JSON-Schema-subset map) + a test, or amend the spec. *(low · agent.ts,
  agent-yaml-spec.md)*
- [x] **Input-validation type-compatibility** — `WorkflowInput.validation` accepts any key
  regardless of the input `type` (e.g. `format`/`max_length` on a `number`, `min`/`max` on a
  `string`). Bound-ordering (`min ≤ max`, `min_length ≤ max_length`) is enforced; the per-type
  key matrix is not, because the contract (workflow-yaml-spec.md) only shows two examples and
  doesn't define which keys are legal per `InputType`. Specify that matrix, then add a
  `WorkflowInputSchema.superRefine((type, validation) => …)`. *(minor · workflow.ts,
  workflow-yaml-spec.md)*
- [x] **Verify the non-Anthropic prices in `pricing.ts` (at 1.G/1.H)** — the OpenAI / Gemini /
  DeepSeek rows were best-known **placeholders** (Anthropic confirmed via claude-api). **Done
  2026-06-11:** verified against each provider's live pricing page, which revealed five of the six
  non-Anthropic models were deprecated/shut down — retired and replaced with current models
  (gpt-4o→gpt-5.5, gpt-4o-mini→gpt-5.4-mini, gemini-2.0-flash→gemini-2.5-flash,
  gemini-1.5-pro→gemini-2.5-pro), DeepSeek prices corrected (deepseek-chat/-reasoner now distinct,
  ctx 1M / 384K out, deprecating 2026-07-24), and **Claude Fable 5** added; Opus 4.8 / Sonnet 4.6 /
  Haiku 4.5 re-confirmed unchanged. *(packages/llm/src/pricing.ts)*
- [x] **`model_catalog` cache-write column (at the seeder)** — `ModelPricing` carries
  `cacheWritePerMtokMicrocents` (Anthropic charges one), but `model_catalog`
  ([database-schema.md](../reference/desktop/database-schema.md)) has only
  `input/output/cached_input_*_per_mtok_microcents`. When the catalog seeder lands, either add a
  `cache_write_cost_per_mtok_microcents` column or knowingly drop the cache-write price from the DB
  projection (`pricing.ts` stays the source of truth either way). *(nit · database-schema.md)*

## Test depth

- [x] **Coverage glob is cwd-sensitive + no enforced threshold** — `vitest.config.ts`'s
  `coverage.include: ['packages/*/src/**/*.ts']` is repo-root-relative, so a package-scoped run
  (`pnpm --filter @relavium/llm exec vitest --coverage`) reports a false **0%**; coverage is only
  accurate from the repo root. Make the glob cwd-tolerant (or document root-only) and add the
  testing.md **≥90% line+branch** threshold for the engine packages (`packages/core`,
  `packages/llm`) — per-area, since surfaces are smoke-only. *(minor · vitest.config.ts)*
- [x] **Coverage floor fires only on a repo-root run + is not a CI gate** — **Done (engine-hardening
  pass, advisory).** Added a repo-ROOT `pnpm coverage` CI job (ci.yml) — a root run is exactly what makes the
  root-relative per-glob thresholds (`packages/core|llm/src/**`) authoritative, so the package-scoped cwd gap
  (residue 1) is moot. The job is **advisory** (a separate, non-required job like `peer-dep-gate`) so it
  surfaces a regression without blocking merge while the core-package **branch** margin is thin (90.29% vs the
  90% floor); promote it to a required check once that margin is confirmed stable under CI's Node 22. The
  cwd-sensitivity itself stays documented at the thresholds block (a single glob cannot fix it without wrongly
  binding shared/db runs). *(minor · ci.yml; vitest.config.ts)*
- [x] **Column-level schema fidelity** — `client.test.ts` proves only that table *names* exist.
  Add a `PRAGMA table_info(<table>)` assertion per table (name/type/notnull/dflt/pk) against an
  expected fixture, or snapshot `0000_*.sql` byte-for-byte. *(minor · packages/db/src/client.test.ts)*
- [x] **Negative FK test** — insert a `step_executions` row with a non-existent `run_id` and
  assert `/FOREIGN KEY constraint failed/i`, proving `foreign_keys = ON` actually rejects.
  *(minor · packages/db/src/client.test.ts)*
- [ ] **dist-resolution packaging test** — the migration runner is tested only from `src/`; add
  a smoke test that imports built `dist/index.js` and runs `runMigrations` (the path consumers
  use). *(minor · packages/db/src/client.test.ts)* **Deferred 2026-06-07:** fragile as a Vitest unit
  test (it must import `dist/` which only exists after `turbo run build`, so it would skip or fail
  depending on run order). Belongs in a dedicated post-build packaging-smoke step, not the unit suite.
- [x] **In-memory `journal_mode` assertion** — if/when asserting the WAL no-op for `:memory:`,
  assert its `journal_mode` is `'memory'`. *(nit · client.test.ts:50-53)*
- [x] **Edge `from`-handle grammar** — the handle is permissive (uppercase/spaces/repeated
  colons). Decide + pin the grammar (`a:` empty handle rejects; decide on `a:UPPER`/`a:a:b`) and
  tighten the regex if needed. *(minor · edge.ts:14-19, edge.test.ts)*
- [x] **Condition/transform invariants** — add tests: reject `default:'Not Kebab'`; accept
  `when:'foo'`/`when:7`; reject empty `transform`/`expression`. *(minor · node.test.ts)*
- [x] **`record()` non-object reject** — assert `RunSchema.safeParse({ ...run, inputs: 'x' })`
  rejects, pinning the record boundary. *(nit · run.test.ts, run-event.test.ts)*
- [x] **Round-trip fixture verbatim** — the workflow no-drift fixture paraphrases multi-line
  prompts; transcribe them verbatim from the spec or soften the "verbatim" claim. *(nit · workflow.test.ts)*
- [x] **Conformance: tool-loop + cache-hit recorded scenarios (1.F follow-up)** — **Done
  (engine-hardening pass).** Both landed as recorded scenarios across all four provider suites: (1) a
  **multi-turn tool loop** — a new `replayFetchSequence` (+ a `replayFor` single-vs-sequence router; the
  Gemini transport indexes per call) drives two generate() calls against one adapter, so turn 2 exercises the
  adapter lowering a `tool_result` message back onto the provider's wire (the call → result → continuation
  path every agent node runs); and (2) a **prompt-cache-hit** assertion — `ConformanceExpectations.textGenerate`
  gained an optional `cacheReadTokens`, asserted in the textGenerate test (DeepSeek's fixture already records
  `prompt_cache_hit_tokens: 4` → net input 8, cacheRead 4 folds into the one canonical `Usage`). The
  provider-quirk fixture bank can still grow opportunistically as new quirks are met. *(packages/llm conformance)*

## Tooling / CI

- [x] **Turbo task `inputs`** — `lint`/`typecheck`/`test` declare no `inputs`, so turbo hashes every
  file (over-invalidation). **Decided: keep the safe default (hash-all)** — scoping `inputs` risks a
  stale-cache *false pass* (a changed file outside the input set served as "cached green"), which is
  worse than slower cache. Recorded as deliberate; revisit if CI cache time becomes a real cost.
  *(minor · turbo.json:19-30)*
- [x] **`incremental` tsconfig** — no `.tsbuildinfo` reuse; every `tsc` recompiles from scratch.
  Add `incremental: true` (gitignored `tsBuildInfoFile`, listed in turbo `outputs`). *(minor · tsconfig.base.json)*
- [x] **Typecheck the config files** — root/package-root `*.config.ts` (drizzle/vitest) are
  neither typechecked nor linted. Add a `tsconfig.tools.json` + `typecheck:tools` step, or
  document the gap as an accepted boundary. *(minor · drizzle.config.ts, vitest.config.ts)*
- [x] **Concurrency head-ref grouping** — `main` is now protected from cancellation, but a
  same-repo branch push and its open PR still run CI under separate groups. Consider
  `group: ci-${{ github.workflow }}-${{ github.head_ref || github.ref }}` to collapse them.
  *(minor · ci.yml:19-27)*
- [x] **`engine-strict=true`** — `engines` was advisory. **Decided: enforce** — `engine-strict=true`
  added to `.npmrc`, so an unsupported Node/pnpm fails install fast (clear message) instead of
  surfacing as confusing errors later. *(minor · .npmrc, package.json)*
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

- [x] **`readBracket` cognitive complexity (1.L2)** — Sonar 17 > 15; extract the numeric-index vs
  quoted-key branches into helpers. *(critical · packages/core/src/interpolation/path.ts:96)* **✅ Fixed:**
  extracted `readQuotedKey` + `readNumericIndex`; `readBracket` is now a thin dispatcher that delegates
  to them (cognitive complexity well under the threshold).
- [x] **`splitTopLevel` cognitive complexity (1.L)** — Sonar 16 > 15; extract the quote/bracket
  depth-tracking into a small state helper. *(critical · packages/core/src/interpolation/references.ts:217)*
  **✅ Fixed:** extracted a `SplitState` + `splitStep`/`splitStepOutsideQuote` pair; the loop body is one call.
- [x] **`String.raw` for regex-escape literals (1.L test)** — use `String.raw` instead of escaping `\`
  in the interpolation reference fixtures. *(minor · packages/core/src/interpolation/references.test.ts:181-190)*
  **✅ Fixed:** both escaped-quote fixtures now use `String.raw` (template + expected value); tests still green.
- [x] **Negated condition in the glob matcher (1.T)** — Sonar "unexpected negated condition"; flip the
  branch for readability if it does not obscure the backtracking logic. *(minor · packages/core/src/tools/registry.ts:387)*
  **✅ Fixed:** `star !== -1` → the positive valid-index check `star >= 0`.
- [ ] **Duplicated SQL literal in the initial migration (0.x)** — Sonar flags a 4× literal in the
  generated drizzle migration. Migrations are **append-only / generated** (never hand-edited), so this is
  informational — only act if the literal recurs in the *schema source* a future migration regenerates.
  *(critical-by-Sonar / likely won't-fix · packages/db/drizzle/0000_organic_the_santerians.sql:118)*

> **Intentional — not a defect (do not "fix"; recorded so Sonar's generic suggestion isn't re-litigated):**
> `bounding.ts` uses `charCodeAt` deliberately for **WTF-8 lone-surrogate** byte counting (and the
> matching test asserts surrogate pairs per UTF-16 unit) — `codePointAt` would merge pairs and break the
> pinned tests. `type ToolId = string` is a deliberate **semantic domain alias** for readability, not a
> redundant alias.

## Docs

- [x] **Node-runtime row in tech-stack.md** — `runbooks/local-dev-setup.md` defers the Node
  version to tech-stack.md, which states none. Add a row (`.nvmrc` = dev/CI 22; supported floor
  20.11 per `engines`). *(minor · tech-stack.md)*
- [x] **WAL single-writer wording** — soften database-schema.md "concurrent read performance" to
  make the single-writer constraint explicit so engine authors design `run_events` writes around
  one writer. *(minor · database-schema.md)*
- [x] **`vitest.config.ts` include comment** — the stated rationale is inaccurate; rewrite it to
  the real reason (pin to `*.test.ts` so a stray `*.spec.ts` surfaces). *(minor · vitest.config.ts:16-18)*
- [x] **`constants.ts` header overstatement** — clarify that providers/execution-modes are
  consumed by `z.enum`, while event names/node types are a parallel authoritative list the unions
  re-declare and tests pin. *(nit · constants.ts)*
- [x] **`RetrySchema` cross-dep note** — note at the `node.ts` import that `RetrySchema` is owned
  by `agent.ts` and the dependency is one-way (agent.ts must never import node.ts). *(nit · node.ts:1-4)*
- [x] **`cumulativeCostMicrocents` comment** — append the run-scope "running total for the whole
  run" note to match the spec. *(nit · run-event.ts:84)*
- [x] **Per-variant event-type export consolidation** — 3 inline + 10 in a trailing block; either
  co-locate all inline or annotate the trailing block so it isn't read as exhaustive. *(nit · run-event.ts)*

## Packaging

- [x] **Shipped source maps reference `../src`** — published `dist/*.map` point at `src/`, which
  isn't in `files`. Either add `"src"` to `files` or drop `declarationMap`/`sourceMap` from the
  `*.build.json`. Bounded by `private: true` for now. *(nit · tsconfig.base.json, package.json `files`)*
