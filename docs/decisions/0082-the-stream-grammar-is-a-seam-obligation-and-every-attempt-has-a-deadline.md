# ADR-0082: The stream grammar is a seam obligation the chain verifies, and every chain attempt has a hard deadline

- **Status**: Accepted
- **Date**: 2026-08-18
- **Related**:
  - [ADR-0011](0011-internal-llm-abstraction.md) — the `LLMProvider` seam. **Amended here**: the seam gains a stated stream grammar, one new `LlmErrorKind`, and one new optional `LlmError` field. No vendor type crosses it and its shape is otherwise unchanged.
  - [ADR-0030](0030-llm-seam-shape-amendment-reasoning-response-format-provider-executed.md) — the last seam-shape amendment, whose form this follows.
  - [ADR-0036](0036-run-loop-substrate-event-bus-and-execution-host.md) — exactly-one-terminal for the RUN, and cancel-wins precedence. This is its per-stream analogue and reuses its precedence rule.
  - [ADR-0040](0040-node-retry-budget-above-the-chain.md) — the node-retry budget. §4 exists because that budget currently re-dispatches a call that already produced content.
  - [ADR-0074](0074-durable-conservative-budget-commitments.md) — the conservative commitment an attempt with no trustworthy usage creates. Changing what counts as a successful attempt changes what that commitment attaches to, so §12 pins the money invariants.
  - [ADR-0080](0080-durable-effect-journal-and-the-tiered-effect-contract.md) — the precedent for "a failure past a commitment point is not retryable". Rule 7 is that rule about tokens instead of effects.
  - [ADR-0045](0045-async-media-job-loop-poll-checkpoint-resume-cancel.md) — its poll deadline maps a timeout to a retryable `provider_unavailable`, the same choice §5 makes; its poll LOOP is out of scope (§11).
  - [llm-provider-seam.md](../reference/shared-core/llm-provider-seam.md) — the one canonical home for the seam contract, where the grammar's normative text lands.
  - [error-handling.md](../standards/error-handling.md) — where the `LlmErrorKind` table lives; `protocol` lands there.
  - [security-review.md](../standards/security-review.md) — the outbound-request rule that forbids letting a vendor default become our liveness semantics.
- **Closes**: **Decides** `CR-14` and `CR-21` of [phase 2.6.5](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md). Accepted 2026-08-18 after two review rounds; the maintainer's two blockers (rule 7's missing node-retry half, and a cooperative signal mistaken for a deadline) and the second round's correction — that the chain ALREADY tracks commitment — are all folded into the text above. The §13 obligations land with the implementation.

## Context

Two gaps that share one question.

**The stream has no stated grammar, so nothing verifies one.** `StreamChunkSchema` types individual chunks and
says nothing about their ORDER: `stop` and `error` are both terminal arms, and the schema is equally happy
with two of them, neither of them, or content after one. `FallbackChain.#runEntryStream` iterates the
provider's chunks, records `usage` if it happens to see a `stop`, and on a clean end-of-iteration falls
through to `usage === undefined ⇒ #emitSuccess`. A stream that simply stops is a successful attempt whose
partial text becomes a completed assistant answer, and `fallback-chain.test.ts`'s *"records a content-free
success with no usage when the stream omits a stop chunk"* pins exactly that.

The phase document's framing of this was wrong in a way that moves the fix, and both halves of the correction
matter.

*It claimed the adapters do not detect a truncated stream.* They do: `anthropic.ts` tracks `sawStop` and emits
a `transport` error on a no-terminal EOF, and `openai.ts` and `gemini.ts` do the same with `sawTerminal`. A
real transport cut against a first-party provider is already classified today.

*And this ADR's own first draft claimed the chain has no commitment tracking.* It does. `isContentChunk` is
already defined as *"anything other than the terminal `stop`/`error` arms"*, `StreamAttemptState.committed` is
already set from it, and `if (attemptState.committed) return 'done'` already prevents failover past content —
pinned by *"commits the stream on a non-text content chunk (tool_call_start), preventing failover"*. Writing
that mechanism into this ADR as new would have invited a second, competing tracker.

So what is actually missing is smaller and sharper than either draft said:

1. **`FallbackChain` has no trust boundary.** It accepts any `LLMProvider`. The audited adapters are not the
   only implementations: `cassetteProvider` and the test doubles are providers, and Phase 2's
   `ManagedGatewayProvider` will be one. A rule enforced only inside implementations we happen to own is a
   coincidence, not an obligation.
2. **The chain's success path never asks whether a terminal was seen.** `usage === undefined` means "nothing
   to fold" and is treated as "the attempt succeeded".
3. **Commitment stops at the chain.** It suppresses FAILOVER and travels no further, so the node-retry budget
   above the chain re-dispatches a node whose provider call already produced content and already billed.

**And no attempt has a deadline we own.** The chain awaits `generate`/`stream` with the caller's signal and
nothing else. `list-models` and key validation both bound themselves (`VALIDATE_KEY_TIMEOUT_MS`); a real turn
does not. Absent a node or run timeout the vendor SDK's default becomes the product's liveness semantics —
which [security-review.md](../standards/security-review.md) forbids for an outbound request, and which is not
a semantics we chose or can state.

The two land together because they share one question — *had this attempt already produced content?* —
and answering it in two places would let the answers drift.

## Decision

**We will state the stream grammar as a seam obligation, verify it in `FallbackChain` where the seam is
crossed, carry content-commitment past the chain so the node-retry budget can honour it, and give every
attempt a HARD deadline rather than a cooperative one.**

### 1. The grammar

Normative for every `LLMProvider.stream` implementation. Canonical home:
[llm-provider-seam.md](../reference/shared-core/llm-provider-seam.md).

1. **Exactly one terminal per stream:** `stop` **xor** `error`.
2. **The terminal is the last chunk.**
3. **No chunk of any kind after the terminal.**
4. **Two `stop`, `stop` + `error`, or two `error` are violations** — the caller-side restatement of 1 and 2,
   kept separate because it is the shape a broken implementation actually produces.
5. **A clean EOF with no terminal is an error, never a success.**
6. **An empty stream — EOF with no chunks at all — is an error.**
7. **A pre-content failure may fail over; a content-committed failure must not fail over AND must not be
   node-retried.** It is surfaced.

**"Content-committed" means: any chunk other than `stop` or `error` has been yielded.** Not "content or
`*_delta`" — that phrasing left `reasoning_start`, `tool_call_start`, `media_start` and a provider-executed
`tool_result` undecided. The definition above is what `isContentChunk` already implements and what the
existing `tool_call_start` test already pins, so this ADR is recording the shipped rule, not changing it.

### 2. Classification is a table of DISJOINT cases, not one per rule

The rules above overlap by design — an empty stream violates 1, 5 and 6 at once; `stop → text_delta` violates
2 and 3 — so "one error class per rule" is not expressible and "one fake provider per rule" is not a testable
acceptance criterion. What a verifier needs is a decision procedure. This is it, evaluated in order:

| observed | classification |
|---|---|
| a chunk arrives after a terminal | `protocol` |
| a second terminal arrives | `protocol` |
| EOF, ≥1 non-terminal chunk seen, no terminal | `transport` |
| EOF, zero chunks at all | `transport` |
| EOF, exactly one terminal, last | *well-formed* — the terminal's own semantics apply |

**Why an empty stream is `transport` and not `protocol`.** It is operationally indistinguishable from a
connection that opened and died, which is what `transport` names. Classifying it as a protocol violation also
created a live inconsistency: the adapters' retained `if (!sawStop)` check fires unconditionally, so a
zero-chunk first-party stream already becomes a well-formed single `transport` error — while a foreign
zero-chunk stream would have become `protocol`. Same fault, opposite verdict, in direct contradiction of §3's
own reasoning. Classifying rule 6 as `transport` removes the divergence with no adapter change, and it is the
more honest reading besides.

An immediate provider `error` as the first and only chunk stays well-formed and keeps its own kind — the
verifier cannot tell that from a synthesized truncation error, and must not try.

### 3. `FallbackChain` verifies; the adapters keep their checks as defence in depth

The chain wraps every provider iterator in a verifier applying §2's table. It is the only enforcement point
that matters, because it is the only one on the seam rather than inside one implementation of it.

The adapters' `sawStop`/`sawTerminal` checks are deliberately **kept**: they produce a better-attributed error
(the adapter knows it was reading an SSE stream), and they classify a first-party truncation before it reaches
the verifier. Two layers detecting one fault is not duplication here — one is a contract check on an untrusted
input, the other a diagnostic on a trusted one.

Considered and rejected: enforcing in the adapters only (the status quo, which leaves every foreign provider
unchecked); enforcing in `packages/core`'s turn loop (too late — the chain has already emitted a success
record and folded usage, and the turn loop cannot see chunk order across a failover); tightening
`StreamChunkSchema` (a per-chunk schema cannot express ordering).

### 4. Rule 7 has TWO halves, and only one of them is shipped

**The failover half already works.** `attemptState.committed` suppresses it, as above. This ADR does not
change it and does not add a second tracker.

**The node-retry half has no carrier, and that is this ADR's most consequential fix.** A content-committed
`timeout` or `transport` failure is surfaced with its own kind — and both are in `RETRYABLE_KINDS`, so
`retryable: true`. `agent-turn`'s `throwMappedChainError` copies that onto `AgentTurnError`, and the engine's
`#shouldRetry` gates purely on `error.retryable`. So:

> `text_delta` → `timeout` → the chain correctly refuses to fail over → the node layer re-dispatches anyway →
> a second answer, a second charge.

Adding the `protocol` kind does not help: it covers grammar violations, not the ordinary transient failures
that make up almost all of this case.

**The decision: `LlmError` gains an optional `contentCommitted?: true`, set by the chain when it surfaces a
failure past the first non-terminal chunk, and folded into retryability where chain failures enter the turn
taxonomy** (`retryable && contentCommitted !== true`).

Considered and rejected: **overriding `retryable: false` on the error** — the simplest change, and it breaks
the invariant `makeLlmError` establishes, that `retryable` is a pure function of `kind`. A reader who then
sees `kind: 'timeout', retryable: false` has no way to tell a deliberate suppression from a bug, and the
reason is nowhere in the value. **A separate failure envelope around the `LlmError`** — a larger seam change
that every consumer would have to unwrap, for one bit. **Leaving it to each surface** — the fail-open this ADR
exists to close.

The cost is honest and stated: one more optional field on the seam's error type, and one fold site that must
not be forgotten. §12 pins both.

### 5. The deadline is HARD, not cooperative

An `AbortSignal` is a request, not a guarantee. A provider that ignores it —

```ts
generate(): Promise<LlmResult> { return new Promise(() => {}); }
```

— or whose iterator's `next()` never settles leaves the chain waiting forever, which is exactly the hang the
item exists to remove. The repo already knows this: `safe-egress.ts` and the CLI's key validation both race a
cooperative abort against a hard timer rather than trusting the signal alone.

So:

- The attempt runs under a signal that aborts on EITHER the caller's signal or the deadline, **and** the
  awaited promise is hard-raced against the deadline.
- **Streaming races the same ABSOLUTE deadline against every `next()`**, and does not reset it per chunk. A
  per-chunk reset would let a provider dribble one token per interval forever.
- On timeout the iterator's `return()` is called best-effort and **not awaited without bound** — a hung
  iterator must not hang the cleanup too.
- A late result or chunk arriving after the deadline is **discarded**, and produces no second attempt record
  and no cost update.
- **The guarantee is chain and caller liveness, not resource termination.** An uncooperative provider's work
  may continue in the background; what is bounded is how long Relavium waits. Saying otherwise would be a
  promise this design cannot keep.

Classification:

- A deadline abort is `kind: 'timeout'` (already retryable, already mapped to `provider_unavailable` — the
  same choice ADR-0045's poll deadline makes).
- A caller abort is `kind: 'cancelled'`.
- **Precedence when both fire in the same tick: the caller wins.** If the caller's signal is aborted at the
  moment of classification, the failure is `cancelled` even if the deadline has also elapsed — the same
  cancel-wins rule ADR-0036 uses. Without a stated rule the answer would depend on listener order, and the
  test would pin a scheduler detail rather than a contract.
- Rule 7 governs both: a pre-content timeout may fail over; a content-committed one is surfaced with
  `contentCommitted`.

### 6. The timer port, the window, and the default

- **Port.** The chain's existing `sleep(ms, signal)` and `now()` are not a disarmable one-shot timer. It gains
  `newAbortController: () => AbortControllerLike` and a `setTimer(ms, fire) => disarm` alongside them —
  host-injected for the same reason the others are: the seam is platform-free.
- **The window opens immediately before the seam call** — after `preAttempt`, after media re-materialization,
  after credential resolution. Those are Relavium's own work and must not consume the provider's budget.
- **It is an ABSOLUTE per-attempt deadline, not an inactivity timeout.** Simpler to state, simpler to test,
  and it is what bounds the caller's wait; a stall detector is a separate mechanism and is not decided here.
- **The default is `120_000` ms**, stated here rather than only in the seam doc — a default is part of the
  decision, and an append-only ADR should not defer its own substance to a mutable document. Hosts override
  it. A non-finite or non-positive value is a configuration error, refused at construction; **the timeout
  cannot be disabled**, because "unbounded" is the state this ADR removes.
- **Against the caller's, the node's and the run's deadlines: whichever elapses first wins.** They compose by
  earliest-expiry, and this one is the only one scoped to a single attempt.

### 7. The terminal is buffered until EOF confirms it

Rule 2 cannot be checked when the terminal arrives — only the NEXT read tells you it was last. And the chain
returns from the attempt the moment it sees an `error` chunk, so `error → text_delta` and `error → error`
would never be read at all.

The verifier therefore **holds the terminal chunk, reads once more, and only then emits**: EOF confirms it and
it is forwarded; another chunk means a `protocol` failure is surfaced *instead of* the terminal. That
lookahead read is itself inside the attempt's deadline, so a provider that goes quiet after its terminal
cannot hang the verification.

### 8. The verifier checks ORDER; runtime shape stays a separate obligation

The verifier does not `StreamChunkSchema.parse` every chunk. It is a grammar check, and the seam's shape
obligation is stated separately and enforced by the conformance suite.

That is a deliberate line, not an omission. Parsing every chunk of every token stream through Zod is a real
per-chunk cost — and unlike the ordering check, it is not a boolean branch, so the performance claim in the
Consequences below would stop being true. A foreign provider that emits a malformed chunk SHAPE is a bug the
conformance suite is there to find; a foreign provider that emits well-shaped chunks in an impossible order is
what silently becomes a wrong answer, and that is what this verifier is for.

### 9. `protocol` gets its own `LlmErrorKind`, mapped to the existing `provider_unavailable`

`protocol` is **not** in `RETRYABLE_KINDS`. A provider that cannot keep the grammar will not keep it on the
second call; retrying burns the node budget and reports the wrong cause.

But a pre-content `protocol` failure should still advance to the NEXT entry — a different provider may be
well-behaved and the user has been shown nothing. Today the chain's `Verdict` is
`'fatal' | 'retryable' | 'auth-refreshed'`, and `retryable` first consumes the current entry's attempt budget
before advancing. That is the wrong shape for this: re-attempting the same broken provider is pointless.

**So `Verdict` gains an arm: `'advance'` — go to the next entry without re-attempting this one.** `protocol`
pre-content resolves to `advance`; `protocol` content-committed is surfaced.

No new `ErrorCode`. From a surface's standpoint a provider that cannot keep the stream grammar is not usable
for this request, and the remedy is what `provider_unavailable` already names. Widening a closed taxonomy that
every surface switches on, for a distinction no surface would act on differently, costs every one of them a
case and buys nothing. The load-bearing distinction — do not re-dispatch — is carried by `retryable: false`,
where the engine actually reads it.

**One authoring consequence, called out so it is not discovered:** because `protocol` maps to
`provider_unavailable` with `retryable: false`, an authored `retry_on: [provider_unavailable]`
([ADR-0040](0040-node-retry-budget-above-the-chain.md)) does **not** make a grammar violation retryable. The
retryability gate runs first.

### 10. Scope: `FallbackChain` attempts. `generateMedia()` submission is named, not silently included

This ADR bounds every `generate`/`stream` attempt made through `FallbackChain`. The first
`generateMedia()` submission is currently awaited directly and unbounded — it is not a poll, so ADR-0045's
poll deadline does not cover it, and it is not a chain attempt, so this does not either.

That gap is **named rather than absorbed**: bounding it needs the same treatment on a different call path, and
folding it in here would make the title claim more than the mechanism delivers. It becomes a tracked item on
the phase document with this ADR as its reference.

### 11. What is NOT decided here

- `CR-20`'s tool timeout and `CR-22`'s absolute resume deadlines are separate timers and stay separate. This
  one bounds a single provider attempt; those bound a tool dispatch and a whole run.
- ADR-0045's media-job poll LOOP is untouched — its liveness is a poll interval against a provider-side job.
- `CR-23`'s never-settling node executor is a run-level liveness property with an open decision of its own.
- An inactivity/stall detector, as distinct from §6's absolute deadline.

### 12. Acceptance

Driven through fake providers, because the whole item is about not trusting the implementation.

**The grammar**

1. One test per row of §2's table, each with a fake provider producing exactly that observation.
2. A stream ending with no terminal produces a classified error and **no successful attempt record**.
3. An empty stream produces a classified `transport` error.
4. `error → text_delta` and `error → error` are detected — the cases the pre-lookahead chain could never see.
5. A pre-content `protocol` violation resolves to `advance`: the next entry is attempted, and the broken entry
   is **not** re-attempted. Assert the attempt records, not just the outcome.
6. A content-committed violation does not fail over and produces no second attempt record.
7. `protocol` is absent from `RETRYABLE_KINDS`.

**Rule 7's node-retry half — through the real engine, not a unit stub**

8. A workflow node with `retry.max > 1` whose provider emits `text_delta` then `timeout` results in
   **exactly one** provider call. The same for `transport`. This is the test whose absence let the defect
   exist.
9. A PRE-content `timeout` with `retry.max > 1` **is** re-dispatched — the negative control, without which
   test 8 passes for an implementation that disabled node retry entirely.

**The deadline**

10. A `generate()` that never settles and ignores its signal fails `timeout` within the deadline.
11. A stream iterator whose `next()` never settles does the same, and a provider that yields one chunk per
    interval indefinitely still hits the ABSOLUTE deadline.
12. A caller abort in the same tick as the deadline classifies `cancelled`, asserted against the contract
    rather than against fake-timer callback order.
13. Timer cleanup proven with a fake clock on every path, **including success**.
14. A late result arriving after a deadline abort produces no second attempt record and no cost update.

**Money (ADR-0074)**

15. An EOF-without-terminal and a deadline abort each produce exactly **one** failed attempt record.
16. With no trustworthy usage, the conservative commitment is **not** released — the same invariant the
    current budget tests prove, re-asserted through a failed attempt instead of a spurious success.

**The superseded tests**

17. Tests resting on no-terminal-as-success are **rewritten, not deleted**, each carrying a note recording
    the reasoning it replaces, the way `checkpointer.test.ts` was handled in Wave 1. The phase document's
    "an existing test" is singular and wrong; the real set, verified against the tree:

    - `packages/llm/src/fallback-chain.test.ts` — done with the carrier.
    - `packages/core/src/engine/agent-turn.test.ts` — done with the carrier.
    - `packages/core/src/engine/m2-e2e-harness.e2e.test.ts` — **deferred to the wiring step, by design.**
      It proves ADR-0074's conservative commitment survives a resume, using a no-terminal stream as its
      usage-less attempt. Rewriting it before the verifier is wired would leave the money property untested
      across the transition; rewritten WITH the wiring, §12.15-16's invariants are proven continuously. The
      file carries this note in place.
    - `apps/cli/src/commands/agent-run.test.ts` — **not actually affected.** Every scripted stream in it
      already ends with an explicit `stop`. Listed here in error when this ADR was drafted; the count was
      four and is three.

**Performance**

18. The per-chunk verifier cost is **measured** on a representative token stream, not asserted.

### 13. Landing obligations

Part of the change, not follow-ups:

- ADR-0011: a dated amendment note for the grammar, the `protocol` kind and the `contentCommitted` field.
- [llm-provider-seam.md](../reference/shared-core/llm-provider-seam.md): the normative grammar, the
  content-committed definition, the deadline contract and its default.
- [error-handling.md](../standards/error-handling.md): a `protocol` row in the `LlmErrorKind` table.
- The authoring note from §9 about `retry_on: [provider_unavailable]`.
- The seam doc's use of "terminal" for `media_end` clarified to "closes the media block", so it does not
  collide with §1's stream terminal.
- The `generateMedia()` submission deadline (§10) filed as a tracked phase item.
- This ADR to Accepted, with the index row to match.

## Consequences

### Positive

- The seam's obligation is stated and verified where it is crossed, so a cassette, a test double and Phase 2's
  managed gateway are held to the same rule as an adapter we wrote.
- A truncated answer stops being reported as a complete one — the user-visible defect.
- The double-answer-double-charge path above the chain closes. Rule 7 gains its missing half.
- A hung provider can no longer hang a turn, whether or not it honours an abort.
- No vendor type crosses the seam, no new dependency, no new `ErrorCode`.

### Negative

- **The seam's error type and kind enum both grow.** Every exhaustive switch on `LlmErrorKind` must handle
  `protocol`; the compiler finds them. The `contentCommitted` fold is one site that must not be forgotten,
  which is why acceptance test 8 goes through the real engine.
- **`retryable` stops being the whole answer.** A reader must now know that commitment also gates retry. The
  alternative — silently overriding `retryable` — hides the reason inside a boolean, which is worse.
- **The verifier and the lookahead sit on the hot path.** One branch and one held chunk per stream. Measured
  rather than assumed (test 18); a boolean check is not where a streaming turn spends its time, but the claim
  should be evidence.
- **A deadline can cut a legitimately slow attempt.** Hence a host-configurable default rather than a
  compiled-in one. It cannot be disabled, which is a deliberate refusal: "unbounded" is the state being
  removed, and a config flag restoring it would restore the defect.
- **Two layers detect a truncated first-party stream**, so a future change to one can leave the other wording
  the same fault differently. Accepted: the redundancy is the trust boundary working, and the adapters'
  messages are better attributed.
- **`generateMedia()` submission stays unbounded** until its own item lands. Named in §10 rather than papered
  over by a title that would imply otherwise.
