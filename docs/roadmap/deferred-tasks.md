# Deferred tasks — confirmed review findings not yet actioned

> Status: Living

> Last updated: 2026-06-14

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
- [ ] **Shared SSRF range-primitive (the `url`-carrier precondition)** — the one shared HTTPS-only /
  block-private-loopback-link-local-metadata-CGNAT / DNS-resolution + per-hop-redirect-revalidation /
  IPv4-mapped-IPv6-decode primitive that `assertHttpsBaseUrl` (openai.ts) is the best-effort placeholder
  for. security-review.md mandates **one** primitive across all egress paths; the media `url` carrier
  (input + provider-returned output) is gated **feature-flag-OFF** until it lands. **Land at 1.AE**, with
  the landing-gate CI test (url rejected while flag off). **A runtime-*derived* base URL** (auto-selected /
  resolved, not literally user-supplied) is re-checked through this same primitive against its
  **post-resolution IP**; an explicit-local-endpoint opt-out **narrows, never removes**, the
  metadata-IP/link-local block. **The primitive must also pin the connection to the IP it validated**
  (connect-by-validated-IP / a lookup-pinned agent): validating one resolution and letting the HTTP
  client re-resolve is a TOCTOU window DNS-rebinding walks through — the check and the connect must
  see the same address (a binding control in [security-review.md](../standards/security-review.md)).
  *(security-review.md; openai.ts; 1.AE)*
- [ ] **Async media-job ADR (`generateMedia`/`pollMediaJob` behavior, A5)** — the seam shape is reserved
  now (1.AD); the engine-owned **poll / checkpoint / resume / cancel loop** for minute-scale LROs
  (Sora/Veo) — in the run loop (1.N) + checkpointer (1.R), reusing `LlmError` classification — gets **its
  own ADR written at 1.AG (Phase D)**. Highest behavioral complexity in the multimodal design. *(1.AG)*
- [ ] **Per-modality pre-egress media cost estimate (A6)** — ADR-0028's governor is token-based and
  cannot price a media-gen call. Add a `[defaults].media_cost_estimate` config default (the media
  analogue of `max_tokens_estimate`, in [config-spec.md](../reference/contracts/config-spec.md)) **and** a
  per-model media rate in `pricing.ts`/`model_catalog`; the governor estimates `units × rate` pre-egress.
  *(config.ts; pricing.ts; database-schema.md; wired at 1.AF/1.AG)*
- [ ] **`partialRef` partial-write semantics (A3, reserved)** — `media_delta.partialRef` ships in the
  frozen triad (1.AD) but is **reserved, host-implementation-defined**; the `MediaStore` contract defines
  only `put(completeBytes)`. Specify append-vs-per-delta-put semantics when the surface that renders
  progressive previews lands. *(1.AH / Phase E)*
- [ ] **`read_media` `workspace` authz scope kind (A8, reserved)** — `read_media` authz is a generic
  `handle → allowedScopes: Set<Scope>` with `Scope = { kind:'session', id }` today; the
  `{ kind:'workspace', id }` kind is **reserved (documented, not implemented)** so cross-session /
  shared-asset reads are an additive scope kind, no handle-model migration. Implement only when a
  shared-asset feature has a real consumer. *(1.AF; ADR-0031 read_media guardrail)*
- [ ] **`MediaStore` retention/GC + `media_objects` table (defaulted)** — per-distinct-reference
  `refcount` + `last_referenced_at` + grace window, separate from the 90-day `run_events` prune; GC owner
  is the host (Rust desktop / filesystem CLI). Lands with the table at **1.AF**. *(database-schema.md; 1.AF)*
- [ ] **Retire the `vision` derived alias (OQ6 default)** — `CapabilityFlags.vision` is kept as a derived
  alias of `media.input.image` for live consumers (`db.supports_vision`, adapter `supports.vision`);
  schedule removal once those migrate to `media.input.image`. *(types.ts; a later cleanup)*

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
- [ ] **Pre-egress token-estimate accuracy — watch item (1.AC).** The ADR-0028 governor blocks on
  `worstCaseNextEstimate(maxTokens)` from `[defaults].max_tokens_estimate`. Record the open
  question: does the estimate need provider-accurate token counting (from the seam's model meta /
  usage feedback) to avoid systematic over/under-blocking, or is the declared estimate enough?
  No change now — re-evaluate with real 1.AC telemetry. *(1.AC; ADR-0028)*

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
- [ ] **Frozen `ctx` checkpoint transport must use `structuredClone` (→ 1.R).** `resolveContext` returns
  an `Object.freeze`d **null-prototype** map so a `__proto__`/`constructor` context key is a safe own
  property. That guard is in-memory only: persisting/transporting it via `JSON.stringify` → `JSON.parse`
  (esp. with a reviver, or merged into `{}`) can re-materialize `__proto__` as a real setter. The 1.R
  checkpoint/resume layer MUST transport the frozen scope with `structuredClone`, never a JSON round-trip;
  pin it with a test when the checkpointer lands. *(packages/core/src/interpolation/resolve.ts; 1.R)*

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
- [ ] **DeepSeek surviving-reasoning replay** — the same per-provider contract applies; confirm whether the
  OpenAI-compatible adapter normalizes/replays `reasoning_content` on a same-provider continuation, or currently
  drops it. *(medium · packages/llm/src/adapters/openai.ts; ADR-0030 follow-up)*
- [ ] **`output_schema` deep JSON-Schema conformance** — 1.O validates an `agent` node's `output_schema`
  node-side but **parse-as-JSON only** (the seam's `responseFormat` is a request hint; a
  schema-violating-but-valid JSON output, e.g. `{"wrong":true}` for a `{ n: number }` schema, currently
  passes as `completed`). **1.P shares this gap for the `transform` node's optional `output_schema`** — the
  sandbox guarantees the result is JSON-serializable but does **not** check it against the declared schema.
  Deep conformance needs a JSON-Schema validator (Zod cannot consume an arbitrary JSON-Schema), a new runtime
  dependency requiring an ADR. *(medium · packages/core/src/engine/agent-runner.ts,
  packages/core/src/engine/node-handlers/transform.ts; error-handling.md)*
- [ ] **Per-attempt model attribution for `agent:token`** — `cost:updated` is always per-attempt-accurate, but
  `agent:token.model` uses `activeModel` (updated from the *succeeding* attempt record, which fires after the
  stream), so a *cross-model pre-content failover* attributes that turn's tokens to the prior model. A precise
  fix needs a `FallbackChain` `onAttemptStart`/attributed-stream hook (a seam change). *(low · packages/core/src/engine/agent-turn.ts; packages/llm/src/fallback-chain.ts)*
- [ ] **Per-attempt pre-egress budget gate (1.AC)** — 1.O leaves a coarse always-pass hook at the tool-loop
  turn boundary; the precise per-egress budget check (a `FallbackChain` makes several attempts per turn) is a
  chain pre-attempt hook 1.AC adds. *(medium · ADR-0028; ADR-0038; 1.AC)*
- [ ] **Multi-tool result ordering in the turn core** — `dispatchToolCalls` appends tool-result messages in
  dispatch-completion order; for v1.0 (single tool call per `tool_use` stop) this is moot, but a parallel-tool
  provider should order by the accumulator's `toolOrder` before 1.V reuses the core. *(low · packages/core/src/engine/agent-turn.ts; 1.V)*
- [ ] **Secret-into-`run.outputs` runtime taint (ADR-0029(c) follow-up)** — an `agent` node cannot launder a
  secret into `run.outputs` (it emits LLM text only), so this is **not** 1.O's to own; it belongs to the
  `transform` / sandbox node (1.P / 1.AB) that can return a secret-derived value. 1.O's only obligation is to
  refuse a tainted `{{ run.outputs[…] }}` reference *if* such a marker reaches it; the static parse-time
  `analyzeSecretTaint` gate covers the authored template graph. Record as a scoped ADR-0029 amendment when 1.P/1.AB
  lands. *(medium · packages/core/src/interpolation/analyze.ts; ADR-0029(c), 1.P/1.AB)*

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
- [ ] **Combined tool-loop DoS bound (turns × corrections)** — `maxToolTurns` (16) and `maxToolCorrections`
  (3) are independent budgets; their *product* bounds worst-case egress and the interleaving (a turn mixing
  correctable + genuine tool rounds) is untested. Document the combined bound and add an interleaving test.
  *(low · packages/core/src/engine/agent-turn.ts)*
- [ ] **Multimodal tool-result through the adjacent-message + redaction paths** — all 1.O coverage exercises
  text/JSON tool args + content; confirm image/media tool-result blocks survive the Anthropic adjacent-role
  merge (no dropped blocks / no double-merge with `stripReasoningParts`) and the redaction path. *(low · packages/llm/src/adapters/anthropic.ts; 1.AF)*
- [ ] **Checkpoint/resume of a mid-tool-loop turn** — whether a run paused/resumed between tool dispatches
  reconstructs the message history (assistant turn + partial tool results) consistently. *(medium · 1.R)*

## Node-type handlers (1.P) follow-ups

> **2026-06-14 1.P implementation.** The six non-agent handlers (condition / transform / fan_out / fan_in /
> input / output) landed as executor-only work behind the 1.N seam (no engine.ts change). Two forward
> items were deliberately scoped out (maintainer-approved); recorded so they aren't lost.

- [ ] **True `wait_first` early-cancellation of losing branches** — `merge_strategy: first` is implemented
  executor-only: the engine still waits for all branches to settle, then the `fan_in` handler takes the first
  by `branchNodeIds` order. Genuine early-cancel (abort the still-running sibling branches the moment the
  first settles) needs an **engine-owned per-branch cancellation primitive** — the current single run-wide
  `AbortSignal` cannot cancel one branch without cancelling the run, and a handler cannot cancel sibling
  vertices. The engine authors already flagged this as a "1.P refinement" (engine.ts:26-28). Promote to a
  scoped 1.N/engine change (possibly an ADR) only when a real workflow needs it. *(low · packages/core/src/engine/engine.ts, packages/core/src/engine/node-handlers/fan-in.ts; run-plan.md §fan-in)*
- [ ] **Workflow-context (`ctx.*`) threading into expression/agent scope** — the `condition`/`transform`/
  `merge_fn` sandbox scope (and the AgentRunner's prompt `RunScope`) currently bind `ctx: {}` — the authored
  `context:` namespace is not yet resolved and threaded to handlers (a `{{ctx.key}}` template still resolves,
  but a bare `ctx.key` JS-expression read sees `{}`). A cross-cutting change for **both** 1.O and 1.P when the
  engine resolves the workflow `context:` map. *(medium · packages/core/src/engine/node-handlers/scope.ts, packages/core/src/engine/agent-runner.ts)*

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
- [ ] **Coverage floor fires only on a repo-root run + is not a CI gate** — two residues of the
  item above (PR #10 review, verified empirically): (1) the per-glob threshold key
  (`packages/llm/src/**/*.ts`) is root-relative while a package-scoped `--coverage` run keys the
  coverage map cwd-relative (`src/…`), so the floor silently does not fire there — and no single
  glob can fix it without wrongly binding shared/db package runs to the engine floor (documented
  at the thresholds block). (2) `pnpm coverage` is not yet a required CI step. Resolve both at
  once when wiring coverage into CI: a root-run `pnpm coverage` CI step makes the root-relative
  glob authoritative and the package-scoped gap moot. *(minor · vitest.config.ts, ci.yml)*
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
- [ ] **Conformance: tool-loop + cache-hit recorded scenarios (1.F follow-up)** — the shared
  conformance suite covers text / single tool-call / usage / stop / error, but not a **multi-turn
  tool loop** (call → result → continuation on the same provider, the path every agent node
  exercises) or a **prompt-cache-hit** response (cached-token usage fields folding into the one
  canonical `Usage`). Add both as recorded scenarios, and grow a small provider-quirk fixture bank
  (reasoning-field variants, tool-call adjacency rules) as quirks are met in the adapters — the
  suite is where quirk knowledge belongs, not adapter comments. *(packages/llm conformance; next
  adapters-touching PR wave)*

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
  extracted `readQuotedKey` + `readNumericIndex`; `readBracket` is now a 3-line dispatcher.
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
