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
