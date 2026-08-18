# ADR-0080: A durable effect journal, and a tiered effect contract that says what it can keep (amends ADR-0027, ADR-0037, ADR-0040, ADR-0041)

- **Status**: Accepted
- **Date**: 2026-08-17
- **Related**:
  - [ADR-0041](0041-external-action-governance-seam.md) — the optional `ActionGuard`. **Amended here**: a baseline identity + journal floor moves *below* that seam, and its unconditional "a resumed run will never double-post" becomes conditional on the tier.
  - [ADR-0037](0037-engine-tool-execution-boundary.md) — the `ToolHost` boundary. **Amended here**: a side-effecting host throw stops being node-retryable.
  - [ADR-0040](0040-node-retry-budget-above-the-chain.md) — **Amended here**: the idempotency key it describes does not exist and never did.
  - [ADR-0027](0027-expression-sandbox.md) — **Amended here**: the same key string is renamed; the determinism reasoning is untouched.
  - [ADR-0079](0079-cross-process-run-ownership-lease-and-fencing-token.md) — the precondition. An effect journal is meaningless while two processes can own one run, and §1 of that ADR says so.
  - [ADR-0078](0078-ordered-durable-append-and-the-terminal-outbox.md) — the `DurableWriteContext` this extends once more, and the totality rule that keeps the journal *off* `#emitDurable`.
  - [ADR-0024](0024-agent-first-entry-point-agentsession.md) — why a session has no `runId` to fabricate.
  - [ADR-0077](0077-realized-cost-ledger-uses-the-conservative-commitment-barrier.md) — **Amended here**: its tool-dispatch barrier is a per-TURN money barrier, not the effect journal's per-EFFECT one, and its §"Why the tool-dispatch barrier matters beyond this ADR" predicted the wrong placement for this item.
  - [ADR-0076](0076-durable-per-attempt-realized-cost-ledger.md) — the `TurnMoneyPort` shape this extends, and its "a second key is a second thing that can disagree" reasoning.
  - [ADR-0049](0049-cli-machine-output-contract.md) — the exit-code taxonomy the `needs_attention` disposition extends.
  - [architectural-principles.md §11](../standards/architectural-principles.md) — the idempotency guarantee this rewrites.
  - [effect-journal.md](../reference/shared-core/effect-journal.md) — the one canonical home for the contract, the identities, the state machine and the table.
- **Decides**: `CR-12` and `CR-95`'s short-term fix of [phase 2.6.5](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md); implementation staged behind it.

## Context

A tool effect can complete at its target, the process can die before the result persists, and resume re-runs the
node. The target sees the effect twice — a duplicate ticket, deploy, payment, message or commit. `ADR-0079` closed
the precondition (two processes can no longer both own a run); this closes the effect itself.

Three facts about the tree shape the answer, and all three were verified rather than assumed.

**The dispatch surface is one chokepoint with two producers, not three peers.** `registry.ts` is the only place
where the validated args, the assembled effective args and the resolved policy target exist at once. The two
producers are the model-driven turn and the `!`-shell user command. Instrument one site; thread two contexts.

**No identity is reachable there today.** `ToolDispatchContext` carries `nodeId` and nothing else that identifies
an occurrence — no `runId`, no `sessionId`, no attempt of either family. On the session path `nodeId` is the agent
ref, constant for the session's whole life, so it is not even a per-effect discriminator.

**Neither attempt counter can key anything.** The counter that reaches the dispatch is the within-chain provider
failover count, not the node-retry count. And the node-retry count — which does exist, ADR-0040 shipped it —
restarts at 1 both on a crash-resume and on a budget approval, so `(runId, nodeId, nodeAttempt)` repeats.

The phase document proposed one key, `runId + nodeId + nodeAttempt + toolCallId + effectiveArgsHash`. It cannot
work: every retry and every resume mints a new value, so the journal can never deduplicate and "safe retry under
the same key" is unimplementable. It also contradicts two already-canonical sentences in
[action-guard-seam.md](../reference/shared-core/action-guard-seam.md) that name the retry attempt as replay
correlation and explicitly *not* the idempotency key.

## Decision

**Every effectful tool dispatch is bracketed by a durable prepare/settle pair in a new authoritative
`effect_journal` table, addressed by a discriminated `EffectCorrelation` that neither entry point can fabricate
for the other. The engine's guarantee is tiered and honest: tier 1 and tier 2 are specified but claimed by no
shipping tool, and everything that ships today is tier 3 — at-most-once dispatch *attempt*, never auto-retried.**

### 1. Two identities, because they answer two different questions

- **`EffectIdentity`** = `EffectCorrelation` (attempt dropped) + `EffectSlot` + `toolId`. It carries the table's
  UNIQUE constraint and answers *"is this row about the same effect occurrence as that one?"* — which is what
  makes two processes preparing the same effect collide rather than both dispatch. It is **not** claimed to be
  reproducible after a model replay; §2 says exactly what it is and is not.
- **`EffectAttemptId`** — the audit row: the node-retry attempt, the provider attempt, the tool-call id, and the
  owner/generation that produced it. It answers *"which occurrence was this?"* and is never used for dedup.

Both hang off **`EffectCorrelation`**, a discriminated union — `{ kind: 'run', runId, nodeId, attempt }` or
`{ kind: 'session', sessionId, turn }` — mirroring the invariant the run-event envelope already enforces at
runtime, where exactly one of `runId`/`sessionId` must be present. A session never fabricates a `runId`; a run
never borrows a session's. That is the property ADR-0024 protects and the reason the union exists rather than an
optional field.

Considered instead: the phase doc's single key (rejected — see Context); recomputing the identity on replay to
match the journal (rejected — the model regenerates its args, and a provider failover regenerates them on a
*different* model, so the recomputed value is not the stored one); and `RunFence.generation` as the occurrence
epoch (rejected — a same-owner renewal bumps it and a gate park re-acquires, so it would suppress legitimate
second effects at every park boundary).

### 2. There is no universal replay-stable identity, and the guarantee does not depend on one

Identity-level dedup works only where the args are **byte-stable across a replay**. Exactly one dispatch site in
the tree has that property: the `!`-shell command, whose args come from the user's typed line. Everywhere else the
args are model-generated, so a replay produces a different digest for the same logical intent — and a provider
failover regenerates them on a *different model*.

So this ADR does **not** claim a universal replay-stable logical identity. Claiming one is what made the phase
document's single key unimplementable, and the same trap is available here. Five separate concepts are named
instead, because collapsing any two of them is where the design goes wrong:

| concept | what it identifies | replay-stable? |
|---|---|---|
| **`EffectCorrelation`** | the run/node or session/turn the effect belongs to | yes, minus the attempt |
| **`EffectSlot`** | *which* effect within that correlation (an ordinal over the turn's tool calls) | only within one model response |
| **`EffectAttemptId`** | this one occurrence, for audit | no, by design |
| **`effectiveArgsDigest`** | a collision guard and audit fingerprint | no, except at the `!`-shell |
| **target idempotency key** | what a tier-1 target dedups on | supplied to the target, never derived from the model |

**The primary guarantee is a resume gate at node granularity, not a digest match.** Its lookup key is the
correlation **with the attempt dropped** — because the node-retry attempt resets to 1 on a crash-resume and on a
budget approval (Context), so an attempt-scoped lookup would miss the very row it exists to find.

### 2b. The gate examines every prior effect record, not only the unresolved ones

The obvious form of this gate — "an unresolved row blocks the re-run" — leaves the main crash window open, and
this ADR closes it explicitly because an earlier draft did not:

> prepare persists → the effect succeeds at the target → the row settles `committed` → the process dies before
> the tool result or `node:completed` persists → resume sees a *resolved* row, does not block → the model
> regenerates the call → **the effect fires a second time.**

A `committed` row is therefore not a green light. On resume, for a correlation with **no terminal node record**,
every prior non-benign effect record is examined and resolved by tier:

| record state | tier | resume behaviour |
|---|---|---|
| `committed` **with a replayable stored result** | any | re-deliver the stored result; do **not** re-execute |
| `committed` **without** one | 1 | safe retry under the same target idempotency key |
| `committed` **without** one | 2 | reconcile from a receipt lookup, then decide |
| `committed` **without** one | 3 | `needs_attention` — never re-executed |
| `prepared` / `dispatched` / `ambiguous` | 1 or 2 | reconcile, then decide |
| `prepared` / `dispatched` / `ambiguous` | 3 | `needs_attention` |

The rule that makes this safe to state: **if the journal did not retain enough to re-deliver the result, a
`committed` row blocks the node exactly as an unresolved one does.** Storing the result is what buys the
re-delivery, and where it is not stored the answer is refusal, never a silent re-run.

### 3. Three tiers, and today every shipping effect is tier 3

1. **Target accepts an idempotency key** → safe retry under the same key. Effectively exactly-once, and the only
   tier that may say so.
2. **Target's outcome is queryable** → reconcile from a receipt lookup before deciding. Exactly-once after
   reconciliation.
3. **Opaque, non-idempotent** → `dispatched → ambiguous → needs_attention`. **Never auto-retried.**

Tiers 1 and 2 are **reserved and fully specified, and claimed by nothing**. No shipping capability offers a
receipt lookup, and no tool injects an idempotency key. Saying this plainly is the point: the ADR's headline is a
*narrowing* of the product claim, not a new capability, and a reserved tier that no code occupies is honest where
a tier assigned by aspiration is not.

`http_request` is the nearest promotion — the egress header filter is a denylist, so an `Idempotency-Key` already
passes the wire — but the missing half is *who asserts that a given target honours it*, and that assertion is a
schema change the engine cannot verify. Shipping the first promotion beside the floor would make the first
promotion bug and the first journal bug arrive together and be indistinguishable. Deferred with its trigger: the
first user with a real webhook or payment target.

### 4. MCP is tier 3, permanently, and the reason is not a missing feature

Discovered MCP tools carry no usable annotations, and any that existed would be attacker-controlled bytes from the
very server the hostile-MCP class defends against. An annotation may never *raise* trust. Tier 3 is therefore not
a temporary state pending better metadata — it is the correct terminal answer for a tool whose semantics are
declared by an untrusted party.

An author-declared per-tool promotion (author trust, not server trust — the shape `allowedCommands` already uses)
is a coherent future escape hatch and is recorded as a follow-up rather than shipped here, for the reason in §3.

### 5. A benign-under-duplication property, declared rather than excepted

`notify` is a side effect by the letter of the contract and absurd under it: a duplicate desktop toast is not an
incident, and halting a run for one would discredit the whole mechanism. The answer is a declared
`duplicationBenign` property on the tool definition, with `notify` as its only member today — not a one-line
exception in the predicate. A one-line exception is the shape that decays: the next tool with the same property
earns a second exception somewhere else. A declared property makes the predicate a lookup and forces the next
author to state the claim rather than inherit it.

### 6. An unresolved tier-3 row stops the run; a session discloses instead of blocking

On resume, an unresolved row for this correlation means the node is **not re-run**. The row becomes
`needs_attention` and the run terminates with a distinct disposition. A human decides.

The session path departs deliberately, and this is the one place this ADR reads the phase document's
`needs_attention` less than literally. A chat session has no operator queue and no run to pause; blocking the next
turn would be an interruption where the honest answer is information. So `chat-resume` **reads its unresolved rows
and discloses them once**, and does not block. That keeps tier 3's actual guarantee — never auto-retried, because
nothing re-dispatches them — while putting the fact in front of the one person who can act on it.

Considered instead: continuing with a durable "possible duplicate" warning (rejected — that is today's behaviour
with better logging, and it cannot satisfy the acceptance criterion); and an author-declared per-node
`on_ambiguous: replay` escape (rejected for now — it is a promotion mechanism, and promotions ship after the floor
is proven; trigger: the first user who reports a run they would rather have replayed).

### 7. The seam: a required port on the dispatch context, not a fourth store method

The journal port is injected on `ToolDispatchContext` with the correlation **already closed over**, mirroring
`TurnMoneyPort` — the engine stamps the identity because only the engine knows it, exactly as only the run loop
can supply the ledger's `runId`. This *extends* that precedent rather than reusing it: the money port is run-path
only, and this one must be supplied by both entry points.

**Two barriers, at different granularities — and ADR-0077 predicted this one's placement wrongly.** That ADR
put its money barrier at `agent-turn.ts`'s single `await dispatchToolCalls(...)`, deliberately *"rather than
inside `ToolRegistry.dispatch`"*, and then said the effect journal's state machine *"has to be written at exactly
this point in exactly this path."* It does not. A model turn dispatches a **loop** of tool calls, so a checkpoint
that runs once per turn cannot record which individual effect was prepared, dispatched or settled. The money
barrier is per-TURN and stays exactly where ADR-0077 put it, for exactly its reasons; the journal is per-EFFECT
and must sit at the one place a single effect is visible. ADR-0077's own stated worry — that per-call placement
"would have to be re-proven for every dispatch path" — is answered by the fact established in Context: there is
one sink, not a path per producer.

Considered instead: a fourth `RunStore` method (rejected — ADR-0079's own precedent made the lease a separate port
for the same reason, and `RunStore` is deliberately three methods); a required port on `ExecutionHost` (rejected,
and this is the closest precedent so it is argued explicitly — `ExecutionHost` is the *run's* host and does not
reach `AgentSession` at all, which is the one property the session decision requires); and an optional port
(rejected on ADR-0078 §4's exact reasoning — optional would mean a host that forgets it silently has no
guarantee, a fail-open default inside a fail-closed item).

The journal must **not** ride `#emitDurable`. That path is deliberately total for non-terminal events, so a UNIQUE
violation — which is the *successful* detection of a duplicate — would be swallowed and reported as a run failure.
It also cannot be a `RunEvent`: `run_events.run_id` is `NOT NULL` with a foreign key, and the store throws on a
session event.

### 8. Where the commit write sits, and why that placement is load-bearing

The dispatch ladder's `try` block ends in a classification that maps a throw to `tool_failed`, which is
**node-retryable**. A commit write placed inside it would mean a journal failure triggers the very duplicate the
journal exists to prevent. The settle write therefore sits outside that ladder, and this ADR amends ADR-0037 to
say that a side-effecting host throw is no longer node-retryable.

### 9. Composition, retention, and the durability scope

The journal write repeats ADR-0079's fence check inside its own `BEGIN IMMEDIATE`, using the run-history store's
check as the template, so a fenced process cannot journal an effect either. The row carries **no foreign key** to
its run: an `ambiguous` row is precisely the record an operator needs *after* the run is purged. Committed rows
are swept; **unresolved rows are never swept**, following the media-object grace precedent — without that, the
journal is the fastest-growing table in `history.db`.

The guarantee is **process-crash durability, not power-loss**: the database runs `synchronous = NORMAL`, and
CR-12's own failure statement is process death. Claiming power-loss durability by silence is the class of
overclaim this phase exists to remove.

### 10. CR-95: a mid-tool-loop budget pause is forbidden, and fails closed

A budget pause mid-tool-loop resets the node to pending and re-dispatches it from the start, repeating earlier
provider *and tool* calls — a duplicate-effect amplifier that this ADR's journal would otherwise have to absorb.
The short-term fix is non-deferrable and is decided here: **a budget pause is refused while a tool loop is in
flight, and the run fails closed instead.**

Precisely: a tool loop is "in flight" from the moment the first tool call of a model response is dispatched
until the last one has settled. A budget verdict that would pause inside that window does not pause — it fails
the node terminally with the budget error, **without replaying any earlier effect and without a further
provider egress**. The alternative shapes both lose: completing the loop past the cap spends money the user
capped, and pausing-then-resuming is the replay this item exists to remove. Failing closed is the only option
that neither overspends nor duplicates, and it is deliberately the more disruptive of the honest choices.

This fix does **not** depend on the journal and should land first: it removes the amplifier that would otherwise
generate the duplicates the journal has to absorb.

The long-term continuation checkpoint (provider messages, tool call/result pairs, round index) is a new
durable artifact of a different shape and is deferred with its trigger: a user who must resume a partially
completed tool loop rather than fail it.

## Consequences

### Positive

- The duplicate-free claim becomes true where it is claimed, and where it cannot be true the documents say so.
- The crash window closes at node granularity for every tier, without depending on args being reproducible — the
  property that makes a hash-only design fail silently.
- One chokepoint carries the guarantee, so a future dispatch producer inherits it rather than having to remember it.
- `CR-95`'s amplifier is closed in the same decision that would otherwise have to tolerate it.

### Negative

- **Two durable writes per effectful dispatch where there were none.** Both are small single-row writes, but they
  are on the hot path and the prepare must land *before* the effect, so it cannot be batched away.
- **Every shipping effect is tier 3**, so a crash during one halts the run and requires a human. That is strictly
  more interrupting than today — where the same crash silently duplicates — and it is the trade this ADR makes
  deliberately.
- **A release note that narrows a claim.** No new capability ships; what ships is an honest floor and the removal
  of a promise the code never kept.
- **The session path ships without an ownership guarantee.** ADR-0079 is runs-only, so two `chat-resume` processes
  on one session can still both dispatch; the journal's UNIQUE prepare detects it but cannot distinguish a live
  prepare from a dead one. Recorded as a limitation with its trigger: the first supported concurrent-resume flow.
- **A credential rotation mints a fresh identity**, so an effect whose args include a rotated reference degrades to
  tier-3 behaviour for that occurrence. Named rather than hidden.
- **Five ADRs are amended.** None is reversed, so all four are dated in-place amendments per the documentation
  standard, and the sentences being corrected are quoted rather than silently rewritten.
