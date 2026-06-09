# ADR-0032: desktop Rust-side media de-inlining on the egress path (amends ADR-0018)

- **Status**: Accepted
- **Date**: 2026-06-08
- **Related**: [0018-desktop-execution-and-rust-egress.md](0018-desktop-execution-and-rust-egress.md) (**this ADR amends it** — append-only, ADR-0018 is unchanged in history), [0031-llm-seam-shape-amendment-multimodal-io.md](0031-llm-seam-shape-amendment-multimodal-io.md) (the multimodal seam amendment that requires this), [0006-os-keychain-for-api-keys.md](0006-os-keychain-for-api-keys.md), [0011-internal-llm-abstraction.md](0011-internal-llm-abstraction.md), [0015-managed-mode-data-handling-and-compliance.md](0015-managed-mode-data-handling-and-compliance.md), [../reference/contracts/ipc-contract.md](../reference/contracts/ipc-contract.md), [../analysis/multimodal-io-design-2026-06-07.md](../analysis/multimodal-io-design-2026-06-07.md) (§3.3 / §6.5, the contradiction this resolves).

## Context

[ADR-0018](0018-desktop-execution-and-rust-egress.md) fixed the desktop execution model: the engine +
adapters run in the **WebView**, but the authenticated LLM HTTPS egress is delegated to a privileged
**Rust `llm_stream` command**. Rust reads the key from the OS keychain, performs the streaming request,
and streams the provider's **raw** response chunks back over a `Channel<StreamChunk>`; the WebView
adapter **normalizes** those raw chunks into canonical `StreamChunk`s. Normalization happens
**WebView-side**, *after* the bytes have already crossed the Rust→WebView IPC boundary.

[ADR-0031](0031-llm-seam-shape-amendment-multimodal-io.md) makes media a first-class seam value and
binds invariant **I3**: *no media bytes cross a durable / run-event / log / DB / exported-YAML / IPC
boundary* — the durable form is always a handle. ADR-0031's handle-only `media_end` chunk and the
`deInlineMedia` pass enforce I3 on the **normalized** layer.

**The contradiction:** an inline media-output turn (Gemini `responseModalities`, OpenAI inline audio,
agentic image-gen) returns its image/audio bytes **inside the raw provider response body**. On desktop
that raw body is exactly what Rust streams over the `Channel` *before* WebView normalization exists. So
multi-MB base64 media **does** transit the WebView↔Rust IPC channel — the handle-only `media_end` shape
protects a boundary the raw bytes never hit. The honest framing (ADR-0031, design §3.3/§6.5): on
desktop, "no bytes cross IPC" is **false by construction** unless ADR-0018 itself changes. ADR-0018's
egress command must be amended; this cannot be papered over at the normalized layer.

## Decision

**On the desktop, the privileged Rust egress command de-inlines inline media bytes on the egress path:
for a media-bearing response it detects the inline media in the raw provider stream, writes the bytes to
the Rust-side content-addressed `MediaStore` (CAS), and forwards only a Relavium **handle** on the
`Channel<StreamChunk>` — never the multi-MB base64 body.** (Design option (a); maintainer decision A4.)

Considered: **(b)** accept that raw provider bytes transit the *trusted* Channel once (they are a
provider response like raw chat text) and scope the no-bytes rule to the *normalized* `StreamChunk` /
run-event / persisted layers only — **rejected**: it leaves large media bytes on the hot IPC path,
weakens I3 to "normalized-layer only," and scales badly with video/large images. **(a, chosen)** moves
the de-inline into the one privileged, audited component that already parses the stream to frame chunks.

Concretely, refining ADR-0018's `llm_stream` model (canonical wiring in
[ipc-contract.md](../reference/contracts/ipc-contract.md)):

- **Rust gains a bounded, audited media-detect-and-store step** on the egress path. It already parses the
  provider SSE/byte stream to frame chunks; for a response carrying inline media it additionally: (1)
  recognizes the inline media payload, (2) `put`s the decoded bytes into the **Rust-side CAS** (the
  desktop `MediaStore` impl, ADR-0031 §4.1), and (3) emits a normalized-shape `media_end`-equivalent
  frame carrying the **handle**, not the bytes, on the `Channel`. The WebView adapter folds that into the
  canonical `media_*` `StreamChunk`s exactly as on Node surfaces.
- **This is a narrow, explicit reversal** of ADR-0018's implicit "Rust never parses or rewrites the
  semantic content of a chunk — it only frames raw bytes" stance, **for the media-output case only**.
  State it plainly: on desktop, Rust now understands *one* thing about chunk content — that a media
  payload must be stored and replaced by a handle before it reaches the WebView. Text, tool-call, and
  reasoning chunks are still framed verbatim. The raw key still lives only in Rust (ADR-0006 unchanged);
  the WebView still never sees a secret.
- **A session-scoped `read_media(ref)` Tauri command** serves display bytes back to the untrusted
  WebView, **off** the hot `Channel<StreamChunk>`. It enforces the ADR-0031 authz scope-set (the
  requesting session must be in the handle's allowed-scope set) and bounds the returned size — so it is
  not an arbitrary "know-a-sha256 → read-any-file" primitive.
- **Managed mode is unaffected at rest** ([ADR-0015](0015-managed-mode-data-handling-and-compliance.md)):
  the gateway still streams provider bytes through and stores nothing; on desktop the local engine's Rust
  CAS is where the user's generated bytes land, exactly as ADR-0031 specifies.

This **refines the mechanism** of ADR-0018 (the egress command gains a media step) without changing its
decision (engine in the WebView, Rust-delegated egress, key never in the WebView) or the
`LLMProvider` seam types (unchanged — the seam already speaks handles).

## Consequences

### Positive

- Invariant I3 becomes **literally true on desktop**: multi-MB media bytes never transit the
  WebView↔Rust JSON channel — only ~70-byte handles do. The leak-freedom guarantee holds on every
  surface, not just the normalized layer.
- The de-inline lives in the **one privileged, auditable** component (the Rust egress command) rather
  than being spread across WebView-side normalization that runs in the least-trusted process.
- No seam-type change and no engine change: `@relavium/core` and the WebView adapter stay
  platform-agnostic; only the desktop transport wiring gains the media step (the Node surfaces already
  de-inline in-process).

### Negative

- The Rust egress command grows from a pure byte-framer to a byte-framer **plus** a media-detect-and-store
  step — more privileged Rust code to maintain and audit (mitigated: bounded, single-purpose, exercised
  by a desktop integration test).
- Desktop now has a Rust-side CAS + a `read_media` command the Node surfaces do not need — additional
  per-host wiring (consistent with ADR-0018 already wiring a desktop-only transport).
- This amendment **must land before any desktop media-output behavior** (Phase E / roadmap 1.AH); shipping
  inline media-out on desktop without it would violate I3.

### Neutral

- Per ADR-0009's append-only rule, ADR-0018 is unchanged in history; this ADR is the authoritative record
  for the desktop media-egress mechanism. Future desktop egress readers should read ADR-0018 **and** this.
