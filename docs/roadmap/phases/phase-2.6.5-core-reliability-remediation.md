# Phase 2.6.5 — Core reliability remediation (interlude)

- **Status**: planned
- **Opened**: 2026-08-09 · **Plan corrected**: 2026-08-10
- **Predecessor**: Wave 1 of the 2.5.5 remediation (complete — PR #81), then the `#W15-1` realized-cost
  ledger implementation (**complete 2026-08-10**, ADR-0076 + ADR-0077 — see [Prerequisite](#prerequisite))
- **Successor**: Wave 2 of the 2.5.5 remediation, **reduced** — this phase absorbs Wave 2's hostile-MCP
  threat class (see [Phase boundary](#phase-boundary)); Wave 2 keeps the filesystem jail, the secrets
  layer, persistence-security and the 2.5.5 certification
- **Kind**: interlude, like [phase 2.5.5](phase-2.5.5-hardening-and-remediation.md) — no new product surface,
  only the invariants an existing surface already claims

## Why this phase exists

Three independent core reviews of the engine were run against the tree as it stood immediately after Wave 1.
They converged — independently, without seeing each other — on the **same seven blocking gaps**. That
convergence is the reason this phase exists: three separate reviews landing on the same seven points is not a
matter of opinion.

The verdict all three reached is worth stating, because it shapes every item below:

> The architecture is right. Nothing here calls for a rewrite. The gaps are in the **last ten percent of
> reliable execution** — durable ownership, effect identity, trust provenance, stream grammar, admission and
> ordering — and the existing seams are good enough to carry the fixes.

The second reason is sharper. Several of our own canonical documents currently promise behaviour the code does
not deliver: *crash-safe resumable workflow*, *duplicate-free side effect*, *bounded stream*, *first completed
branch wins*, *schema-validated input/output*, *full session-to-workflow graduation*. A claim the code does not
keep is worse than a missing feature, because it is the claim a user plans around.

### Provenance of the findings

Recorded so the severities below can be audited rather than trusted:

| Source | Ran against | What it was |
|--------|-------------|-------------|
| Review A | post-Wave-1 tree, 2026-08-08/09 | Full-engine reliability read, findings with file/line evidence |
| Review B | post-Wave-1 tree, 2026-08-09 | Independent full-engine read, no sight of A |
| Review C | post-Wave-1 tree, 2026-08-09 | Independent read scoped to durability, MCP and cost |
| Plan review | this document + tree, 2026-08-10 | Adversarial read of the plan itself; produced `CR-17`, `CR-63`, the phase-boundary correction and the non-deferrable exit rule |

"Consensus" severity below means at least two of A/B/C rated it independently. Every evidence line was
re-verified against the working tree before it was written here; where a review's claim did not survive that
check it was dropped rather than restated.

## What must NOT change

Recorded so a remediation pass does not quietly undo a decision that is correct:

- The pure-TypeScript engine with zero platform imports.
- The `LLMProvider` seam and the rule that no vendor SDK type crosses it.
- Deny-by-default tool policy, the approval chain, and the QuickJS sandbox.
- Strict authored YAML with Zod at every boundary.
- Event-sourced checkpoint/resume as the recovery model.
- Keys in the OS keychain only.

## Phase boundary

This phase runs **between Wave 1 and Wave 2**, and it closes before Wave 2 opens. That is only true if the
work Wave 2 would otherwise have blocked on lives here, so:

- **The hostile-MCP threat class moves into this phase.** `CR-16` (consent before a stdio spawn) plus `W4`
  (`CR-40`–`CR-42`) are the same code area and the same security-review sitting as Wave 2's MCP queue. Wave 2's
  queue item 2 is **executed as this phase's `W4`**; its 2.5.5 finding ids keep their home in
  [phase-2.5.5](phase-2.5.5-hardening-and-remediation.md) and are certified from there.
- **Wave 2 keeps** the project-layer MCP name collision and tool-definition poisoning (a trust/config concern,
  not the transport boundary), the unified filesystem jail, the secrets layer, persistence-security, and the
  certification of 2.5.5 exit criteria 1–3.
- **`current.md` is canonical for execution order** and carries the corrected graph. This section states the
  scope line; the ordering statement lives there.

The alternative — leaving `CR-16`/`W4` in Wave 2 and declaring this phase closed *during* Wave 2 — was
rejected: a phase whose exit criteria cannot be evaluated until a later phase is half-done is not a gate.

## Prerequisite

**`#W15-1` — the durable per-attempt realized-cost ledger — lands before `W1` starts. ✅ SATISFIED
(2026-08-10).** All five steps are merged, each with an Opus and a Sonnet round folded, and the decision
acquired a correction on the way:
[ADR-0077](../../decisions/0077-realized-cost-ledger-uses-the-conservative-commitment-barrier.md) amends
ADR-0076 §1, whose stated mechanism (an inline `await` at the attempt boundary) is unimplementable — the
seam's attempt observer is synchronous. The ledger uses ADR-0074 §2's chain-and-join shape instead, with a
third barrier before tool dispatch that `CR-12`'s effect journal is expected to extend rather than re-thread.

Two things `W1` inherits from it. **`CR-10` gains a concrete adversary:** the ledger's derived `run_costs` row
had to be written as a telescoping delta rather than the event's raw charge, precisely because
`#emitDurable` starts every persist immediately and serializes only delivery — out-of-order commit is real
today, not a cloud-store hypothetical. And **`CR-11`/`CR-92` gain a known-open seam:** the ledger's observe
half reads the run's `#failure` because `#emitDurable` discards the store error, which under-triggers during
a cancel and on an already-failing run. A per-event durable outcome would close it, and that is a change to
the same choke point `CR-10` restructures.

The original reasoning for the ordering, kept because it is what made it right:

[ADR-0076](../../decisions/0076-durable-per-attempt-realized-cost-ledger.md) is Accepted and its implementation
was staged in five steps in [current.md](../current.md). Those five steps touch
`packages/shared/src/run-event.ts`, `packages/core/src/engine/engine.ts`,
`packages/core/src/engine/checkpoint.ts` and `packages/db/src/run-history-store.ts` — the same four files
`CR-10` and `CR-12` restructure. Landing it after the durability spine means writing its barrier against a
persistence path that is about to change, then rebasing it onto the moved floor. Landing it first means its
awaited emit inherits `CR-10`'s ordered tail for free.

There is a second reason, and it is the one this project keeps re-learning: an accepted ADR with no
implementation is a decision that reads as shipped. Wave 1's completion claim was wrong twice for exactly that
shape.

## Working discipline for this phase

This phase inherits the discipline Wave 1 arrived at the hard way. It is not optional ceremony; every clause
below exists because its absence produced a real defect during Wave 1.

1. **A decision gets an ADR before it gets code.** All eight `W1` items change what a contract *means* — what
   "exactly once" means, what `system` authority means, what "the stream ended" means, what a resume is allowed
   to assume. Wave 1 proved that treating a decision as a task item produces false completion claims. Write the
   ADR, get it accepted, then implement.
2. **Break-verify every regression test, and verify the mutation actually applied.** Wave 1 produced three
   tests that passed with the production code mutated. Each was found only by checking that the mutation had
   landed (e.g. `grep -c` the mutated symbol → 0) before trusting a red.
3. **Never ship a hollow test.** If the honest test cannot be built, leave the gap open, name it, and name the
   mutation that would close it. A test that implies coverage it does not have is worse than none.
4. **Record rather than assert.** Any claim that cannot be demonstrated goes in as a limitation, not as a
   property.
5. **Fix the canonical doc in the same change.** One canonical home per artifact; a fix that leaves the spec
   describing the old behaviour has not landed. Where a *standard* states a guarantee the code does not keep,
   the correction lands with the ADR, not with the last line of implementation.
6. **Never assert on model behaviour.** A prompt-security test proves a *structural* property — which role a
   byte can reach, which type the builder accepts — never "the model did not comply". A test that depends on a
   model's judgement is a hollow test under clause 3.
7. **Security review is booked by threat class, not per PR.** Four sittings cover this phase:
   **prompt/trust provenance** (`CR-13`), **hostile MCP** (`CR-16`, `CR-40`–`CR-42`), **media bytes**
   (`CR-50`, `CR-53`, `CR-54`), **provider/config trust** (`CR-80`). Each sitting produces a recorded
   [security-review](../../standards/security-review.md) checklist entry with a direct adversarial test — not a
   reviewer's assurance.
8. **The gate is `pnpm run ci` AND `pnpm coverage`, both exit 0, checked by exit code.** `pnpm run ci` does not
   include coverage; `coverage` is a separate required check. CI's coverage job enforces the floor for
   `@relavium/llm` and `@relavium/mcp` only — `packages/core` is measured but not blocking, a dated carve-out
   whose promotion trigger is Wave 3. This phase edits `core` heavily, so the local `pnpm coverage` (which
   enforces all three) is the honest gate here.

## How the work is grouped

`CR-##` ids below are this phase's own; they are **stable** and never renumbered. The thematic groups `W0`…`W9`
are the reference layout. The **execution order is separate from the grouping** and is stated once, below.

Severity is the consensus of the three reviews, except where an item is marked *(plan review)*.

### Execution order

The groups are not the schedule. Test honesty comes first because it is the oracle everything after it is
proven with, and the durability spine is a chain.

```mermaid
flowchart TD
    PRE["Prerequisite<br/>#W15-1 realized-cost ledger"]
    ORACLE["Oracle first<br/>CR-90 · CR-91"]
    HALVES["W0 — finish the halves<br/>CR-01 · CR-02 · CR-03"]
    SPINE["Durability spine<br/>CR-10 → CR-11 → CR-92 → CR-12"]
    IND["Independent P0 lines<br/>CR-13 · CR-14+CR-21 · CR-15+CR-17"]
    MCP["Hostile MCP<br/>CR-16 · CR-40 · CR-41 · CR-42"]
    CLAIM["False-claim blockers<br/>CR-50 · CR-55 · CR-73 · CR-80 · CR-94 · CR-95"]
    REST["Remaining P1 themes<br/>W2 · W3 · W5 · W6 · W7 · W8 · W9 residual"]
    EXIT["Exit certification"]
    PRE --> ORACLE --> HALVES --> SPINE --> CLAIM --> REST --> EXIT
    HALVES --> IND --> REST
    HALVES --> MCP --> REST
```

`CR-92` sits inside the spine, not in `W9`: an API that returns `completed` while durable history says `failed`
is a runtime correctness defect, not a harness concern. `CR-90`/`CR-91` come before the spine because a crash
and durable-truth oracle is what proves `CR-10`/`CR-11`/`CR-12`/`CR-92` landed — building it last would mean
asserting the spine with the harness the reviews already found insufficient.

- **W0 — finish the halves.** Cheap, already half-done. Leaving them half-done is the exact failure this phase
  is correcting.
- **W1 — the P0 blockers.** ADR-first. Seven are the convergent set; `CR-17` was added by the plan review.
- **W2…W9 — P1 themes.** Grouped so each theme is one reviewable PR, not sixty scattered tickets.

### Decision, ADR and gate register

Every row states whether the decision is already made. **An item whose decision column says "open" does not
start until the maintainer settles it** — deciding during implementation is the failure mode this phase exists
to correct.

| Item | Decision | ADR | Non-deferrable | Security sitting |
|------|----------|-----|----------------|------------------|
| `CR-01` | made (route through the latch) | — | yes | — |
| `CR-02` | made (counter stays; rule = *engaged*) | — | yes | — |
| `CR-03` | made (route through `stringifyJsonLine`) | — | yes | — |
| `CR-10` | made (one ordered append tail per run) | new | yes | — |
| `CR-11` | made (lease + fencing token) | new | yes | — |
| `CR-12` | made (three-tier effect contract) | new, amends [ADR-0041](../../decisions/0041-external-action-governance-seam.md) + [ADR-0037](../../decisions/0037-engine-tool-execution-boundary.md) | yes | — |
| `CR-13` | made (summary is untrusted, never `system`) | new, supersedes [ADR-0062](../../decisions/0062-context-compaction-and-cli-history-commands.md) §1 | yes | prompt/trust |
| `CR-14` | made (exactly one terminal, grammar pinned) | new | yes | — |
| `CR-15` | made (engine-side admission) | new | yes | — |
| `CR-16` | made (consent before spawn, lazy connect) | new | yes | hostile MCP |
| `CR-17` | made (persist and verify resume identity) | with `CR-15`'s | yes | — |
| `CR-20` | made (honour `timeout_ms`) | — | no | — |
| `CR-21` | made (per-attempt deadline) | with `CR-14`'s | no | — |
| `CR-22` | made (absolute deadlines) | — | no | — |
| `CR-23` | **open** — grace period length, quarantine policy | new | no | — |
| `CR-30` | made — implement [ADR-0036](../../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md)'s accepted no-drop producer-await | none (already decided) | no | — |
| `CR-31` | **open** — the cap values | — | no | — |
| `CR-32` | **open** — the bound values | — | no | — |
| `CR-33` | **open** — retention policy shape | — | no | — |
| `CR-40` | made (forward signal + deadline) | with `CR-16`'s | no | hostile MCP |
| `CR-41` | made (apply the built-in egress floor) | with `CR-16`'s | no | hostile MCP |
| `CR-42` | **open** — the ingress bounds | with `CR-16`'s | no | hostile MCP |
| `CR-50` | **open** — complete the handle path, or remove the tool | — | yes | media bytes |
| `CR-51` | made (gate on model-level capability) | — | no | — |
| `CR-52` | made (pull [ADR-0039](../../decisions/0039-same-provider-reasoning-replay.md)'s deferral forward) | ADR-0039 follow-up | no | — |
| `CR-53` | made (bounded stream to the store) | — | no | media bytes |
| `CR-54` | made (content-hashed handle at first resolution) | — | no | media bytes |
| `CR-55` | made (missing rate ⇒ unpriced) | — | yes | — |
| `CR-60` | **open** — race semantics, or rename + correct the table | — | no | — |
| `CR-61` | **open** — needs a JSON-Schema validator dependency | new (dependency ADR) | no | — |
| `CR-62` | **open** — extract dependencies, or fail loudly | — | no | — |
| `CR-63` | made (verify the docs; no runtime change) | — | no | — |
| `CR-70` | **open** — persist bounded tool pairs, or narrow the spec | — | no | — |
| `CR-71` | with `CR-70` | with `CR-70`'s | no | — |
| `CR-72` | **open** — implement, or reject at parse | — | no | — |
| `CR-73` | made (wire it, or stop advertising it) | — | yes | — |
| `CR-80` | made (fail closed) | — | yes | provider/config |
| `CR-81` | made (match the canonical request) | — | no | — |
| `CR-82` | made (missing usage is unknown) | — | no | — |
| `CR-90` | made (exclude repo-local checkouts) | — | no | — |
| `CR-91` | made (build the durable-truth oracle) | — | no | — |
| `CR-92` | made (durable outbox, distinct typed result) | with `CR-10`'s | yes | — |
| `CR-93` | made (scope per run/session/tenant; may defer the work, not the decision) | — | no | — |
| `CR-94` | made (numeric approval lease) | — | no | — |
| `CR-95` | made (short term: fail closed) | — | yes (short term) | — |

---

## W0 — Finish what is already half-done

These are partially closed. Each has a verified open half.

### CR-01 — `session:cancelled` bypasses the session durability latch · High

**Evidence.** The CLI chat persister wraps its cost and turn writes in the `persistDurably` failure latch, and
since Wave 1 the `session:compacted` and `session:trimmed` arms go through it too. The `session:cancelled` arm
still calls `deps.store.writeTurn(...)` directly (`apps/cli/src/chat/persister.ts`).

**Why it matters.** The event bus isolates listener errors from the producer, so a failing DB write lets the
cancel path report success. The durability latch never sets, so nothing gates the next provider egress.

**Fix.** Route the `session:cancelled` write through `persistDurably`, exactly as its two siblings now are.

**Acceptance.** A failing `writeTurn` on cancel sets `durabilityFailure`, and the next egress is refused.
Break-verify by removing the wrapper.

### CR-02 — A failed turn flush leaves the turn counter incremented · Medium

**Evidence.** `packages/core/src/engine/agent-session.ts` increments `#turnCount` on the success path *before*
it awaits `flushBudgetCommitments()`. Wave 1 fixed the transcript half of this (the flush now precedes the
assistant append, so the rollback's one-message `pop()` is correct again). The counter half was not examined.

**The decision, made.** The counter **stays where it is.** The rule the code already applies on both catch
paths is *count a turn against the hard cap only when a provider actually engaged* — and by the time the
success path reaches the increment, `#runTurn` has resolved, so a provider did engage. A flush rejection after
that point is a durability failure, not evidence the turn never happened. Moving the increment after the flush
would make a billed turn free.

**Fix.** Keep the increment; state the rule in a comment at the success-path site the way the two catch paths
already state it, so the next reader does not re-derive it. Pin it with a test.

**Acceptance.** A rejecting `flushBudgetCommitments` on an otherwise-successful turn still consumes a turn
against the cap. `#turnCount` is a JS private field and **must not** be given a production accessor to test —
assert through the observable turn-cap behaviour (`maxTurns: 1`, one flushing-failing turn, the next
`sendMessage` refused by the cap). Break-verify by moving the increment below the flush.

### CR-03 — Three `--json` paths still bypass the safe serializer · High

**Evidence.** Wave 1 introduced `stringifyJsonLine` (`apps/cli/src/render/sanitize.ts`), which losslessly
escapes C1 controls and Trojan-Source bidi characters, and routed the workflow renderer and the record writer
through it. Three sibling paths still use bare `JSON.stringify`:
`apps/cli/src/commands/agent-run.ts:161`, `apps/cli/src/commands/chat-export.ts:90`,
`apps/cli/src/commands/chat.ts:2392`.

**Why it matters.** Same class as the gap Wave 1 closed: `JSON.stringify` escapes `ESC` but leaves `U+009B`
(8-bit CSI) and the bidi family raw, and these streams carry model-, tool- and persisted content. This is a
propagation gap — the fix landed, the siblings did not get it.

**Fix.** Route all three through `stringifyJsonLine`. The escape is lossless, so no machine contract changes.

**Acceptance.** One shared adversarial test drives a C1 + bidi payload through all three surfaces and asserts
the raw code points do not survive while `JSON.parse` round-trips to the identical string.

---

## W1 — The P0 blockers

`CR-10 → CR-11 → CR-92 → CR-12` is a chain: an effect journal is meaningless while two processes can own the
same run, run ownership rests on the log being an ordered prefix, and a terminal that can diverge from durable
truth undermines both. `CR-13`, `CR-14` and `CR-15`+`CR-17` are independent lines that can run in parallel.
`CR-16` opens the hostile-MCP line.

Seven of the eight are the set all three reviews converged on. `CR-17` was added by the plan review of this
document and verified against the engine's own interface contract.

### CR-10 — The durable event log is not a gap-free ordered prefix · Blocker · needs an ADR

**Evidence.** The engine assigns sequence numbers centrally but starts each event's persistence independently
for concurrency; the code comment states the split explicitly ("persistence concurrent, delivery serialized").
The SQLite store writes each event in its own transaction, so a higher sequence can commit while a lower one is
still in flight (`packages/core/src/engine/engine.ts`, `packages/db/src/run-history-store.ts`).

**Failure.** Event `N`'s write is slow; `N+1` commits; the process dies before `N`. The disk holds a pseudo-
prefix with a hole in its sequence, and the causal predecessor the checkpoint fold depends on is missing.

**Why it is first.** This is the root cause behind the sum-vs-max decision already recorded for conservative
commitments: concurrent events under a `fan_out` have no canonical `seq` order. Every durability property below
assumes the log is an ordered prefix.

**Fix.** One ordered append tail per run. `N+1` must not reach the store until `N` is durable. Store-side
compare-and-append against the expected last sequence.

**Acceptance.** A store harness that delays event `N` and commits `N+1` must be rejected, not accepted. A crash
injected between the two must leave a prefix with no hole. Existing gap-free assertions must still pass.
Break-verify by restoring the concurrent start.

### CR-11 — No cross-process run ownership or fencing · Blocker · needs an ADR

**Evidence.** The engine states that its cross-process guarantee rests on store uniqueness, but the only DB
uniqueness is `(run_id, seq)`. `resumeFromCheckpoint` performs an in-memory check, then loads the checkpoint and
builds an independent `RunExecution`. There is no run lease, fencing token, or checkpoint-cursor CAS.

**Failure.** Two CLI or desktop processes read the same paused run at the same time and become two independent
side-effect producers for one run.

**The decision, made.** A **run lease with a monotonic fencing token**, checked on every durable write — not a
bare `last_seq` CAS. A CAS on `last_seq` stops two processes writing the same row; it does **not** stop two
processes performing the same external effect before either of them writes anything. The fence is what makes a
stale owner harmless after it loses the lease.

**Fix.** `acquireRunLease(runId, ownerId, expectedGeneration, ttl)` returning a fencing token; every durable
write carries the token and is rejected if it is stale. The process that loses becomes a read-only observer.

**Acceptance.** Two concurrent resumes of one paused run: exactly one proceeds, the other degrades to observer
with a typed, actionable error. A lease that expires mid-run is fenced out of further durable writes — proven
by driving a write with a stale token and asserting the rejection, not by asserting the lease table's contents.

### CR-12 — No durable effect/idempotency journal on the hot path · Blocker · needs an ADR

**Evidence.** `NodeExecContext` carries an attempt number but no run/effect idempotency key.
`ToolDispatchContext` carries a node id but no run correlation or semantic key. The registry calls
`def.dispatch` directly with no durable prepare step.

**Failure.** `node:started` persists → an `http_request` POST or MCP mutation completes at the target → the
process dies before the tool result or `node:completed` persists → resume re-runs the node → the target sees
the same effect twice.

**Impact.** Duplicate ticket, deploy, payment, message or commit. The *duplicate-free* product claim is false
until this closes, and audit/compensation cannot be built on top of it.

**The contract, stated precisely — three tiers, not one.** A general HTTP POST, MCP mutation or shell command
cannot be made exactly-once by the engine alone. The interval *"the target completed the effect → the process
died → no receipt reached the store"* is irreducibly ambiguous when the target offers no idempotency key and no
way to ask. Promising exactly-once across that gap would be a claim of exactly the kind this phase exists to
remove. The contract is therefore tiered:

1. **Target accepts an idempotency key** → safe retry under the same key. Effectively exactly-once, and the
   only tier that may say so.
2. **Target's outcome is queryable** → reconcile from a receipt lookup before deciding. Exactly-once after
   reconciliation.
3. **Opaque, non-idempotent effect** → `dispatched → ambiguous → needs_attention`. **Never auto-retried.** This
   is *at-most-once dispatch attempt*, and the docs must say that, not "exactly once".

**Fix.** Add `EffectAttemptId = runId + nodeId + nodeAttempt + toolCallId + effectiveArgsHash` to
`ToolDispatchContext`. Side-effectful host ports take it as a required argument. A durable state machine in the
run store: `prepared → dispatched → committed | ambiguous → needs_attention`, with the tier recorded per effect.

**Canonical docs this must correct, in the ADR's own PR:**

- [architectural-principles.md](../../standards/architectural-principles.md) §11 currently states that a stable
  key derived from `runId + nodeId + retryCount` means *"a retry never double-applies a side effect"*. That is
  false today and remains false for tier 3 after this lands. It must be rewritten to the tiered contract.
- [ADR-0041](../../decisions/0041-external-action-governance-seam.md) places transactional/idempotent wrapping
  in the optional enterprise `ActionGuard`. This ADR moves a baseline effect-identity floor below that seam, so
  it **amends** ADR-0041 rather than sitting beside it.
- [ADR-0037](../../decisions/0037-engine-tool-execution-boundary.md) owns the `ToolHost` boundary this changes.

**Acceptance.** Kill the process after the effect completes at the target — resume produces no duplicate for
tier 1 and tier 2, and produces `needs_attention` with no retry for tier 3. The same effect key arriving from
two processes commits once. A tier-3 effect is never auto-retried, proven by a test that would go red if the
retry path were reachable.

**Relationship to the realized-cost ledger.** [ADR-0076](../../decisions/0076-durable-per-attempt-realized-cost-ledger.md)
explicitly scopes effect duplication out and names this as the decision that owns it. That ADR's implementation
is this phase's [prerequisite](#prerequisite); this item is the larger of the two.

### CR-13 — Compaction summary is elevated to `system` authority · Blocker (untrusted content) · needs an ADR

**Evidence.** The prior conversation is handed to the summarizer as user-role data; the summarizer's model
output is taken as a plain string, becomes the context preamble, and is concatenated directly into the authored
`agent.system_prompt` on the next turn. Resume and model reseat restore the persisted summary into the same
preamble (`packages/core/src/engine/agent-session.ts`).

**Attack.** A user message or a read document contains a closing tag for the summary fence plus "ignore previous
instructions". The summarizer preserves it as a task. On the next tool-capable turn those bytes sit in the
`system` role — and survive a restart, because the summary is persisted. An XML fence is not a trust boundary.

**Conflict.** Our binding security standard treats model output and tool results as untrusted and forbids
concatenating untrusted content into `system`. [ADR-0062](../../decisions/0062-context-compaction-and-cli-history-commands.md)
§1 fixed exactly that concatenation as its decision, so this needs an append-only superseding ADR, not a patch.

**What the superseding ADR must answer.** ADR-0062 §1 did not choose the preamble by accident — it explicitly
rejected injecting the summary as a transcript message because *"a summary message either forces an
`assistant`-first array Anthropic rejects"*. The new ADR has to answer that, not ignore it. The likely shape is
a separate **untrusted content part inside the first user-role turn**, which is neither a standalone message nor
a `system` concatenation; whatever is chosen, the rejected alternative is engaged on its own terms.

**Fix.** Carry the summary as untrusted. Dynamic summary bytes must never reach the `system` builder. Make
`AgentTurnParams.system` accept only a branded type the authored builder can produce, so the compiler — not a
convention — enforces it.

**Acceptance.** Structural and type-level only, per working-discipline clause 6:

- A type-level test proves a dynamic `string` cannot be passed as `system`; the branded type is constructible
  only by the authored-prompt builder.
- Given a summary containing a fence-closing sequence plus instructions, the assembled request has those bytes
  in a user-role content part and **zero** occurrences in the `system` field — asserted on the built request,
  before any provider call, and again after a restore from persistence and after a model reseat.
- Tool authorization for the following turn is computed from policy alone; a test mutates the summary text
  arbitrarily and asserts the resolved tool set is byte-identical.
- **No assertion of the form "the model did not obey the injected instruction."**

### CR-14 — A stream that ends without a terminal `stop` counts as success · Blocker · needs an ADR

**Evidence.** The fallback chain emits a success attempt when the provider iterator ends cleanly with no usage
(`packages/llm/src/fallback-chain.ts`). The agent turn starts with a default `stopReason` of `stop` and returns
a normal result without ever seeing a terminal chunk. The canonical `StreamChunkSchema`
(`packages/llm/src/types.ts`) carries both `stop` and `error` as terminal arms. **An existing test pins the
no-terminal case as success** — so the fix changes that test, deliberately, rather than deleting it.

**Failure.** A transport, proxy or provider closes after `text_delta: "partial"` with no terminal chunk.
Relavium treats the partial text as a completed assistant answer and passes it downstream as a successful node
output.

**Fix — the grammar, stated in full.** The ADR pins all of it, and names which layer enforces it (adapter vs.
`FallbackChain`) so the rule has one owner:

1. Exactly one terminal per stream: `stop` **xor** `error`.
2. The terminal is the last chunk.
3. No `*_delta` or content chunk after the terminal.
4. Two `stop`, `stop` + `error`, or two `error` are protocol violations.
5. A clean EOF with no terminal is a `transport`/`protocol` error, never a success.
6. An empty stream that reaches EOF with no chunks at all is an error.
7. A pre-content failure may fail over; a **content-committed** failure must not fail over or retry — it is
   surfaced.

**Acceptance.** One test per numbered rule above, driven through a fake provider. A stream ending without a
terminal produces a classified error, not a node success. A content-committed truncation does not trigger
failover. The superseded test is rewritten to assert the new rule **and keeps a note recording the reasoning for
the behaviour it replaces**, the same way `checkpointer.test.ts` was handled in Wave 1.

### CR-15 — The engine does not enforce the authored input contract · Blocker · needs an ADR

**Evidence.** The shared contract states the engine validates inputs before a run starts. `WorkflowEngine.start()`
passes the caller's `inputs` object straight to the run execution, which stores it without cloning, applying
defaults, or validating against the schema. The input node reads values straight out of that map. The CLI's own
validator does unknown/required checks and coarse coercion only, and explicitly leaves deep validation and
default resolution to the engine.

**Failure.** An input with a declared default that the caller omitted arrives as `undefined`. A wrong type or a
value outside an enum reaches deep execution. CLI, desktop, extension and the future API behave differently —
which breaks the "one engine, every surface" guarantee directly.

**Fix.** A pure `resolveAndValidateWorkflowInputs` in core, running before id generation and before the first
event.

**Acceptance — the whole authored contract, not a sample.** `InputValidationSchema`
(`packages/shared/src/workflow.ts`) carries `format`, `pattern`, `enum`, `min`, `max`, `min_length`,
`max_length`, alongside `required`, `default` and `type`. Each gets a case:

- A missing `required` input fails admission.
- An unknown input key fails admission.
- Every validation field above rejects a violating value and accepts a conforming one.
- A declared `default` is itself validated — an authored default that violates its own rules fails at parse,
  not at run.
- The coercion/strictness split between surface and engine is stated in the ADR and pinned: the CLI's coarse
  coercion happens *before* the engine, and the engine is strict about what it receives.
- The engine **clones** the caller's `inputs`; mutating the caller's object after `start()` does not change the
  run.
- `start` and `resume` apply the same admission.
- An admission failure produces a typed error and **no `runId`, no `run:started`, no row** — asserted by
  checking the store is untouched.

### CR-16 — Stdio MCP spawns a local process before consent · Blocker · needs an ADR

**Evidence.** The MCP connection is opened while the chat session is being built, before a mode or turn starts;
the agent-run path prepares MCP first and applies mode policy afterwards. An agent or workflow declaration
produces the `command`, `args` and `cwd` spawn spec directly, and the SDK adapter spawns it.

**Failure.** No tool call is required. `ask` mode does not protect the spawn. `shell: false` does not stop the
declaration from naming `sh`, `bash` or `node`. An imported community artifact executes arbitrary local code at
load time.

**Fix.** Consent before the first spawn, showing executable, args, cwd, artifact source and hash. Unknown
fingerprint fails closed. In non-interactive mode, fail closed unless an explicit `--allow-mcp-stdio <digest>`
is supplied. Replace auto-start with lazy connect on first actual MCP tool need.

**Acceptance.** Importing and opening an artifact with a stdio MCP server spawns nothing until consent — proven
with a **real spawn counter** injected at the process boundary, asserted at zero, not by inspecting a state
flag. A non-interactive run without the digest flag fails closed with an actionable message. A changed
fingerprint re-prompts.

### CR-17 — A resume trusts caller-supplied identity it never verifies · Blocker *(plan review)* · ADR with `CR-15`

**Evidence.** `ResumeFromCheckpointInput` (`packages/core/src/engine/engine.ts`) documents its own gap: the
checkpoint verifies workflow identity, but `inputs`, `executionMode` and `planOptions` are **not** checkpoint-
derived, and the docblock states that passing different ones "would silently diverge the rehydrated execution
from its `run:started` state". The remedy is written there as "a future revision".

**Failure.** A host resumes with different inputs — a different file path, a different flag, a different
execution mode — and the run continues under a different contract than the one its durable log records. Nothing
errors. This falsifies the *crash-safe resumable workflow* claim independently of `CR-10`/`CR-11`: even with a
perfect log and a single owner, the resumed run can be a different run.

**Fix.**

- Persist a canonical, resolved input **snapshot or digest** at admission (after `CR-15` resolves defaults, so
  the digest covers what the run actually used).
- Persist `executionMode` and the execution-plan identity; verify or restore them on resume rather than trusting
  the caller.
- Verify the workflow by content/plan digest, not only slug/id.
- **Do not persist secret-typed values.** A `secret` input is carried as a key reference plus version, with a
  defined re-supply contract on resume; a mismatch is a typed error, never a silent substitution.
- A divergence produces a typed error, never a silent continue.

**Acceptance.** Resuming with a changed input, a changed `executionMode`, or a changed plan each fails with a
distinct typed error. Resuming with a `secret` input re-supplied at the same version succeeds; at a different
version it fails. The digest of a run started with defaults omitted equals the digest of the same run started
with those defaults written out explicitly. No secret value appears in any persisted row — asserted by scanning
the written rows.

---

## W2 — Liveness and deadlines

### CR-20 — Agent-node `timeout_ms` is completely inert · High
The node schema accepts the field, but the runner passes only the run-level signal to the agent turn; no timer,
controller or deadline consumes `node.timeout_ms`. An authored liveness bound is silently ignored.
**Fix + acceptance.** Honour it as a real deadline; a node exceeding it fails with a classified timeout, proven
with a fake clock.

### CR-21 — No Relavium-owned deadline for a normal provider attempt · Medium-High
The chain awaits generate/stream with the caller's signal only; unlike list-models and key validation, it sets
no per-attempt timeout. Without a node or run timeout, the vendor SDK default becomes the product's liveness
semantics — which our security standard forbids for outbound requests.
**Fix + acceptance.** An injected controller/timer factory; merge caller-abort with deadline-abort. A timeout is
`kind: 'timeout'`, a user cancel stays `cancelled`. A pre-content timeout may fail over; a content-committed one
must not. Prove timer cleanup with a fake clock. This is a different timer from `CR-20` — both are needed, and
the pre/post-content split must agree with `CR-14`'s rule 7, so it lands on that ADR.

### CR-22 — Gate and run deadlines are not preserved across resume · High
The checkpoint's pending gate carries gate/node/budget data but not an absolute deadline, and the whole-run
timeout is re-armed for its full duration on every resume — so a crash extends the cap.
**Fix + acceptance.** Persist absolute deadlines; resume computes the remaining time. A run crashed and resumed
repeatedly still times out at its original absolute deadline.

### CR-23 — Exactly-one-terminal is a safety property, not a liveness one · High · **decision open**
Cancel only fires the abort signal, and the terminal waits for the running-node count to reach zero. The node
executor seam accepts an arbitrary promise; honouring the signal is not guaranteed at the type level. An
executor that ignores abort and never settles leaves the run without a terminal forever.
**Open decision.** The grace-period length and whether a quarantined executor is disabled process-wide or per
run. Settle before starting.
**Fix + acceptance.** A bounded grace period after cancel/timeout, then a generation token that fences the run
state from late outcomes, plus executor quarantine. Tests: a never-settling executor and a late-success executor
both produce exactly one terminal in bounded time, and the late output is not applied.

---

## W3 — Resource governance and bounds

### CR-30 — The accepted no-drop bounded stream is not implemented · High
`push()` appends without a capacity check; `whenDrained` is advisory and only awaited at node boundaries, while
token deltas are emitted synchronously. A single provider stream can grow memory without a hard bound.

**This is not an open choice.** [ADR-0036](../../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md)
already decided it: *"buffering is bounded per consumer with a producer-await (no-drop) policy"*, because the
stream must stay gap-free — a drop would force a `sequenceNumber` resync, and reconnect/resync plus event-sourced
resume are both built on that. Implement the accepted decision. A drop policy would need an ADR that supersedes
ADR-0036, and nothing found here argues for one.
**Fix + acceptance.** Real producer-await backpressure with a hard per-consumer ceiling. A test drives a fast
producer against a slow consumer and asserts the buffer never exceeds the ceiling **and** that no sequence
number is skipped.

### CR-31 — No safe default concurrency and no absolute graph/retry caps · High · **cap values open**
An omitted `max_parallel_nodes` means `Infinity`. There is no absolute cap on authored nodes, edges, fan-out
width, fallback-chain length, retry counts, parallel tools or total attempts; the parser's text-size limit does
not stop many small ones.
**Fix + acceptance.** A small capacity-derived default concurrency that an authored value may only narrow, plus
explicit absolute caps enforced at parse/compile admission with typed errors. The numbers are a maintainer call.

### CR-32 — Workflow output, state and durable event size are unbounded · High · **bound values open**
**Fix + acceptance.** Bound them at the durable boundary with a typed rejection, the same way tool output is
already bounded. The numbers are a maintainer call.

### CR-33 — Finished runs are retained forever in memory · Medium-High · **policy shape open**
`WorkflowEngine` keeps completed runs indefinitely.
**Fix + acceptance.** A retention policy with an explicit bound; a long-lived process running many workflows
does not grow without limit. Whether retention is count-, age- or memory-based is a maintainer call.

---

## W4 — MCP hostile boundary

Executes Wave 2's MCP queue (see [Phase boundary](#phase-boundary)). One security sitting covers this group
plus `CR-16`.

### CR-40 — Cancellation and deadlines never reach the MCP transport · High
The dispatch context can carry a signal, but the manager's `callTool` chain does not forward it, and neither the
connection nor the stdio SDK call accepts an abort or deadline. After a user cancels, the remote or child effect
continues and child processes can survive.

### CR-41 — The MCP SSRF floor does not cover DNS or redirects · High
The network config checks the authored hostname and scheme, then hands the raw opener to the SDK. The code
itself documents the DNS-to-private and redirect-to-private holes. A public-looking domain can resolve to
loopback, RFC1918 or a metadata IP.
**Fix.** Apply the built-in egress mechanism — resolve-all, range-block, pinned IP — to the MCP HTTP, SSE and
WebSocket transports.

### CR-42 — MCP discovery and result ingress are unbounded · High · **bound values open**
Page count is capped for `tools/list`, but total tool count, byte size, description and schema size are not, and
a result is fully materialized before core bounding applies. A hostile server can exhaust startup memory, inflate
prompt token cost, or bloat a workflow output.

**Acceptance for W4.** A hostile-server harness, with adversarial cases rather than a smoke test: a server that
never answers is cancelled within its deadline and leaves **no orphan process** (asserted on the child-process
table, not on the promise); a DNS record resolving to loopback, to an RFC1918 range and to the cloud metadata
address are each refused; a redirect to any of those is refused; oversized discovery and results are rejected
with typed errors **before** they reach the prompt.

---

## W5 — Media correctness

### CR-50 — `read_media` does not work end to end · High · **decision open**
The builtin returns a base64 media part, the registry places generic output into the tool result, and the LLM
message schema explicitly forbids raw media bytes there. The canonical alternative is a handle-only attachment,
but all three adapters deliberately drop that field, and production chat does not wire the media-read scope.
There is no registry → turn → chain → adapter path.
**Open decision.** Complete the handle path through the adapters, or remove the tool from the catalog until it
works. Either is acceptable; shipping an advertised tool that cannot work is not.
**Fix + acceptance.** An end-to-end test proves the chosen answer. If removal is chosen, a test asserts the tool
is absent from the catalog the model sees.

### CR-51 — Model-level tool/attachment capability is not enforced · High
The catalog carries `toolCall` and `attachment` metadata, but runtime gates on the provider-wide flags and the
adapters attach tools unconditionally. A model the catalog marks as tool-incapable can still be sent tools, and
the chain can treat it as capable instead of pre-skipping it — turning a free skip into a paid 400.

### CR-52 — Gemini reasoning/tool continuation metadata is lost · Medium-High
Part-level thought signatures on function calls are not captured, and replay drops reasoning after a tool
result. Multi-turn thinking-plus-function-calling continuations can 400 or break semantically.
**Governance note.** This is **not** newly discovered drift. [ADR-0039](../../decisions/0039-same-provider-reasoning-replay.md)
deliberately deferred it and recorded it in [deferred-tasks.md](../deferred-tasks.md). This phase pulls that
deferral forward; the item closes by landing the work **and** checking off the deferred-tasks entry, so the two
records do not disagree.

### CR-53 — Large media travels fully buffered and base64-encoded · High
Audio and video responses are read into a full buffer and converted to base64; raw buffer, typed view, base64
string and the store's decoded copy can all exist at once.
**Fix + acceptance.** A bounded stream or download lease from the adapter; the host writes straight to the media
store with a `Content-Length` and streamed-byte ceiling. A large-media test asserts peak memory stays bounded.

### CR-54 — URL media can produce different bytes on resume · High
Remote URL media is resolved again on resume, and the same URL can return different content, a different
redirect or a different DNS answer. The run appears to have the same inputs while the model sees different bytes.
**Fix + acceptance.** Convert to a content-hashed handle at first resolution; resume must not re-fetch. Pairs
with `CR-17`: the input digest is only meaningful if a URL input's bytes are pinned.

### CR-55 — Missing media rates can bypass a strict cost cap · Blocker for the strict-cap claim
Where a media rate is absent the estimator can fall to zero, the generated catalog projection produces no media
rate, and the DB's media-rate columns are not carried into the listing/overlay path. The governor can then treat
a missing rate as *priced at zero* rather than *unpriced*, admitting paid image/audio/video generation under a
strict cap and reporting `cost:updated = 0`.
**Fix + acceptance.** Missing media rate ⇒ unpriced, never zero. Under a strict cap an unpriced media generation
is refused. Carry the media rates through the overlay path. Break-verify by restoring the zero fallback.

---

## W6 — Authoring correctness

### CR-60 — `merge_strategy: first` is not implemented as specified · High · **decision open**
The canonical table says the first resolved branch wins and the others are ignored. The engine waits for every
branch to settle and the handler takes the first surviving output in declaration order. A slow loser adds
latency and cost; a failing loser can fail the run even when the winner is ready.
**Open decision.** Implement race semantics, or rename the strategy and correct the canonical table. The name
and the behaviour must agree; which one moves is a maintainer call.
**Fix + acceptance.** Whichever is chosen, a test pins latency and cost behaviour — a slow loser must not extend
the run's wall clock if race semantics are chosen, and must be documented as doing so if they are not.

### CR-61 — Agent and transform `output_schema` do not deep-validate · Medium · **needs a dependency ADR**
An agent's `output_schema` becomes a response-format hint and is then only `JSON.parse`d; the transform node's
`output_schema` explicitly does not deep-validate.

**The governance drift, stated precisely.** [ADR-0038](../../decisions/0038-agentrunner-llm-call-boundary.md)
required node-side `output_schema` validation to land **with 1.O in the same PR or behind a hard acceptance
gate**, "never silently deferred". What shipped is
[error-handling.md](../../standards/error-handling.md)'s narrower rule: Phase-1 scope is parse-as-JSON only, and
deep JSON-Schema conformance is a deferred follow-up **because it needs a JSON-Schema validator dependency
behind an ADR** — Zod cannot consume an arbitrary JSON Schema. So the two documents disagree about what was
required, and the narrowing was never recorded as a decision.
**Fix + acceptance.** Either land deep validation (which requires a new-dependency ADR under CLAUDE.md rule 2,
and that ADR is the gate), or record the narrowed contract as a decision that supersedes ADR-0038's clause.
Silence is not an option. A typed `validation` failure on a schema-violating but valid-JSON output is the test
either way — passing if validation lands, documented-as-absent if the narrowing is chosen.

### CR-62 — Expression dependencies are invisible, so silent mis-routing is possible · High · **decision open**
The DAG derives edges from template references only and deliberately does not order JS-expression reads of run
outputs. A condition that runs before its producer compares `undefined` and silently takes the false branch — a
test currently pins that silence.
**Open decision.** Extract dependencies from expressions, or fail loudly when an expression reads an unresolved
output. Not a silent false, either way.
**Fix + acceptance.** The pinning test is rewritten to the chosen rule and keeps a note recording the reasoning
for the behaviour it replaces.

### CR-63 — Agent `input_schema` runtime enforcement: verify the docs, do not implement · Low *(plan review)*
Split out of `CR-61` because it is a different contract with a different answer.
[agent-yaml-spec.md](../../reference/contracts/agent-yaml-spec.md) states that `input_schema` is *"purely
additive metadata — it drives type-safe node chaining and editor (VS Code) completion; it does not change
run-time execution"*. Under that spec, the absence of runtime enforcement is **correct**, not a defect.
**Fix + acceptance.** No runtime change. Grep every canonical document and the product surface for a claim that
an agent's `input_schema` is validated at run time; if one exists, correct it to match the spec. If none exists,
close the item with that finding recorded — do not implement enforcement to satisfy a claim nobody made.

---

## W7 — Agent product correctness

### CR-70 — Cross-turn tool-call memory does not exist · High (product) · **decision open**
Only the final assistant text enters the cross-turn transcript; within-turn tool call/result pairs are dropped. A
coding agent cannot remember a file it read in the previous turn and calls the tool again.
**Open decision.** Persist the tool pairs (bounded), or narrow the canonical session spec. The bound is part of
the decision.

### CR-71 — Session transcript and export lose tool history · High
The persister stores the same text-only model, so the exporter — written to derive tool names from assistant
tool-call parts — has nothing to read. The canonical session spec promises a full transcript with a tool union.
**Fix + acceptance for CR-70/71.** One decision, one PR. A graduated workflow must represent the flow that
actually happened, or the spec must stop promising it.

### CR-72 — Authored agent `memory` policy is inert · Medium · **decision open**
`none | window | summary` is accepted by the schema and consumed by nothing.
**Fix + acceptance.** Implement it or reject it at parse time with a typed error. A schema that accepts a field
nothing reads is a claim the code does not keep.

### CR-73 — `invoke_agent` has no production delegate · High (2.6 go/no-go)
The builtin exists in the catalog and errors with tool-unavailable when no delegate is wired; nothing wires one
in production, and the availability filter keeps the delegate-backed tool in the catalog.
**Fix + acceptance.** Wire the delegate, or stop advertising the tool to the model when no delegate exists. The
cheap option is always available, which is why this is non-deferrable.

---

## W8 — Provider and conformance

### CR-80 — An invalid custom base URL fails OPEN to the official endpoint · High (security/compliance)
When the custom provider factory rejects a private, malformed or credential-bearing URL, the error is caught and
the default adapter is left standing — and a test pins that fail-open as correct. A user expecting an internal
gateway silently sends prompts and keys to the official API after a config drift.
**Fix + acceptance.** Fail closed with an explicit message. The error must name the rejected URL's *shape*
without echoing an embedded credential — asserted directly. Rewrite the test that pins the old behaviour,
keeping a note with the reasoning it replaces.

### CR-81 — Conformance cassettes do not verify the request wire contract · High
A recorded response carries status, content type and body only; replay checks that the request body is parseable
JSON and matches nothing else — not method, path, headers, or a canonical body. A dropped `response_format`, a
lost tool result on continuation, or a broken system-instruction mapper leaves the suite green.
**Fix + acceptance.** Match the canonical request. Mutating the request lowering must redden the suite — proven
by actually applying at least three distinct mutations, not by assertion count.

### CR-82 — Missing or partial usage can be read as zero · High
Carried from our own backlog and re-confirmed by the reviews.
**Fix + acceptance.** Missing usage is *unknown*, never zero, on every path that reaches a cost total.

---

## W9 — Harness honesty and isolation

`CR-90` and `CR-91` execute **first** (see [Execution order](#execution-order)); `CR-92` executes inside the
durability spine. They are grouped here by theme only.

### CR-90 — Root coverage collects in-repo worktrees · Medium · ✅ CLOSED 2026-08-10
The root Vitest include patterns have no exclude for repo-local checkout directories, so a stale worktree adds
test files and 0%-covered sources to the run. In one working tree this produced 471 discovered test files and 23
suite failures; excluding the worktree path produced 237 files and a clean run.
**Fix + acceptance.** Exclude repo-local checkout areas from both `test.exclude` and `coverage.exclude`. The
self-test uses a **synthetic repo-local checkout fixture** — a directory tree containing a test file and a
source file — not a real `git worktree`; a real worktree makes the test depend on git state and the working
directory, which is exactly the non-determinism this item is about.

**Closed by `5f69ddc` + its review fold.** `REPO_LOCAL_CHECKOUTS` in `vitest.config.ts` (spread into both
excludes), the guard at `tools/test-isolation/check.mjs`, wired into `pnpm run ci` and `.github/workflows/ci.yml`,
plus the tracked `.gitignore` entries the local `.git/info/exclude` was standing in for.

Three corrections to the record above, all measured rather than recalled:

- **Re-measured 2026-08-10: 472 → 238**, not 471 → 237; the tree grew one test file. The foreign 234 were a
  full agent-tooling checkout under `.claude/worktrees/<id>/`.
- **It did NOT threaten the coverage floor**, which the original evidence implied and an earlier version of
  this fix asserted. Vitest matches threshold globs ROOT-RELATIVE with no implicit leading `**`, so the foreign
  sources match none of the three per-package globs and land in the unset `global` group. The counterfactual
  exits 0 at 48.85% lines. What the leak destroys is the reported number and the lcov/html artifact — and it
  becomes floor-load-bearing the moment a global threshold is added.
- **CI never saw any of it.** `.claude/worktrees/` was hidden by a LOCAL `.git/info/exclude` entry and CI checks
  out clean, so both excludes are no-ops there. The exclusions defend a developer's tree; the guard is the part
  that defends CI, by failing if they are ever weakened.

The acceptance criterion above names a fixture, and a fixture alone is not sufficient — recorded because the
first attempt shipped exactly that gap. Deriving fixtures from the exclusion list proves every LISTED location
is excluded, and cannot prove the list is COMPLETE: removing the one entry that mattered also removes its
probe, and the guard reports green while re-collecting all 234 foreign suites. The guard's primary assertion is
therefore structural and consults no list — any collected file whose ancestor carries its own
`pnpm-workspace.yaml` is in a second checkout.

**One recorded limitation, not a property.** "A second checkout always carries its own `pnpm-workspace.yaml`"
holds for `git worktree add`, `git clone` and a full copy — every case seen here — but not for a sparse
checkout, a `--no-checkout` worktree, or a partial rsync of `packages/**`. Such a tree would be collected with
nothing in its ancestry to detect, and the primary assertion would pass in silence, leaving only the
list-based checks. Nothing in this repo produces one today; if that changes, the predicate needs a second
marker. Stated here and in the guard's own docblock because the first version asserted it as an absolute.

### CR-91 — The workflow E2E harness is not a crash or durability oracle · Medium · ✅ CLOSED 2026-08-10
It pins that the live stream reported success; it does not prove durable truth after a restart.
**Fix + acceptance.** An oracle that asserts live result, DB history, resume and reconcile agree on the same
terminal type and payload. **This is the instrument `CR-10`, `CR-11`, `CR-12` and `CR-92` are proven with**, so
it lands before them: a spine asserted with the harness the reviews already found insufficient is not asserted.

**Closed by `packages/core/src/engine/durable-truth.ts`** — `checkDurableTruth` compares four views (live
terminal, durable history, the history a FRESH engine leaves after `reconcile()`, and the status the
checkpoint fold derives) and returns a structured verdict rather than throwing, so callers can assert on the
specific disagreement and the oracle can have its own tests. `formatDurableTruth` renders the diff.

Two design points worth carrying into the spine work:

- **Envelope fields are excluded from the comparison on purpose.** `timestamp` and `sequenceNumber` move on
  every restart; comparing them would make every run look like a disagreement while catching nothing. What
  must agree is the terminal's TYPE and the payload a consumer acts on — outputs, error code, cost.
- **The checkpoint view is not decoration.** A resume seeds itself from the fold, so a fold that disagrees
  with the durable terminal means a resumed run does the wrong work even when every event on disk is intact.
  That is the `CR-92` shape the live stream cannot see.

Ten unit tests cover the detection logic (including the headline case: live says `completed`, history says
`failed`), and three e2e tests apply the oracle to real engine runs on all three terminals. Break-verified:
stopping the engine from persisting terminals reddens all three e2e tests with a readable four-view diff.

### CR-92 — Terminal persistence failure lets live and durable truth diverge · High · in the durability spine
The engine can complete the delivery chain for a terminal event even when its persistence failed, and
reconciliation may later produce a different terminal than the original. Media reclaim can run before the
terminal is durable. A caller can receive a success result and outputs while history shows the run failed.
**Fix + acceptance.** Hold the intended terminal payload in a durable outbox and retry it under the same
identity. If durability is uncertain the API must not say `completed` — it returns a distinct typed result.
Terminal asset cleanup and handle resolution happen only after the terminal is durable. The test proves live,
history, resume and reconcile agree.

### CR-93 — Process-global catalog and parameter-learning state is not tenant-safe · Medium now, High for cloud
Process-global mutable state is fine for a single local user and wrong for the multi-tenant cloud surface.
**Fix + acceptance.** Scope it per run/session/tenant before any multi-tenant surface ships. **The decision is
recorded in this phase even if the work is deferred** — a deferral here moves to
[deferred-tasks.md](../deferred-tasks.md) with its trigger (the first multi-tenant surface) named.

### CR-94 — One budget approval opens every redispatch without a numeric limit · High
An approved vertex skips pre-egress admission on redispatch, and one agent turn can make many tool rounds plus a
final generation. The user approves a projection they saw, but the approval means "this vertex is exempt", not
"up to this amount".
**Fix + acceptance.** Make the approval an immutable numeric lease bound to money/token/attempt scope, model and
expiry, consumed atomically by each egress. An approved node that exceeds its lease pauses again.

### CR-95 — A mid-tool-loop budget pause replays the whole loop · High (Blocker while CR-12 is open)
A budget pause becomes a paused outcome; on approval the node is reset to pending and dispatched from the start.
The code already acknowledges that this repeats earlier provider and tool calls.
**Fix + acceptance.** **Short term (non-deferrable): forbid a mid-loop budget pause — fail closed.** Long term:
checkpoint the continuation — provider messages, tool call/result pairs, round index — and resume from that
point. A mid-loop pause plus approval must not repeat a mutation. The short-term fix closes the claim; the long
term may be deferred with its trigger named.

---

## Exit criteria

This phase is done when **all** of the following hold:

1. **Every non-deferrable item is closed with a break-verified test.** Non-deferrable means the register above
   says so: `CR-01`–`CR-03`, `CR-10`–`CR-17`, `CR-50`, `CR-55`, `CR-73`, `CR-80`, `CR-92`, and `CR-95`'s
   short-term fail-closed fix. **None of these may be deferred**, for one reason: each is either a security or
   correctness boundary, or a shipped claim the code does not keep — and every one of them has a cheap
   fail-closed option (refuse, remove, narrow the claim) available when the full fix is too large. "Too big to
   fix now" is an argument for the cheap option, never for deferral.
2. **Every other item is closed, or deferred with a full record.** A deferral is written in
   [deferred-tasks.md](../deferred-tasks.md) with its severity, its trigger, and — this is the part that is
   usually skipped — **the product claim it narrows**. A deferred item's behaviour must not remain in any
   canonical document as a shipped guarantee.
3. **Each `W1` item has an accepted ADR, and the ADRs land in dependency order.** Eight ADRs (or fewer, where
   the register above pairs two items onto one), all before their implementation.
4. **Every canonical document that promised behaviour listed here says what the code now does** — in particular
   the claims about crash-safe resume, duplicate-free effects, bounded streams, first-branch-wins,
   schema-validated input/output, and session-to-workflow graduation. This explicitly includes
   [architectural-principles.md](../../standards/architectural-principles.md) §11's idempotency sentence.
5. **Four security-review sittings are recorded**, each with a checklist entry and its adversarial test:
   prompt/trust provenance, hostile MCP, media bytes, provider/config trust.
6. **`pnpm run ci` exits 0 and `pnpm coverage` exits 0**, both checked by exit code. `pnpm run ci` alone is not
   the merge gate — `coverage` is a separate required check, and this phase edits `packages/core` heavily.
7. **A closing register in this file states, per item, the code that closes it** — verified by reading the code,
   not by trusting the mark. Wave 1's completion claim was wrong twice before this discipline was adopted.

## Scope note

One item already in flight is NOT part of this phase and keeps its own tracking: the transaction-handle cleanup
across the remaining database stores. It is listed here only so nobody schedules it twice.

The realized-cost ledger is **no longer scoped out** — it is this phase's [prerequisite](#prerequisite), for the
file-overlap reason recorded there.
