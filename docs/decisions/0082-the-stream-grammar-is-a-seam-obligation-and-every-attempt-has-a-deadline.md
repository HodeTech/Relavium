# ADR-0082: The stream grammar is a seam obligation the chain verifies, and every provider attempt has a Relavium-owned deadline

- **Status**: Proposed
- **Date**: 2026-08-18
- **Related**:
  - [ADR-0011](0011-internal-llm-abstraction.md) — the `LLMProvider` seam this puts an obligation on. **Amended here**: the seam gains a stated stream grammar and one new `LlmErrorKind`; no vendor type crosses it and its shape is otherwise unchanged.
  - [ADR-0030](0030-llm-seam-shape-amendment-reasoning-response-format-provider-executed.md) — the last seam-shape amendment, whose form this follows.
  - [ADR-0036](0036-run-loop-substrate-event-bus-and-execution-host.md) — exactly-one-terminal for the RUN. This is its per-stream analogue, and the parallel is deliberate.
  - [ADR-0040](0040-node-retry-budget-above-the-chain.md) — the node-retry budget this must not feed with a call that already produced content.
  - [ADR-0080](0080-durable-effect-journal-and-the-tiered-effect-contract.md) — the precedent for "a failure past a commitment point is not retryable"; rule 7 is the same rule about content.
  - [ADR-0045](0045-async-media-job-loop-poll-checkpoint-resume-cancel.md) — the media-job poll loop, whose own deadline is separate and untouched (see §6).
  - [llm-provider-seam.md](../reference/shared-core/llm-provider-seam.md) — the one canonical home for the seam contract, where the grammar's normative text lands.
  - [security-review.md](../standards/security-review.md) — the outbound-request rule that forbids letting a vendor default become our liveness semantics.
- **Addresses**: `CR-14` and `CR-21` of [phase 2.6.5](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md). A Proposed ADR does not close a work item; on acceptance this becomes **Closes/Decides**, and ADR-0011 gains a dated amendment note.

## Context

Two gaps that share one boundary.

**The stream has no stated grammar, so nothing verifies one.** `StreamChunkSchema` types individual chunks
and says nothing about their ORDER: `stop` and `error` are both terminal arms, and the schema is equally happy
with two of them, neither of them, or content after one. `FallbackChain.#runEntryStream` iterates the
provider's chunks, records `usage` if it happens to see a `stop`, and on a clean end-of-iteration falls
through to `usage === undefined ⇒ #emitSuccess`. A stream that simply stops is therefore a successful attempt
whose partial text becomes a completed assistant answer.

The phase document's original framing of this was wrong in a way worth recording, because it moves the fix.
It claimed the adapters do not detect a truncated stream. They do: `anthropic.ts` tracks `sawStop` and emits
a `transport` error on a no-terminal EOF, and `openai.ts` and `gemini.ts` do the same with `sawTerminal`. So a
real transport cut against a first-party provider is already classified today.

The gap is one layer up, and in two places:

1. **`FallbackChain` has no trust boundary.** It accepts any `LLMProvider`. The three audited adapters are not
   the only implementations: `cassetteProvider` and the test doubles are providers, and Phase 2's
   `ManagedGatewayProvider` will be one. A rule enforced only inside implementations we happen to own is not a
   seam obligation, it is a coincidence.
2. **The chain's success path never asks whether a terminal was seen.** `usage === undefined` means "nothing
   to fold", and it is treated as "the attempt succeeded".

**No attempt has a deadline we own.** The chain awaits `generate`/`stream` with the caller's signal and
nothing else. `list-models` and key validation both bound themselves; a real turn does not. Absent a node or
run timeout, the vendor SDK's default becomes the product's liveness semantics — which
[security-review.md](../standards/security-review.md) forbids for an outbound request, and which is not a
semantics we chose or can state.

The two land together because they share rule 7's question — *had this attempt already produced content?* —
and answering it in two places would let the answers drift.

## Decision

**We will state the stream grammar as a seam obligation, verify it in `FallbackChain` where the seam is
crossed, and give every provider attempt a Relavium-owned deadline built from the timer the chain already
injects.**

### 1. The grammar

Normative for every `LLMProvider.stream` implementation. Its canonical home is
[llm-provider-seam.md](../reference/shared-core/llm-provider-seam.md); this ADR decides it and does not
duplicate its final wording.

1. **Exactly one terminal per stream:** `stop` **xor** `error`.
2. **The terminal is the last chunk.**
3. **No content or `*_delta` chunk after the terminal.**
4. **Two `stop`, `stop` + `error`, or two `error` are violations** — a restatement of 1 and 2 from the
   caller's side, kept separate because it is the shape a broken adapter actually produces.
5. **A clean EOF with no terminal is an error, never a success.**
6. **An empty stream — EOF with no chunks at all — is an error.**
7. **A pre-content failure may fail over; a content-committed failure must not fail over or be retried.**
   It is surfaced.

Rule 7 is the one that is not about well-formedness. It is
[ADR-0080](0080-durable-effect-journal-and-the-tiered-effect-contract.md)'s rule about effects, applied to
tokens: past the first content chunk the user has been shown output and the provider has billed for it, so a
second attempt is a second answer and a second charge.

### 2. `FallbackChain` verifies; the adapters keep their checks as defence in depth

The chain wraps every provider iterator in a verifier that tracks whether a terminal has been seen, whether
content has been committed, and how many chunks have arrived. It is the **only** enforcement point that
matters, because it is the only one that sits on the seam rather than inside one implementation of it.

The adapters' existing `sawStop`/`sawTerminal` checks are deliberately **kept**. They now produce a
better-attributed error — the adapter knows it was reading an SSE stream and can say so — and they mean a
first-party truncation is classified before it reaches the verifier. Two layers detecting the same fault is
not duplication here: one is a contract check on an untrusted input, the other is a diagnostic on a trusted
one.

Considered and rejected: enforcing in the adapters only (the status quo — leaves every foreign provider
unchecked, which is gap 1); enforcing in `packages/core`'s turn loop (too late — the chain has already
reported a successful attempt and folded usage, and the turn loop cannot see chunk order across a failover);
and tightening `StreamChunkSchema` (a per-chunk schema cannot express an ordering rule).

### 3. A grammar violation gets its own `LlmErrorKind`: `protocol`

Rules 1–4 and 6 produce `kind: 'protocol'`. Rule 5 — a clean EOF mid-stream — stays `kind: 'transport'`,
because that is what it is and what the adapters already emit for it: the bytes stopped arriving.

`protocol` is **not** in `RETRYABLE_KINDS`, and that is the point of adding it rather than reusing an existing
kind. Two different consumers read a failure and must reach opposite conclusions:

- **The node-retry budget** ([ADR-0040](0040-node-retry-budget-above-the-chain.md)) must NOT re-dispatch. A
  provider that cannot keep the grammar will not keep it on the second call either; retrying burns the budget
  and reports the wrong cause.
- **The chain's failover** SHOULD advance to the next entry when the violation was pre-content, because a
  different provider may be well-behaved and the user has been shown nothing yet.

Today those two are one decision, both derived from `isRetryable(kind)`. This ADR **separates them**: the
chain's failover verdict becomes a function of the kind *and* the commitment state, rather than of
`isRetryable` alone. That separation is the substantive change; the new kind is how it is expressed.

Considered and rejected: reusing `transport` for everything (it is retryable, so a malformed provider would be
re-dispatched by the node layer — the exact wrong answer); reusing `unknown` (it maps to the `internal`
`ErrorCode`, which tells the user our engine broke when in fact their provider did); and a new `ErrorCode` on
top of the new kind (rejected — see §4).

### 4. `protocol` maps to the existing `provider_unavailable` `ErrorCode`

No new `ErrorCode`. From a surface's standpoint a provider that cannot keep the stream grammar is not usable
for this request, and the remedy is the one `provider_unavailable` already names: try another model, or take
it up with whoever runs that endpoint. Widening a closed taxonomy that every surface switches on, for a
distinction no surface would act on differently, buys nothing and costs every one of them a case.

The distinction that IS load-bearing — do not re-dispatch this — is carried by `retryable: false`, which is
where the engine actually reads it.

### 5. Every attempt gets a deadline, merged with the caller's signal

A per-attempt timeout, injected rather than ambient, because the seam is platform-free: the chain already
takes `sleep(ms, signal)` and `now()` from its host for exactly this reason, and gains a controller factory
alongside them. The attempt runs under a signal that aborts when EITHER the caller's signal fires or the
deadline elapses.

- A deadline abort is `kind: 'timeout'` (already retryable, already mapped).
- A caller abort stays `kind: 'cancelled'` and is never reported as a timeout — the discriminator is which
  side fired, not which error surfaced, and conflating them would tell a user their cancel was a fault.
- **Rule 7 governs both:** a pre-content timeout may fail over; a content-committed one is surfaced.
- The timer is cleared on every exit path, including the success path. A leaked timer holds the process
  awake, which on a CLI is a hang the user cannot explain.

The default is a value, not a policy: it is stated in
[llm-provider-seam.md](../reference/shared-core/llm-provider-seam.md) and configurable by the host, because a
reasoning model's first token can legitimately be minutes away and a fixed engine constant would either
strangle it or be useless for everything else.

### 6. What is NOT decided here

- **`CR-20`'s tool timeout and `CR-22`'s absolute resume deadlines are separate timers** and stay separate.
  This one bounds a single provider attempt; those bound a tool dispatch and a whole run. Merging them would
  make one knob mean three things.
- **[ADR-0045](0045-async-media-job-loop-poll-checkpoint-resume-cancel.md)'s media-job poll loop is
  untouched.** Its liveness is a poll interval against a provider-side job, not an in-flight stream.
- **`CR-23`'s never-settling node executor is out of scope** — that is a run-level liveness property with an
  open decision of its own.

### 7. Acceptance

One test per numbered rule in §1, each driven through a fake provider that violates exactly that rule — the
fake is the point, since the whole item is about not trusting the implementation. Plus:

1. A stream ending with no terminal produces a classified error, and NO successful attempt record.
2. An empty stream produces a classified error.
3. A content-committed truncation does not fail over, and does not produce a second attempt record.
4. A pre-content violation DOES fail over to the next entry — the negative control, without which every rule
   above is satisfied by a chain that fails everything.
5. `protocol` is not in `RETRYABLE_KINDS`, and a `protocol` failure does not cause a node re-dispatch.
6. A deadline abort classifies `timeout`; a caller abort in the same window classifies `cancelled`.
7. Timer cleanup is proven with a fake clock, on the success path as well as the failure paths.
8. **The existing test that pins a no-terminal stream as success is rewritten, not deleted, and carries a note
   recording the reasoning it replaces** — the way `checkpointer.test.ts` was handled in Wave 1.

## Consequences

### Positive

- The seam's obligation is stated and verified where it is crossed, so a foreign provider — a cassette, a
  test double, Phase 2's managed gateway — is held to the same rule as an adapter we wrote.
- A truncated answer stops being reported as a complete one. That is the user-visible defect.
- Failover and node-retry stop being one decision derived from one boolean, which is what let a malformed
  provider consume a retry budget.
- No vendor type crosses the seam, no new dependency, and no new `ErrorCode` for surfaces to handle.

### Negative

- **`LlmErrorKind` gains an arm, which is a seam-shape change.** Every exhaustive switch on it must handle
  `protocol`; the compiler finds them, and there are few. Lived with because the alternative is a kind whose
  retryability is wrong for one of its two readers.
- **The verifier sits on the hot path** — one branch per chunk, on a token stream. Measured rather than
  assumed as part of the acceptance work; a per-chunk boolean check is not where a streaming turn spends its
  time, but the claim should be evidence rather than intuition.
- **A deadline can cut a legitimately slow attempt.** That is why the default is host-configurable and
  stated in the seam doc rather than compiled in. A too-tight default would turn a working reasoning model
  into an unexplained failure, which is a worse outcome than the unbounded wait it replaces.
- **Two layers now detect a truncated first-party stream**, so a future change to one can leave the other
  reporting a differently-worded error for the same fault. Accepted deliberately: the redundancy is the
  trust boundary doing its job, and the adapters' messages are strictly better attributed.
