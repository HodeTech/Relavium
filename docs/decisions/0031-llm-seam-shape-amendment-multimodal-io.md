# ADR-0031: `@relavium/llm` seam-shape amendment — first-class multimodal I/O

- **Status**: Accepted
- **Date**: 2026-06-08
- **Related**: [0011-internal-llm-abstraction.md](0011-internal-llm-abstraction.md) (the seam ADR this **amends**, not supersedes), [0030-llm-seam-shape-amendment-reasoning-response-format-provider-executed.md](0030-llm-seam-shape-amendment-reasoning-response-format-provider-executed.md) (the same pre-freeze amendment move; the `providerExecuted` arm + ephemeral-signature discipline this reuses), [0032-desktop-rust-media-de-inline-amends-0018.md](0032-desktop-rust-media-de-inline-amends-0018.md) (the desktop Rust-side media de-inline this requires; amends [ADR-0018](0018-desktop-execution-and-rust-egress.md)), [0015-managed-mode-data-handling-and-compliance.md](0015-managed-mode-data-handling-and-compliance.md) (the counts-not-content / pass-through-not-a-store rule the managed-media path reconciles with), [0028-workflow-resource-governance.md](0028-workflow-resource-governance.md) (the budget events media volume feeds; extended with a per-modality media cost estimate), [0023-strict-authored-yaml-validation.md](0023-strict-authored-yaml-validation.md) (load-time validation of `output_modalities`/`outputCombinations`), [0009-git-native-workflow-yaml.md](0009-git-native-workflow-yaml.md) (exported-YAML-carries-handle-not-bytes), [../reference/shared-core/llm-provider-seam.md](../reference/shared-core/llm-provider-seam.md) (the seam's one canonical home), [../standards/security-review.md](../standards/security-review.md) (the shared SSRF range-primitive; the no-bytes invariant), [../analysis/multimodal-io-design-2026-06-07.md](../analysis/multimodal-io-design-2026-06-07.md) (the full design analysis this condenses).

> **Amended 2026-06-09 (Y3 — media-arm integrity metadata).** A refinement, not a reversal: decision #1's
> media arm gains, on the **durable** form (`DurableMediaPart`) only, an optional **`byteLength?`** and an
> optional audio/video **`durationMs?`**; the in-flight arm stays lean (`{ type, mimeType, source, name?,
> transcript? }`). The host populates these at the `deInlineMedia` boundary (the `MediaStore` knows the
> byte count; the host probes duration); `byteLength` is what a Range/byte-delivery request is bounded
> against without trusting a raw file size (see security-review.md byte-delivery rule). **No `checksum`
> field** — the content-addressed `media://sha256-<hex>` handle already *is* the sha256, so a separate
> checksum is pure redundancy. **`width`/`height` are excluded** from Phase A (pure render concern, no
> failover/gating consumer; revisit only with a concrete consumer). This **must land in the 1.AD seam
> shape, before the 1.K/1.O exhaustive consumers exist**, because adding a field to a discriminated-union
> arm afterward is exactly the breaking change this ADR exists to avoid. Decision #1 below is unchanged in
> intent. Full reasoning: [multimodal-io-design-2026-06-07.md](../analysis/multimodal-io-design-2026-06-07.md) §3.2.

## Context

The `@relavium/llm` seam — the request/result/stream/usage/content shapes in
[`packages/llm/src/types.ts`](../../packages/llm/src/types.ts) and
[`packages/shared/src/content.ts`](../../packages/shared/src/content.ts) — is text-and-tools only.
Relavium's product promise is *"connect to any model Relavium offers"* — which must mean send **and**
receive whatever that model supports: image, audio, and **video**, as both input and output, including
a workflow that by rule **generates** a media file. The seam cannot express any of this, and the only
escape (`providerOptions` + `raw`) is request-inbound and vendor-shaped — re-introducing exactly the
coupling ADR-0011 forbids and making the no-bytes-anywhere-durable guarantee unenforceable.

This is the **same situation [ADR-0029](0029-tool-policy-hardening.md)/[ADR-0030](0030-llm-seam-shape-amendment-reasoning-response-format-provider-executed.md)
acted on**: the seam is at the **M1 freeze boundary** with **no consumer beyond the adapters** (the
`FallbackChain` 1.K, the engine, the session layer, the surfaces are all unbuilt). Adding a **member to
a discriminated union** (`StreamChunk`/`ContentPart`) is **breaking to add later** (every consumer's
exhaustive `switch` breaks); adding it now is nearly free. Multimodal I/O is a genuine
**cross-provider** concern (image-in: Anthropic/OpenAI/Gemini; audio-in: OpenAI/Gemini; video-in:
Gemini; image/audio/video-out: OpenAI/Gemini) — not a single-provider quirk for `providerOptions`.
DeepSeek is text-only and confirms media must be capability-gated, never assumed.

Six hard invariants constrain any design: **(I1)** no vendor SDK type crosses the seam; **(I2)** the
seam is platform-free (`tsconfig.seam.json` `types: []`) so a media payload is a base64/URL/handle
**string**, never a `Buffer`/`Blob`; **(I3)** no bytes in run-events/logs/DB/exported-YAML; **(I4)** the
engine has zero platform imports; **(I5)** desktop egress is Rust-delegated over a `Channel<StreamChunk>`
that streams **raw** provider chunks (so inline media bytes cross IPC before WebView normalization);
**(I6)** managed mode is a pass-through gateway, NOT a store, metering counts-not-content. Two latent
bugs are in scope: OpenAI `textOf()` flattens content to a string (vision **advertised but
unsendable**), and the shared SSRF range-primitive is an unfulfilled obligation.

The full analysis — provider reality table, the three-carrier rationale, the adversarial-review
resolutions, and the phased plan — lives in
[multimodal-io-design-2026-06-07.md](../analysis/multimodal-io-design-2026-06-07.md). This ADR records
the decision and the binding guardrails.

## Decision

**We extend the `@relavium/llm` seam shape for first-class multimodal I/O, recorded as an amendment to
(not a supersession of) [ADR-0011](0011-internal-llm-abstraction.md)** — ADR-0011's decision (an
internal provider-agnostic seam in Relavium/Zod types, no vendor type crossing it) is unchanged; this
grows the shape. Canonical types live in
[llm-provider-seam.md](../reference/shared-core/llm-provider-seam.md); `MediaSource`,
`INLINE_MEDIA_CEILING`, and the media arm live in `@relavium/shared/src/content.ts`. The additions:

1. **A MIME-discriminated `media` `ContentPart` arm, FORKED into a flight and a durable variant.** The
   in-flight `{ type:'media', mimeType, source, name?, transcript? }` permits a `base64` source for
   sub-ceiling inputs; the distinct **`DurableMediaPart`** narrows `source` to **handle-only** (no
   `base64` literal in its union), so the compiler proves no bytes reach a durable schema. Modality
   derives from the MIME prefix (one arm covers image/audio/video/`application/pdf`; a new format needs
   zero schema change). The ephemeral provider-hosted id (Gemini `fileUri`, OpenAI `file_id`,
   `audio.id`) is **structurally absent from any `ContentPart`** — it lives only in a process-scoped
   adapter sidecar keyed by `(provider, sha256)`, under the ADR-0030 reasoning-signature discipline,
   reconstructed-from-the-canonical-handle on resume/failover.

2. **A `media_start` / `media_delta` / `media_end` `StreamChunk` triad** (mirroring
   `tool_call_*`/`reasoning_*`). `media_delta` carries **NO base64** (progress + an optional
   `partialRef` handle, see §"Reserved shape" below); `media_end` carries a **handle-only
   `DurableMediaPart`**. This governs the *normalized* chunk; the *raw* desktop IPC path is addressed by
   [ADR-0032](0032-desktop-rust-media-de-inline-amends-0018.md).

3. **A redesigned `CapabilityFlags.media`** — `input:{ image, audio, video, document }` booleans plus
   **`outputCombinations: ModalitySet[]`**, the **closed set of modality-sets a model can emit in one
   turn** (replacing independent output booleans, which mis-advertise wire-invalid combinations like
   Gemini image+audio). The `document` input flag gates `application/pdf` (Anthropic's `document` block,
   OpenAI/Gemini file input) **distinctly from `image`** — a PDF is a separate modality with a separate
   token/cost profile, so folding it into `image` would mis-advertise capability. `vision` is kept as a
   derived alias of `media.input.image` for live consumers (`db.supports_vision`, adapter
   `supports.vision`), removed in a later cleanup. `requiredCapabilities()` validates input modalities
   and **membership** of the requested `outputModalities` in `outputCombinations`, so a media request
   **fails fast** and the `FallbackChain` skips an incapable provider.

4. **`Usage.mediaUnits`** — a disjoint observability+billing axis (`{ modality, direction, units, unit
   }`), **not** folded into tokens and **not** refined against them (a distinct cost class); per-unit
   rates added to the pricing table; doubles as the managed-mode metering record (counts-not-content).

5. **`LlmRequest.outputModalities`** — request non-text output on inline-surface models (the symmetric
   mechanism to ADR-0030's `responseFormat`). OpenAI image-out is the exception: it routes through the
   Responses `image_generation` **built-in tool** (the `providerExecuted` arm), not `outputModalities`.

6. **Optional `generateMedia?` / `pollMediaJob?` on the existing `LlmProvider`** (not a separate sibling
   seam) for separate-endpoint generators. **Landed now as a reserved optional-method shape**, behavior
   wired in Phase D (1.AG). A sync generator (gpt-image-1, Imagen, TTS) resolves immediately; an async
   one (Sora, Veo) resolves a **Relavium-opaque `jobId`** the engine polls (no vendor operation-name
   crosses the seam); `pollMediaJob` failures map onto the existing `LlmError` classification. A
   `model_catalog.media_surface` enum (`chat` | `generative`) data-drives inline `generate()` vs
   `generateMedia()` routing. **The async-job behavior — the engine-owned poll / checkpoint / resume /
   cancel loop for minute-scale LROs — is the single highest-complexity piece and gets its own ADR when
   it is wired (Phase D / 1.AG)**; this ADR only reserves the seam shape.

7. **`tool_result` gains a typed `media: DurableMediaPart[]` field;** raw media bytes in
   `tool_result.result` (`z.unknown()`) are **forbidden** so the typed guard reaches provider-executed
   image-gen results.

8. **StopReason is unchanged:** a media-only inline turn reports `'stop'`; the presence of a `media`
   part in `content` is the signal. No new closed-enum member.

**Alternatives weighed.** *(i)* `providerOptions` + `raw` (rejected: request-inbound only; outbound
media would be a vendor-shaped `unknown`; invisible to capability-gating). *(ii)* A single dual-use
`ContentPart` with a refine for durable-safety (rejected: a refine on a dual-use base also rejects
legitimate in-flight base64 and does not recurse into `z.unknown()` event fields — the type **must**
fork, and de-inlining **must** be an active emit-time pass). *(iii)* Independent output booleans
(rejected: advertise wire-invalid combinations; replaced by `outputCombinations`). *(iv)* A pure base64
carrier as default (rejected: memory/IPC tax + leak surface; kept as the bounded tiny tier). *(v)* A
pure handle carrier as sole form (rejected: a useless store round-trip for a 4 KB icon; kept as the
canonical durable form). *(vi)* A separate `GenerativeMediaProvider` seam (rejected: duplicates the
provider registry). *(vii)* A new `media` StopReason (rejected: closed enum, breaking to extend,
doesn't help consumers who inspect `content` anyway). *(viii)* Folding PDF into the `image` capability
(rejected: distinct modality/cost; a `document` flag advertises it honestly).

### Reserved shape (landed now, behavior later)

Per the maintainer decision to land the **full** seam shape at the freeze (so no future
discriminated-union or optional-method addition is breaking), these elements ship as **shape with no
behavior** and are explicitly tracked so later workstreams know what is reserved vs wired:

- **`media_delta.partialRef`** (progressive-preview handle) ships in the frozen triad but is
  **reserved, host-implementation-defined**. The `MediaStore` contract defines only
  `put(completeBytes) → handle`; partial-write semantics (append / per-delta put) are **not** specified
  here and are owned by the surface that first renders progressive previews (Phase E). Keeping the field
  in the frozen shape avoids a later breaking `StreamChunk` change.
- **`generateMedia?` / `pollMediaJob?`** ship as reserved optional methods (decision #6); the async
  poll/checkpoint loop and its dedicated ADR land in Phase D (1.AG).
- **The `url` carrier** ships **feature-flag-OFF** behind a hard CI/landing gate until the shared SSRF
  range-primitive lands (Guardrails).

### Freeze-criticality (what was truly breaking-to-defer vs landed-early-by-choice)

The maintainer chose to land the **whole** Phase-A shape now rather than only the minimum. For future
maintainers, the distinction is recorded so nobody has to re-derive it:

- **Genuinely freeze-critical** (breaking to add after a consumer's exhaustive `switch` exists): the
  `media` **`ContentPart` arm**, the `media_start/delta/end` **`StreamChunk` triad**, and
  **`CapabilityFlags.media`** (the last because the adapter `supports` shape is breaking for every
  adapter). These *had* to land now.
- **Landed-early-by-choice** (additive — safe to add later, but landed now for cohesion):
  `LlmRequest.outputModalities`, `Usage.mediaUnits`, `tool_result.media`, and the optional
  `generateMedia?`/`pollMediaJob?` methods. Adding an optional field/method later is not breaking; they
  ship now so the seam is internally consistent and the design is captured in one amendment. (Caveat:
  `Usage.mediaUnits` is additive as a *field*, but it embeds an inner **closed `modality` enum** that —
  like a discriminated-union arm — is itself breaking-to-extend, so it ships complete now: deliberately
  the media-billed set `image`/`audio`/`video` only. `document` (PDF) and `text` bill as *tokens*, not
  media units, so they are intentionally excluded from `mediaUnits.modality`, not forgotten.)

## Guardrails (binding)

- **No media bytes cross a durable / run-event / log / DB / exported-YAML / IPC boundary (I3) — by an
  ACTIVE emit-time pass + the type split, NOT a passive refine.** The durable form is always a handle
  (`DurableMediaPart` makes base64 structurally impossible). The enforcement is **structural, not
  call-site discipline**: every event/output leaves the engine through **one serialize/emit choke point**
  (a single `emitRunEvent` / persistence wrapper) that runs **`deInlineMedia`** before any
  serialize/emit/IPC/log/DB write — so a future emitter cannot "forget" to de-inline. The choke point
  covers `LlmResult.content`, every node output and event payload, **the checkpoint/`RunState`
  snapshot**, the `tool_result` descriptor, **and the `FallbackChain` cross-provider context transfer**
  (agent state carried to the next provider). A backstop `superRefine` on typed media positions is a
  test-time tripwire, not the primary guarantee (the leak-bearing event fields are `z.unknown()` a
  refine cannot reach).

- **No vendor type crosses the seam (I1).** Each provider's native media shape is normalized inside the
  adapter. A provider-hosted ref lives **only** in a process-scoped adapter sidecar keyed by
  `(provider, sha256)` — **never** a `ContentPart` field, **never** persisted/logged/checkpointed;
  **stripped and re-materialized from the canonical handle on `FallbackChain` failover / resume**. On
  failover the re-upload (from `MediaStore` bytes) **completes before the retried request is sent** — the
  request waits on re-materialization rather than racing a half-uploaded ref. Async `jobId` is
  Relavium-opaque (no verbatim vendor operation-name).

- **The seam stays platform-free (I2, I4).** Every carrier is a `string`; `MediaStore` is a host-injected
  contract named only by the handle string at the seam.

- **Inline ceiling + per-message caps are type-level.** `INLINE_MEDIA_CEILING` (decoded-byte bound,
  accounting for base64's 1.33×) is asserted on the base64 carrier; **video and document (PDF) are never
  inline — always a handle or a provider URL** (`INLINE_MEDIA_CEILING.video = document = 0`; deliberately
  below even Gemini's ≤~100 MB inline ceiling: a multi-MB base64 video — or a large PDF — on the
  IPC/event path is the worst leak/amplification surface, so the safest rule is a flat "video/PDF →
  handle"). A per-message **count cap** and **aggregate-bytes cap** ship alongside the
  ceiling in Phase A (anti-amplification); a **CI guard asserts the aggregate cap is enforced** so there
  is no cap-less window between the shape landing (Phase A/1.AD) and capability-gating (Phase C/1.AF).

- **SSRF (security-review.md).** A media `url` — **input OR provider-returned output** — is fetched by
  the **host/engine, never the seam or an adapter**, ONLY through the **one shared, completed** SSRF
  range-primitive (HTTPS-only, no creds-in-URL, block private/loopback/link-local + `169.254.169.254` +
  CGNAT, DNS-resolution + **per-hop redirect re-validation**, IPv4-mapped-IPv6 decode). A
  provider-returned output URL (a DALL·E/CDN link) is returned by the adapter as a canonical `url`
  source and **the engine fetches and re-hosts it to a handle inside the `deInlineMedia` pass** — the
  adapter never fetches a media URL, so **media-URL SSRF lives in exactly one place** (the engine
  `deInlineMedia` fetch), sharing the one range-primitive with the provider-baseURL and tool/MCP egress
  paths (security-review.md, ADR-0029). The `url` carrier ships
  **feature-flag-OFF** (a hard CI/landing gate) until the primitive lands; input URLs are re-hosted to a
  handle at ingest.

- **Desktop Rust-IPC ([ADR-0032](0032-desktop-rust-media-de-inline-amends-0018.md)).** Because Rust
  streams **raw** provider chunks, inline-media base64 crosses IPC before normalization.
  [ADR-0032](0032-desktop-rust-media-de-inline-amends-0018.md) amends ADR-0018 so the privileged Rust
  egress command de-inlines inline-media bytes to the Rust-side CAS and forwards only a handle on the
  `Channel<StreamChunk>` — a bounded, audited media-detect-and-store step. **That amendment must land
  before any desktop media-output behavior (Phase E / 1.AH), not after.** The `read_media(ref)` display
  command is **session-scoped** (see authz below).

- **`read_media(ref)` authz — a generic scope-set, not owner-equality.** The new bounded Tauri/IPC
  `read_media` command returns bytes to the untrusted WebView for display, so it validates that **the
  requesting session is in the handle's allowed-scope set** and bounds the returned size. The model is a
  generic `handle → allowedScopes: Set<Scope>` where today `Scope = { kind: 'session', id }`; a session
  may read a handle **it produced or explicitly received as input** (the input-transfer path adds the
  receiver's session scope). A `{ kind: 'workspace', id }` scope kind is **reserved (documented, not
  implemented)** so that later cross-session/shared-asset reads are a purely additive scope kind — no
  handle-model migration. (Owner-id equality is explicitly rejected: it cannot even express "received as
  input.")

- **Managed mode (reconciles [ADR-0015](0015-managed-mode-data-handling-and-compliance.md)).** Generated
  media materializes to the **user's local** `MediaStore`; the gateway streams provider bytes through
  (incl. async LRO poll-through), **stores nothing**, and meters `mediaUnits` **counts only** — never
  the artifact body. No provider key crosses the seam.

- **Resource governance + retention ([ADR-0028](0028-workflow-resource-governance.md)).** A
  per-run/per-session media size+count budget feeds the budget-warning / budget-paused run events. ADR-0028's
  pre-egress governor is **token-based** (`worstCaseNextEstimate(maxTokens)`), which **cannot** estimate
  a media-generation call's cost — so this ADR adds a **per-modality flat media cost estimate** (a
  `count`/`second` estimate, fed from a `media_cost_estimate` config default **and** a per-model rate in
  the pricing/`model_catalog` table) the governor uses pre-egress for `generateMedia` and
  media-output turns. Generated media has its own retention (per-distinct-reference refcount +
  `last_referenced_at`, separate from the 90-day `run_events` prune).

- **Exported YAML carries a handle or a relative `save_to` path, NEVER bytes** (I3 + ADR-0009). At the
  seam the durable form is a **handle** (bytes live in the run's `MediaStore`, not the repo); `save_to`
  is a surface-level render concern, not a seam type.

- **Usage stays disjoint.** `mediaUnits` is an extra observability/billing axis, not a token count.

## Maintainer decisions (2026-06-08)

These nine decisions, taken on the two review reports of the design analysis, are baked into the
Decision / Guardrails above and recorded here so the rationale is not lost:

| Key | Decision | Where |
|-----|----------|-------|
| **A1** | Land the **full** Phase-A shape now (do not narrow to the minimum freeze-critical core). | "Freeze-criticality" above; roadmap 1.AD |
| **A2** | A distinct **`document` input capability flag** for PDF (not folded into `image`). | Decision #3 |
| **A3** | `partialRef` stays in the frozen triad but is **reserved, host-implementation-defined**. | "Reserved shape" above |
| **A4** | Desktop Rust-side media de-inline (option a) — its own ADR ([ADR-0032](0032-desktop-rust-media-de-inline-amends-0018.md)), written now, must land before Phase E. | Desktop guardrail |
| **A5** | `generateMedia`/`pollMediaJob` ship as **reserved shape now**; the async poll/checkpoint behavior gets **its own ADR** at Phase D. | Decision #6, "Reserved shape" |
| **A6** | Pre-egress media cost estimate = **per-modality flat estimate (config default) + per-model pricing rate**. | Resource-governance guardrail |
| **A7** | Provider-returned output URLs are fetched/re-hosted by the **engine** (in `deInlineMedia`), never the adapter. | SSRF guardrail |
| **A8** | `read_media` authz = **generic scope-set** (`session` scope now, `workspace` scope reserved). Widening to shared-asset reads is additive, not a redesign. | `read_media` guardrail |
| **A9** | Exported YAML = **handle at the seam, `save_to` at the surface**. | Exported-YAML guardrail |

### Open implementation details (tracked, do not block this ADR)

These do not change the accepted seam shape; defaults are recorded and the residue is tracked in
[deferred-tasks.md](../roadmap/deferred-tasks.md):

- **Handle URI scheme** — default `media://sha256-<64hex>`; `MediaStore` is a **new host-injected
  contract** (like the ADR-0018 HTTP transport); the `media_objects` table lands in Phase C (1.AF).
- **Retention/GC** — default: per-distinct-reference refcount + `last_referenced_at` + a grace window;
  GC owner is the host (Rust on desktop, filesystem on CLI); diverges from the 90-day `run_events` prune.
- **Inline ceiling values** — default 256 KB decoded for image/audio, document (PDF) and video always a
  handle (same rationale: large files, high leak/amplification surface), per-modality constant.
- **`vision` alias lifecycle** — keep the derived alias now; schedule removal once `db.supports_vision`
  and adapter consumers migrate to `media.input.image`.
- **Provider URL as a durable form** — default: **handle-only durable is absolute** (input URLs re-hosted
  at ingest, output URLs materialized to handles); no provider URL persists.

## Consequences

### Positive

- The seam is extended at its cheapest moment — three adapters, zero downstream consumers — avoiding a
  future breaking discriminated-union change + superseding ADR + consumer rework.
- The product promise becomes real: any model's image/audio/video, in and out, reaches the
  UI/session/workflow as a canonical, vendor-neutral, leak-free channel; a generate-media-by-rule
  workflow is expressible (`output_modalities` + `save_to`).
- The OpenAI flatten bug and the SSRF obligation are fixed as named preconditions, not deferred.
- No-bytes-in-events/IPC holds by the **active `deInlineMedia` pass at one structural choke point + the
  durable type split** — a proven mechanism (compiler + emit-time transform + backstop refine), not
  review discipline.

### Negative

- The largest seam-surface addition to date: a forked media `ContentPart` arm + a `media_*`
  `StreamChunk` triad + the capability matrix with `outputCombinations` + two optional provider methods
  + a typed `tool_result.media` + the tier/ceiling policy — enlarging every future consumer's
  exhaustive `switch` (mitigated: one MIME-discriminated arm, exhaustiveness caught at compile time).
- It **requires [ADR-0032](0032-desktop-rust-media-de-inline-amends-0018.md)** (Rust-side media
  de-inlining) and a future **async-media-job ADR** (the poll/checkpoint loop), plus an
  `LlmProvider`-interface growth (optional methods) landed now as reserved shape ahead of behavior.
- New standing obligations every later consumer upholds: the active `deInlineMedia` pass at the one emit
  choke point (incl. the checkpoint snapshot and the failover context transfer), the ephemeral-sidecar
  discipline (owned by the 1.K `FallbackChain` strip/re-materialize-on-failover), the per-modality media
  cost estimate in the governor, a new `MediaStore` retention/GC story, and the feature-flagged `url`
  carrier gated on the shared SSRF primitive.
