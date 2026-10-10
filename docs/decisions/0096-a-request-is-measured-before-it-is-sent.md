# ADR-0096: A request is measured before it is sent, and a context overflow is a classified failure

- **Status**: Accepted — 2026-09-14
- **Date**: 2026-09-12 (first draft) · 2026-09-14 (fifth draft). Five review rounds shaped it: the maintainer's review of the first draft and four adversarial workflow rounds. After the fifth, the maintainer had it restated as decisions, invariants and acceptance tests, and a short sixth round verified that form.
- **Implementation**: staged for `W7`. "Accepted" here means the decision is settled, not that it ships: until the `W7`
  commits land, nothing measures a request before it is sent, an overflow is still a fatal `bad_request`, and the
  pre-egress estimate still prices output only.
- **Decides**: the three defects recorded in [deferred-tasks.md](../roadmap/deferred-tasks.md) under "Cross-turn
  tool-call memory as a default-off toggle", re-verified against the tree (`W7` of
  [Phase 2.6.5](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md)). They matter on their own, and
  they gate the carrying work that [ADR-0095](0095-what-an-agent-session-remembers-across-turns.md) §2 defers.
- **Amends (a refinement, not a reversal)**:
  - [ADR-0062](0062-context-compaction-and-cli-history-commands.md) §1 (the summariser's input is bounded), §4
    (the token estimate becomes a live input) and §5 (what the after-turn trigger measures, which window it uses, and
    — for pre-send compaction only — that a failed summariser sends the request rather than trimming, §3)
  - [ADR-0028](0028-workflow-resource-governance.md) (the pre-egress estimate prices input)
  - [ADR-0074](0074-durable-conservative-budget-commitments.md) §1 (a classified pre-content overflow is released,
    not committed)
- **Contract changes**:
  - `LlmErrorKind` and `ErrorCode` both gain `context_overflow`
  - the exported `PreEgressHook` gains `inputTokensEstimate`
  - a failed attempt record carries its classification and a chain-set `contentReceived: boolean`
  - see [llm-provider-seam.md](../reference/shared-core/llm-provider-seam.md)
- **Related**: [ADR-0082](0082-the-stream-grammar-is-a-seam-obligation-and-every-attempt-has-a-deadline.md) §9
  (applied; its test is met) · [ADR-0080](0080-durable-effect-journal-and-the-tiered-effect-contract.md) §10
  (`CR-95`) · [ADR-0097](0097-a-budget-approval-is-an-allowance-not-an-exemption.md) (sizes an allowance from this
  ADR's estimate)

> **Amended 2026-09-18 — the `W7` pre-implementation review.** A systematic review against the tree found two
> invariants that cannot both hold as written, several quantities the implementation would have had to invent, and
> canonical documents this ADR falsifies without listing. The decision is unchanged. Choices the maintainer made on
> 2026-09-18 are marked.
>
> **§1 — what the estimate counts.**
>
> - **The per-part floor does not apply to a media part.** Every NON-media part adds at least its serialised length
>   divided by the character ratio; a media part adds its per-modality ceiling whatever its source encoding carries,
>   and a `tool_result`'s `media` array is charged per element by modality. Read literally, the floor charged a 5 MB
>   inline image about 1.7 M tokens, which would end an attachment-bearing attempt `budget_exceeded`.
> - **The per-modality ceilings are fixed numbers, recorded with their sources.** (Maintainer, 2026-09-18.) The
>   image ceiling is the largest documented per-image input charge among the supported providers. PDF, audio and
>   video have no documented per-part maximum, so each is charged a fixed per-part assumption; that keeps §1's
>   recorded under-count rather than pretending to a bound. The numbers and their citations live in
>   [llm-provider-seam.md](../reference/shared-core/llm-provider-seam.md) beside the estimator.
> - **The input term is priced at the highest context tier and the non-cached input rate** (`worstCaseRates`),
>   which is [ADR-0071](0071-models-dev-as-the-model-metadata-source.md) §11's directional rule: on a safety
>   control, guessing the cheap side is the guess that lets money escape. `budget-estimator.ts`'s "prices only the
>   output side" comment is corrected with the code, and so are the three per-adapter `CONTEXT_SEAM_DEFAULTS`
>   comments that repeat the fallback-only framing (`openai.ts:1557`, `gemini.ts:1312`, `anthropic.ts:954`) — §1
>   names only `types.ts` and `adapters/shared.ts`.
>
> **§2 — what is measured.**
>
> - **The output reservation, when the adapter sends no cap, is a shared default of 4096 clamped to the model's
>   catalog output ceiling.** (Maintainer, 2026-09-18.) Only the Anthropic adapter has a default today; OpenAI,
>   DeepSeek, Gemini and custom endpoints send no cap at all when `max_tokens` is not authored, so "the default"
>   named nothing for them. 4096 is the figure the governor already assumes (`DEFAULT_MAX_TOKENS_ESTIMATE`) and the
>   one Anthropic sends. One seam-level helper in `@relavium/llm` returns it, so the session, the governor and the
>   adapters cannot disagree.
> - **A custom endpoint's window is unknown.** A provider with `customEndpoint === true` reports the catalog window
>   of whatever model id it reuses, which is not authoritative (`CR-51`), so pre-send, recovery and after-turn
>   automatic compaction are all skipped for it — the answer ADR-0062 §5 already gave for a custom id, now true in
>   the code as well. The CLI footer's window lookup has the same gap and is fixed with it.
> - **The cooldown pre-skip cannot apply at the pre-send point.** A chain, and its cooldown map, is built inside
>   every `runAgentTurn`, so at pre-send time no cooldown exists and the rule reduces to the capability pre-skip.
>   Nothing is to be hoisted to make it otherwise.
> - **W7 does not calibrate.** (Maintainer, 2026-09-18.) The heuristic ships alone; invariant 4 binds any
>   calibration that is added later, and the deferral is recorded in
>   [deferred-tasks.md](../roadmap/deferred-tasks.md). The implementation note naming OpenAI and Gemini as net of
>   cache is incomplete: Anthropic's `input_tokens` excludes cache reads and writes too, so "gross input" has to be
>   rebuilt per dialect if calibration is ever built.
> - **The after-turn trigger measures the same construction with no pending user text**, and applies both of §3's
>   conditions — the threshold and input-plus-reservation against the window.
>
> **§3 — pre-send compaction.**
>
> - **The non-foldable floor includes the exchange the compaction primitive keeps verbatim**, which at pre-send
>   time also carries the already-pushed pending user message. The floor is compared with the WINDOW, as written,
>   not with the threshold. The cost is disclosed rather than hidden: when the floor sits between
>   `compact_threshold × window` and the window, a summariser call runs before each turn, and that call is what
>   keeps the turn from overflowing.
> - **A skipped pre-send compaction still sends the request**, and it also suppresses §5's recovery in that turn,
>   exactly as a failed one does. A recovery compaction that returns `nothing_to_compact` ends the turn with one
>   `context_overflow` terminal and no retry.
> - **The summariser's input is bounded by a capped multi-pass fold.** (Maintainer, 2026-09-18.) The foldable
>   history is chunked and folded into a running summary over at most four passes, each of which is budget-gated and
>   billed. Installation is all-or-nothing: no in-memory change and no boundary marker unless every pass succeeded,
>   while the spend of the passes that ran stays accounted. One `session:compacting` / terminal pair per compaction,
>   with `tokensUsed` summed, so the persister still writes one marker. A single foldable message that cannot fit on
>   its own is truncated head-and-tail behind a fixed engine-authored marker naming how much was dropped.
> - **A pre-egress budget refusal of the summariser is a BUDGET outcome, not a failed compaction.** (Maintainer,
>   2026-09-18.) Once input is priced, the summariser is the largest request a session makes, so a session near its
>   cap has it refused. The history is not trimmed, the pre-send request is not sent, and the turn ends
>   `budget_exceeded` naming the cap — during recovery too, where reporting `context_overflow` would name a cause
>   the user cannot act on and a remedy that is also refused. ADR-0097's allowance does not reach it: a session has
>   no pause/resume gate machinery, so a pre-egress `BudgetPauseError` settles the turn rather than pausing for
>   approval (`agent-session.ts`'s `#settleTurnError`, and the "Session budget pause/resume" record in
>   deferred-tasks.md). `session:compacting` is emitted only once the summariser's FIRST pre-egress admission has
>   succeeded, so a refusal there opens no compaction moment. A refusal on a LATER pass of a multi-pass fold arrives
>   with the moment already open, and it emits `session:compaction_failed` carrying `budget_exceeded` before the
>   turn settles — the compaction genuinely did not complete, even though the CAUSE is the cap rather than the
>   summariser. "Not a failed compaction" governs what happens to the history (it is not trimmed) and which code
>   the turn ends with; it does not license a `session:compacting` with no terminal.
> - **`session:compacting` and `session:compacted` gain the additive `reason` values `pre-send` and
>   `overflow-recovery`, and every failed compaction gets a terminal.** (Maintainer, 2026-09-18.) A new additive
>   `session:compaction_failed` event ends the moment for a failed automatic OR manual compaction, so
>   "`session:compacting` with no terminal" stops being a documented exception, the CLI's labelled indicator cannot
>   stay lit through a streamed reply, and the user is told that the request went out uncompacted.
>
> **§4, §5 — classification and recovery.**
>
> - **The overflow fixtures are captured live, once, before the classification commit.** (Maintainer, 2026-09-18.)
>   Every conformance fixture in the tree is hand-authored, so the invariant could not be met by following the
>   repo's own convention. `W7` ships a capture script the maintainer runs with their own keys for each dialect —
>   Anthropic, OpenAI, DeepSeek (its own dialect) and Gemini — and commits each response with its capture date and
>   model id. The Gemini replay harness is changed in the same commit to reject with the recorded message and body
>   rather than a fixed string, or a recorded Gemini overflow can never reach the classifier. The capture also
>   answers whether the GA Anthropic API reports a window-truncated generation as the `model_context_window_exceeded`
>   stop reason, which today's `default` arm would map to a clean `stop`.
> - **What each dialect keys on is documented per dialect** in llm-provider-seam.md: a structured code where one
>   exists, and otherwise a status-gated (400 / invalid-request) message match inside the adapter, each pinned by
>   that dialect's recorded fixture. An unmatched overflow stays `bad_request`. The engine and the surfaces narrow
>   on the kind only.
> - **§4 invariant 2 is enforced where `customEndpoint` is visible** — in the `FallbackChain`, which already reads
>   it for its skip decision. The chain turns a `context_overflow` from a custom-endpoint entry into `bad_request`
>   before it records or throws; the adapter's host-based endpoint check must not be used for this, because a
>   custom provider is built by spreading the adapter and the flag is added afterwards. The release acceptance for
>   condition 3 therefore uses a double that delivers `context_overflow` for a custom-endpoint entry, or deleting
>   the condition leaves the test green.
> - **`inputTokensEstimate` is computed by the turn core from the current round's request.** The chain's
>   `PreAttemptHook` never receives the per-entry request, so the alternative would be a seam contract change this
>   ADR does not list. Measuring the pre-strip round request over-counts a stripped reasoning part, which is the
>   conservative direction. The field is REQUIRED on the hook's info (or the governor takes the info object), so a
>   forwarding site that drops it fails to compile rather than silently zeroing the input term; the generative
>   media gate forwards `0`, as its `maxTokens: 0` already implies. Its canonical home is
>   [agent-runner.md](../reference/shared-core/agent-runner.md), which already documents `preEgress`, and not
>   llm-provider-seam.md, where the "Contract changes" line above points.
> - **A pre-content HTTP 4xx releases its admission, like a classified overflow.** (Maintainer, 2026-09-18.) Once
>   input is priced, every usage-less engaged failure would otherwise commit a window-sized estimate, so a short
>   rate-limit burst could exhaust a session's cap. An upstream 4xx (429, 400, 401, 402, 403, 404, 413, 422) with
>   `contentReceived: false` on a non-custom endpoint is the same positive evidence §5 invariant 5 already accepts:
>   the provider refused before inference. The list is exactly those eight codes; every other status keeps
>   ADR-0074's commitment — 5xx, timeout (where `kindFromHttpStatus` already routes a 408) and transport failures —
>   because billing there is genuinely uncertain. This extends §5 invariant 5 and is recorded on ADR-0074 as well.
> - **Recovery measures against §2 invariant 2 applied to the retry's fresh chain.** A workflow node's
>   `context_overflow` message names the model of the attempt that overflowed, and says the window is unknown in
>   fixed wording rather than naming a number when the catalog has none.
> - **The remedy is engine-authored but surface-neutral, and each surface names its own commands.** (Maintainer,
>   2026-09-18.) `packages/core` is shared by the CLI, the desktop app and the extension, so an engine string
>   naming `/compact` would put one surface's vocabulary into the engine. The engine states the fact — the request
>   exceeds the window, whether tools already ran, and which window — and the CLI builds the sentence from ONE
>   remedy function that knows the effective `memory` policy and whether tools ran. That function serves the
>   classified code and the custom-endpoint keyword heuristic alike, so a refused command is never suggested: never
>   `/compact` or `/trim` under `none`, never `/compact` under `window`. `context_overflow` is displayed on the chat
>   surface and gets no second static hint. The CLI's hint switch is exhaustive only by the `ERROR_CODES` drift
>   test, not by the compiler — it switches on `string` — so the new code needs a deliberate hint decision rather
>   than a compile error to prompt one; the Negative section's "the compiler finds every switch" is true of the
>   engine's unions, not of that site.
> - **A new `ErrorCode` member is not additive for STORED events.** (Maintainer, 2026-09-18.) An older binary
>   treats a persisted `node:failed` or `run:failed` carrying `context_overflow` as corruption and refuses to read
>   it, for display as well as replay. That is accepted, with upgrade as the remedy — the precedent
>   `effect_needs_attention` set without saying so — and sse-event-schema.md's forward-compatibility section will
>   state the rule when `W7` lands, rather than leaving the next reader to find it.
>
> **Corrections to the implementation notes.** The `finally` that restores `#abort`, `#abortingTurn` and `#status`
> is at `agent-session.ts:793-797`; `:798-804` is the after-turn auto-compaction call, which sits OUTSIDE it.
> `compact()` also installs its own controller over `#abort` and its `finally` clears `#abortingTurn` and resets
> `#status`, so pre-send and recovery compaction need an inner primitive that shares the turn's signal and leaves
> turn state alone — otherwise an `Esc` during pre-send compaction would settle the compaction and let the turn
> send anyway.
>
> **Landing obligations gained.** [config-spec.md](../reference/contracts/config-spec.md) (`auto_compact` /
> `compact_threshold` now measure the projected next request against the first attemptable entry's window, the
> three entry points, and pre-send failure sending rather than trimming) ·
> [workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md)'s cost-cap formula, which prices output
> only · [agent-runner.md](../reference/shared-core/agent-runner.md) (the `context_overflow` row in its error map,
> and `PreEgressHook.inputTokensEstimate`) · llm-provider-seam.md:178's "pre-first-turn FALLBACK only" framing, the
> per-modality ceilings, and the per-dialect classification · error-handling.md's claim that the chain "records the
> failed attempt's usage", which it does not (the same claim sits in `llm-error.ts`) ·
> [chat-session.md](../reference/cli/chat-session.md)'s context-fullness paragraph, which stays a billed-usage
> approximation and is not the trigger.
>
> **Register.** These three prerequisites are register item `CR-98`, opened 2026-09-18 (deferrable, scheduled
> `W7`); this ADR's invariants and acceptance tests — as amended by this note — are that item's acceptance.
>
> **Acceptance gained.**
>
> - An inline base64 image part adds the image ceiling, not its base64 length divided by the ratio.
> - An UNAUTHORED `max_tokens` reserves the shared 4096 default clamped to the catalog ceiling, on each dialect —
>   distinct from the body's "The right output cap", which pins the authored-above-ceiling case.
> - A custom endpoint that reuses a catalog model id skips pre-send, recovery and after-turn compaction, and the
>   CLI footer does not claim its window.
> - A kept exchange larger than the window skips pre-send compaction and makes no summariser call.
> - A skipped pre-send compaction still sends; a skip suppresses recovery in that turn; and a recovery compaction
>   that returns `nothing_to_compact` ends the turn with one `context_overflow` terminal and no retry.
> - A custom-endpoint overflow under `memory: none` never names `/compact` or `/trim`.
> - A session near its cap whose summariser is refused on budget keeps its history and ends `budget_exceeded`, on
>   the pre-send path and on the recovery path alike. When the refusal lands on pass 2 of a multi-pass fold, the
>   open `session:compacting` is closed by one `session:compaction_failed` carrying `budget_exceeded`, and nothing
>   is installed.
> - A tiered model's input term is priced at its highest context tier.
> - A pre-content 429 releases its admission, and a pre-content 5xx, timeout or transport failure stays committed.

> Amended 2026-10-02 — [ADR-0099](0099-compaction-has-an-idle-budget-outcome-and-an-unknown-window-policy.md),
> accepted by the maintainer, qualifies §2 invariant 2 for summariser requests: each pass respects every
> attemptable known fallback window and its output reservation. Main-turn measurement still uses the first
> entry actually attempted. §3 invariant 4's unknown-window fit guarantee is replaced by disclosed manual
> best effort under a 16,384 estimated-input-token soft bound; a mixed chain also retains every known bound.
> Automatic paths skip unknown windows. Idle budget refusal preserves history and the completed turn,
> surfaces separately and never trims; active-turn refusal retains `budget_exceeded`. Estimation remains
> heuristic, never a bound on actual provider tokenisation. Implementation is staged in `W7`; the historical
> text below is unchanged.

> Amended 2026-10-02 — [ADR-0101](0101-configured-output-estimates-apply-only-when-the-wire-is-uncapped.md),
> accepted by the maintainer, explicitly qualifies September 18's unauthored-output acceptance:
> the shared 4,096 fallback applies only when no effective canonical/native cap or required adapter
> default exists and no configured estimate is supplied, then follows official catalog clamping.
> Known caps take precedence; an explicitly configured estimate remains effective only when uncapped.
> This expands the one seam-level helper into a shared immutable cap plan, with required cap-only
> `PreAttemptHook` inputs and prepared-plan handoff from measurement to the matching attempt. It
> qualifies the earlier hook premise without moving input estimation from the turn core's current
> pre-strip round request. Resolved input/output quantities use rate-only pricing. No generation
> limit or thinking control changes; main-turn skip/failure rules and ADR-0099 outcomes stay intact.
> Implementation is staged in W7, with runtime handoff/parity acceptance still required.

## Context

Three defects make a long session fail badly, and all three are live:

1. **Nothing checks a request against the window before it is sent.**
2. **An overflow kills the turn with no recovery.** It becomes `bad_request`, which is fatal.
3. **The budget estimate ignores input.**

The token heuristic has a flaw of its own: it charges every non-text part a flat 256 characters, so a 40 KB tool
result counts as about 64 tokens.

**The earlier drafts, and what their review established.** Four review rounds tested those drafts against the
code, and every finding below was confirmed there. They are recorded because each constrains the decision:

- **Re-running a turn after a tool round re-fires its tools.** That is why `CR-95` refuses a mid-loop pause.
- **Window fill cannot be read from usage.** A turn's usage is summed across its tool rounds. OpenAI and Gemini
  report input net of cached tokens. Even the last attempt's input includes a tool loop that the next request does
  not carry.
- **Neither `compact()` nor `trimHistory` can run inside a turn**, because both assert that the session is idle.
- **Forced compaction overflows when the summariser is sent the whole conversation.**
- **With input priced, a committed overflow debits a full window against the cap.**
- **A surface already acts on the overflow distinction.** The CLI keyword-matches provider wording.
- **The engine cannot read an error kind it never receives.** `AgentTurnError` drops the kind.
- **A new hook field can be silently dropped.** `PreEgressHook` is exported, and the CLI forwards it positionally.
- **Adapters clamp an authored `max_tokens` to the model's output ceiling.**

## Decision

### 1. The estimate sees what it measures

`estimateRequestTokens` counts tool arguments, tool results and reasoning text by their length. A media part is
charged a per-modality ceiling, set at no less than the largest documented per-part input charge among the supported
providers, with that source cited. A part that cannot be serialised is charged a conservative ceiling. The seam's doc comments (`types.ts`, `adapters/shared.ts`) and ADR-0062 §4 frame the estimate as a fallback that "never drives a live decision"; that stops being true, and both are corrected.

**Invariant.** Every part adds at least its serialised length divided by the estimator's character ratio, and a part that cannot be serialised adds a fixed conservative ceiling. The estimate is a heuristic and does **not** bound the real token count. PDF, audio and video input parts carry no size on the in-flight part, so they are charged per part and can be under-counted; that residual is recorded, not denied.

### 2. What is measured is the next request, against the window it will actually use

**Invariants.**

1. **The measured request is the one the next attempt will send.** It is built by ADR-0095 §4's rules, and includes
   the system prompt, the pending user text and the tools. It is never the raw transcript, and never a previous
   attempt's usage.
2. **The window is that of the first entry the chain will actually attempt**, after every pre-skip the chain applies —
   capability and cooldown alike.
3. **The output reservation is the output cap the adapter will actually send** for that entry: the authored
   `max_tokens`, or the default, clamped as the adapter clamps it.
4. **Calibration uses only a request of the same shape.** Any correction of the heuristic against real usage is
   learned from a request of the same shape as the one it predicts — transcript plus a user message, with no in-turn
   tool rounds — using gross input, cached tokens included. It resets when the model or provider changes.
   `result.usage` and `session:turn_completed.tokensUsed` keep the billing sum unchanged.
5. **ADR-0062 §5's after-turn trigger measures this same quantity.**

### 3. A session compacts before a turn, never inside one

A session measures the next request before it sends anything. It compacts first when the projected input exceeds
`compact_threshold × window`, or when the projected input plus the output reservation exceeds the window. Whether
compaction may run at all is decided by ADR-0095 §4.

**Invariants.**

1. **Exactly one terminal per turn, whatever pre-send or recovery compaction does.**
   - A turn stopped by the turn cap makes no summariser call.
   - An Esc sends no request, or no retry, and the turn settles aborted.
   - A `cancel()` makes `session:cancelled` the sole terminal.
   - An unclassified throw fails the turn as `internal`.
   - A summariser failure during recovery ends the turn with one `context_overflow` terminal and no retry.
2. **A failed pre-send compaction does not stop the turn.** The request is sent, and §5 does not compact again in
   that turn. This deliberately departs from ADR-0062 §5's trim-on-failure, which remains the after-turn behaviour.
   A pre-send trim would need a trim that does not assert idle. The departure costs one request that may overflow,
   and that overflow is classified and released (§5).
3. **Compaction is skipped when it cannot help.** If the part that cannot be folded already exceeds the window —
   the system prompt, the tools, the pending user text, the summary bound and the output reservation — pre-send
   compaction is skipped rather than retried.
4. **The summariser's own input always fits its window**, including its system prompt and any prior summary. That
   holds for the public `/compact` too, so the remedy §5 names cannot overflow.
5. **Mid-turn, nothing is refused on the heuristic.** A later round's request is sent, and an overflow is
   classified (§4).

### 4. A context overflow is a classified kind, carried to the engine and to the surfaces

`LlmErrorKind` and `ErrorCode` both gain **`context_overflow`**. `ErrorCode` grows because ADR-0082 §9's test is
met: a surface acts on the distinction. Neither is retryable.

**Invariants.**

1. **Every classification is pinned by a recorded fixture** of that provider dialect's real response.
2. **A custom endpoint is never classified**, keyed on `LlmProvider.customEndpoint`, not on a provider id a custom
   endpoint may reuse. Its overflow stays `bad_request`, and the CLI's keyword heuristic remains its only hint.
3. **The engine can tell a recoverable overflow apart.** `AgentTurnError` carries an engine-internal flag that is
   true only when the turn dispatched no tool round and the attempt committed no content. It is not part of any
   public contract.
4. **The failed attempt record carries the classified kind and a chain-set `contentReceived: boolean`.** It is
   `false` only when the chain observed no content chunk. `LlmError.contentCommitted` is unchanged and still feeds
   `CR-95`.
5. **The fallback chain does not advance on an overflow.**

### 5. One recovery, and only before any tool has run

**Invariants.**

1. **A session recovers at most once, and only before any tool runs.** It compacts and retries a turn **once**, and
   only when the overflow is recoverable (§4.3), ADR-0095 §4 permits compaction, and pre-send compaction did not
   already fail in that turn. The retry uses the same turn number and counts once against `max_turns`.
2. **An overflow after a tool round is never recovered by re-running the turn.** The in-turn continuation that would
   recover it is deferred in [deferred-tasks.md](../roadmap/deferred-tasks.md). Its trigger is the first user whose
   tool-heavy turn dies at round one or later.
3. **The failure is visible, says whether tools ran, and names a remedy that can work.** The message is
   engine-authored, never interpolates provider text, and is displayed on the chat surface. Its remedy depends on
   the effective `memory` policy (ADR-0095 §4 invariant 3). A user whose tools already ran is not told simply to
   resend.
4. **A workflow `agent` node fails with `context_overflow`** and a message naming the model's window.
5. **A classified overflow is released only on positive evidence.** An attempt's admission is released rather
   than committed only when all three hold:
   - the attempt record says `context_overflow`;
   - it says `contentReceived: false`;
   - the endpoint is not custom.

   In every other case the existing ADR-0074 commitment stands. This refines ADR-0074 §1 on that one point.

### 6. The pre-egress estimate prices input, at every attempt

**Invariants.**

1. **Every attempt is priced with its input.** The turn core computes `inputTokensEstimate` from the materialized
   request at each attempt, on both paths, and the governor prices it at the model's full input rate.
2. **Every adapter that forwards `PreEgressHook` passes the field through**, and a test pins each forwarding site.
   A dropped field silently zeroes the input term.
3. **An un-approved run whose input grows past its cap mid-loop fails closed** under `CR-95`, where it was admitted
   before and overspent. That behaviour change is stated here rather than discovered.

### Implementation notes (non-normative)

These are traps found in mechanisms earlier drafts specified:

- **Where the turn's guards live.** The cap gate and the user-message push sit before `sendMessage`'s `try`
  (`agent-session.ts:707-713`). The `finally` that restores `#abort`, `#abortingTurn` and `#status` is at `:801-805`.
  Pre-send work outside that block would leave a throw with no terminal.
- **`compact()` and `trimHistory` both call `#assertSendable()`.**
- **Usage is summed and net.** A turn's usage is summed across rounds (`agent-turn.ts:1146`). OpenAI and Gemini report
  input net of cache (`openai.ts:182-184`, `gemini.ts:312-313`).
- **Adapters clamp the output cap** through `cappedMaxTokens`.
- **One adapter serves more than one provider.** The OpenAI adapter serves OpenAI, DeepSeek and custom endpoints.
- **The chat surface displays messages only for listed codes.** `SAFE_MESSAGE_CODES` and `PROVIDER_MESSAGE_CODES`
  in `chat-projection.ts` decide which codes' messages it shows.
- **A failed attempt record carries no usage** (`fallback-chain.ts:688`). The turn core commits the reservation of
  any attempt without usage (`agent-turn.ts:1136-1143`).

### Alternatives

Considered **refusing mid-turn on the heuristic** (rejected by the maintainer). Considered **building the in-turn
continuation now** (deferred by the maintainer). Considered **keeping `ErrorCode` closed** (rejected: a surface
acts on the distinction). Considered **retiring the CLI heuristic entirely** (rejected: it is an unclassifiable
endpoint's only hint). Considered **advancing the chain on overflow** (rejected: it silently changes models).
Considered **pricing input only on the chat path** (rejected: one governor serves both). Considered **specifying
the ordering and measurement algorithms here** (rejected by the maintainer after four rounds; the invariants and
tests bind the implementation instead).

## Consequences

### Positive

- A turn that would overflow is compacted before it is sent. One that overflows before any tool runs recovers once,
  and nothing is re-fired.
- The cap sees input, and an overflow no longer consumes cap headroom.
- A surface tells an overflow apart by a code.

### Negative

- **An overflow after a tool round fails the turn.** Accepted: the alternative re-fires tools.
- **Runs near their cap may pause or fail earlier.** Accepted, consistent with ADR-0028's "may stop slightly early
  rather than overshoot".
- **Two closed unions gain a member.** Accepted: the compiler finds every switch.
- **A custom endpoint's overflow stays unclassified.** Accepted and documented.

### Acceptance

- **Tools never re-fire.** An overflow after a tool round re-dispatches no tool, and the chat user sees that tools
  had run.
- **Recovery is bounded.** A pre-content overflow on round 0 compacts and retries once; a second overflow fails
  without a third call.
- **The right request is measured.** A five-round tool turn does not trigger compaction, and a cache-hit turn is not
  read as nearly empty.
- **The right output cap.** An authored `max_tokens` above the model's output ceiling does not trigger compaction
  below the threshold.
- **The right window.** A capability-skipped primary does not size the window.
- **Pre-send and recovery edge cases.**
  - A turn blocked by the turn cap makes no summariser call.
  - An Esc during pre-send compaction sends nothing, and an Esc during recovery compaction sends no retry; both settle
    aborted.
  - A `cancel()` during either compaction gives `session:cancelled` as the only terminal.
  - An unclassified throw during pre-send compaction settles `internal`, with exactly one terminal.
  - A failed pre-send summariser costs one call, recovery does not call it again, exactly one `session:turn_completed`
    is emitted, and the next `sendMessage` is accepted.
- **Resume.** A pre-send compaction followed by `chat-resume` resumes exactly the in-memory transcript.
- **The summariser fits.** A conversation larger than the window compacts with summariser requests that each fit.
- **Release, not commit.** A classified pre-content overflow releases its admission. An overflow after content was
  received, an attempt without `contentReceived: false`, and a custom endpoint's overflow all stay committed.
- **The estimate is not dropped.** `inputTokensEstimate` survives every forwarding site.
- **The estimate is priced.** Holding output equal, an attempt whose `inputTokensEstimate` alone pushes the projection
  past the cap is paused or refused.
- **The estimate is recomputed every round.** In a two-round tool turn whose round-1 tool result is large, the
  estimate forwarded for round 1 is greater than round 0's and is computed from round 1's request. An un-approved run
  whose input grows past its cap at round 1 or later ends `budget_exceeded` without dispatching that request.
- **The estimate counts what it sees.** A 40 KB tool result is counted by its length, reasoning text is counted, and a
  part that cannot be serialised adds the ceiling.
- **Fixtures.** Each provider dialect's classification is pinned by a recorded fixture.
- **`memory: none`.** An overflow names a shorter message or a larger model, never `/compact`.

### Landing obligations

- **Dated notes**: ADR-0062 (§1, §4, §5), ADR-0028, ADR-0074.
- **Canonical docs**: [llm-provider-seam.md](../reference/shared-core/llm-provider-seam.md) (the kind and the attempt
  record), the `ErrorCode` list with [error-handling.md](../standards/error-handling.md),
  [sse-event-schema.md](../reference/contracts/sse-event-schema.md),
  [agent-session-spec.md](../reference/contracts/agent-session-spec.md), and
  [chat-session.md](../reference/cli/chat-session.md).
- **Records**: the in-turn continuation deferral in [deferred-tasks.md](../roadmap/deferred-tasks.md).

## Implementation correction — 2026-10-02, W7 step 6 second review

The materialized request includes its authored structured response format/output schema, not only
system text, messages and tools. A real workflow-to-SDK offline control reproduced a 40 KB schema
on the wire with no contribution to the new input-price estimate. `EstimateTokensInput` now carries
the optional seam response format, and the current constructed pre-strip request forwards it to
the shared estimator. Its JSON form keeps the same serialized-length floor and per-unit fallback;
a plain-text or absent format adds nothing. A dialect that removes the schema can be conservatively
overcounted, just as an attempt that strips reasoning already is. The heuristic still does not claim
a measured provider token count or a physical bound. Canonical details remain in the
[LLM seam](../reference/shared-core/llm-provider-seam.md#current-request-estimates-and-bound-output-caps)
and [core hook contract](../reference/shared-core/agent-runner.md#pre-egress-injection-contract).

## W7 owned adapter/chain handoff — 2026-10-08

The maintainer-approved [ADR-0102](0102-a-measured-request-owns-its-inert-data-through-egress.md)
now supplies the production controlled-adapter/fallback-chain boundary. Its supported inert-data
contract, intentional compatibility narrowing and separate native-cap exception have one canonical
home in the [LLM seam](../reference/shared-core/llm-provider-seam.md#request-data-ownership).
Generate/stream own data before asynchronous handoff, SDK attempts get fresh graph-preserving
mutable copies, and streams capture at invocation. No provider preparation interface, vendor type
across the seam, runtime dependency, input-pricing change or durable body is added. Separate-endpoint
media generation/polling retains its existing contract.

This is the adapter/chain integration increment, not closure of the measured-request High. Core's
exact first measured/quoted-round reuse, pre-attempt closure and Step 8 summariser/context recovery
remain open and require their own production controls and fresh independent acceptance. Implementation
of this increment does not assert that those later obligations have landed.

## W7 Step 8 implementation — 2026-10-10

The approved measured compaction/recovery and idle budget policies are implemented on
`development`, pending independent implementation acceptance and final whole-wave validation.
The [session contract](../reference/contracts/agent-session-spec.md#measured-compaction-and-one-shot-recovery)
and [event contract](../reference/contracts/sse-event-schema.md#session-event-namespace) own the
current mechanics and shapes: all-candidate measured bounds, four-pass atomic installation,
acknowledged unknown-window disclosure, balanced moments and distinct idle/active budget outcomes.
No accepted policy is superseded; this dated landing note leaves the historical body intact.

### W7 implementation landing — 2026-10-10

The approved W7 implementation and scoped independent reviews are complete. Final whole-wave
acceptance, per-item causal evidence, canonical landing checks and approved residuals are joined in
the [W7 closing register](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md#w7-closing-register--2026-10-10).
This dated note preserves the earlier decision and status history; W8 and the phase remain open.
