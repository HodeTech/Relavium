# ADR-0100: Budget authorization is durable state with a replay barrier

- **Status**: Accepted — maintainer approved 2026-10-02; implementation staged in `W7`
- **Date**: 2026-10-02
- **Related**: [ADR-0075](0075-fail-closed-resume-on-an-unreadable-event-log.md) · [ADR-0078](0078-ordered-durable-append-and-the-terminal-outbox.md) · [ADR-0079](0079-cross-process-run-ownership-lease-and-fencing-token.md) · [ADR-0080](0080-durable-effect-journal-and-the-tiered-effect-contract.md) · [ADR-0097](0097-a-budget-approval-is-an-allowance-not-an-exemption.md)
- **Scope**: `W7`'s `CR-94` and `CR-96`; refines ADR-0097's durable mechanism and applies ADR-0075's replay refusal to its changed authorization semantics. No runtime dependency or general log-version system.

> Amended 2026-10-02 — [ADR-0101](0101-configured-output-estimates-apply-only-when-the-wire-is-uncapped.md),
> accepted by the maintainer, refines frozen allowance sizing with candidate-specific effective
> cap plans and rate-only resolved-token pricing. The paused raw options remain ephemeral; only
> the existing frozen amount/provenance are durable. This does not change authoritative ordering,
> companion identity, acknowledgment barriers or dispatch ownership. Implementation is staged in
> W7. The historical body remains unchanged.

> Implementation checkpoint 2026-10-03 — W7 Step 10 implements this protocol with shared strict
> schemas and one ordered suspension reducer for checkpoints and interrupted-run discovery. Explicit
> persistence acknowledgement and admitted-owner barriers protect every authority/companion boundary.
> Sixty actual-runner cases cover crash, cancellation, fencing, write faults, sibling identities and
> preflight precedence. The [immutable actual-predecessor check](../../tools/budget-replay-compat/README.md)
> passes twelve refusal prefixes and two legacy controls and runs in full CI. Formal committed-step
> reviews remain pending; CLI confirmation/discovery is Step 11. Historical bodies remain unchanged.

## Context

ADR-0097 freezes an allowance and its provenance on optional fields of existing budget/gate events. The pre-`W7` reader recognises those event types and strips the new fields: it records no skipped row, so ADR-0075's replay refusal never fires. Its checkpoint fold still completes the agent with `{ decision: 'approved' }`, and its live budget approval still removes the pre-egress hook. An older binary can therefore approve or replay a new bounded authorization under the old uncapped semantics.

The review reproduced this using the actual pre-`W7` stored-event parser and checkpoint fold: synthetic new fields on the known pause/approval events yielded zero unknown rows and a completed agent with the invented decision output. A schema migration does not fix it; the current migration runner has no downgrade guard.

ADR-0075 already decides that execution cannot proceed past durable state a binary cannot interpret, while display remains tolerant. The missing piece is a state-bearing event discriminant that an older binary cannot mistake for the old authorization contract. The exact event shape has one canonical home in [sse-event-schema.md](../reference/contracts/sse-event-schema.md).

## Decision

**We record a budget authorization under a new, state-bearing event type before publishing its companion legacy-shaped gate event or acting on its decision.**

- Introduce `budget:authorization`, a durable run event representing a frozen budget pause or a recorded budget decision. It carries the gate/node identity and the authorization state needed by the checkpoint, including the quote or the explicit legacy-no-allowance state. A pause also freezes any existing gate deadline (`expiresAt`, `timeoutAction`, `timeoutMs`) from the same values its companion uses; the authoritative row alone restores that deadline without restarting its elapsed duration. This does not introduce a timeout for a gate that had none. It is actual authorization data, not a version-only marker.
- The new event is the authoritative record for its authorization transition. Existing `budget:paused`, `human_gate:paused` and `human_gate:resumed` remain available as companion surface events with ADR-0097's fields. Matching companions do not overwrite a decision or complete an agent. Conflicting persisted companions are refused as corrupt state, not resolved by event order.
- Authorization and companion records join by **`(runId, nodeId, gateId)`**, never by node identity alone. Paused companions already carry `gateId`; W7-produced budget `human_gate:resumed` companions also carry it, including decisions of legacy gates. Its schema field remains optional for ordinary human-gate events and legacy stored rows, but is required on every budget decision companion W7 emits. Budget identity comes from a recorded `budget:paused` or `budget:authorization`, not `human_gate:paused.gateType`: an ordinary human gate may also be an `approval` gate.
- Only a legacy resumed row without `gateId` uses the ordered fold's **exactly one then-outstanding gate for that `(runId, nodeId)`**. The recorded gate determines whether it is budget or ordinary. Zero or multiple matches refuse as corrupt; resolved history is never searched for a convenient match. An identified duplicate for an earlier gate is a no-op for the current node/gate, even after that node re-pauses or completes with a real output. This makes ADR-0097's September 18 "cannot be joined back" observation a historical limitation of the old event, rather than an assumption about the new companion.
- For a new pause, durably acknowledge its `budget:authorization` before publishing the companion pause events or accepting a decision. A crash with only that authoritative row reconstructs a pending budget gate with the same frozen quote. The durable interruption projection recognises it as a resumable budget pause, just as it recognises today's `budget:paused`. This does not emit an aggregate `run:paused`, stop an active sibling or surrender its live owner's lease early; normal aggregate lifecycle and ownership ordering remain intact.
- For a decision, perform ADR-0097's amount, provenance and decision-kind checks before the gate claim/timer disarm. Then durably acknowledge the new event before publishing the companion decision or redispatching. A crash with only the authoritative decision preserves approval/rejection without inventing an agent output. No egress is authorised by an unacknowledged decision.
- This also applies when a new binary decides a **legacy** budget gate. A legacy approval grants no allowance, as ADR-0097 already requires, but its corrected checkpoint semantics are still new durable state. There is no interval in which a new decision is persisted only in the old interpretable form.
- A pre-`W7` binary sees an unknown event and its existing ADR-0075 replay read refuses before registering an execution, scheduling, dispatching or egress. The engine acquires its lease before the authoritative read, as ADR-0079 requires, and releases that lease on refusal. Its read-only surfaces remain tolerant and show the known surrounding events. A W7-capable binary reads legacy logs without requiring the new event retroactively.
- Use the ordered append already owned by the engine **and explicitly observe its acknowledgement result**. The existing `#emitDurable` absorbs a store fault and resolves after recording run failure; awaiting that promise alone is not proof of durability. Use its established failure/ownership observation barrier (as the realized-money writer does), covering a pre-existing failure, cancellation and fencing loss as well as a new write failure. Only a confirmed durable transition on a still-admitted live owner can publish a companion or grant/redispatch an allowance. This adds work at a budget pause/decision, not at every LLM attempt. A write failure follows ADR-0078's loud terminal/outbox failure path; it publishes no companion approval and dispatches no approved call.
- The event does not change the allowance amount/debit rule, exhaustion, price-provenance refusal, reset-to-no-allowance after crash, or strict-cap enforcement. The effect-journal preflight still takes precedence: approval is never permission to repeat an unresolved external effect.

Considered relying on optional payload fields: the old parser demonstrably erases them. Considered a database or general run-format version: ADR-0075 rejected that additional version system, and it would unnecessarily couple unrelated runs to this change. Considered a content-free compatibility marker: it creates a second protocol without recording the state that must survive a crash. The proposed state-bearing discriminator lets the existing strict replay read enforce its already-accepted policy.

### Acceptance and landing

- A compatibility harness exercises the pre-`W7` parser, strict store read and checkpoint/engine entry path against a new pause and separately a new decision. Freeze the relevant actual source/dependency closure from baseline `1b3f8d70` in an isolated test artifact, with a source manifest and digest; its module resolution must bind to those frozen shared schemas rather than the updated workspace parser. The harness uses logs emitted by the W7 engine with injected deterministic hosts, makes no provider call and extracts the predecessor outside normal test collection. Replay refuses before execution registration, scheduling, dispatch or egress, and releases any lease acquired for the read; display still returns known surrounding events. An arm-excluded current union or a fabricated unknown event is not a substitute for this predecessor check.
- Repeat with a new binary's approval and rejection of a legacy budget gate, including crashes between the authoritative row and each companion. No downgraded replay is admitted.
- With a new binary, an authoritative pause alone restores the quote and pending gate, appears as resumable in both SQLite and reference-store interrupted-run discovery, and can resume after the prior owner's lease expires or releases. A live sibling retains its normal ownership and aggregate run lifecycle. Checkpoint reconstruction makes an authoritative approval's agent pending rather than completed; on an admitted resume, an authoritative rejection dispatches nothing and fails `budget_exceeded`. Neither decision promises automatic continuation of a crashed run without an eligible resume operation.
- Duplicate matching persisted companions/authorization decisions are idempotent. A contradictory persisted quote or decision is corrupt state and is refused. Repeated API requests for an already-resolved gate keep ADR-0097's existing no-op policy, even if the repeated request proposes another decision; they create no contradictory durable row. The new event's gate id disambiguates parallel pending budget gates.
- Pin an approved `g1`, crash, and a resumed agent pausing at `g2`: an identified duplicate `g1` decision/companion cannot resolve `g2` or change its node state. Repeat after a real `node:completed`; its output survives. A legacy missing-key row joins only the single outstanding gate at its own sequence position; missing/ambiguous matches refuse.
- Two parallel budget gates and an ordinary sibling human gate retain separate identities through crashes after each authoritative row and each companion. Gate/quote mismatches refuse; matching companions leave sibling gates untouched.
- A failed authoritative write publishes no companion approval and permits no approved egress; the existing terminal/outbox contract remains intact.
- Inject an absorbed non-terminal store fault, a pre-existing run failure and a fencing/cancellation race at each authorization await. No later companion or approved dispatch can pass the acknowledgement barrier. An authoritative pause alone preserves an existing absolute gate deadline and resumes/re-arms against elapsed time; absent deadlines stay absent.
- The `CR-96` crash matrix still includes sibling human gates and effect-journal refusal after a tier-3 effect. No compatibility fixture substitutes for those runtime tests.

After approval, add a dated forward note to ADR-0097 covering the authoritative transition and its identified companions, explicitly qualifying the September 18 missing-`gateId` limitation; add a mechanism note to ADR-0075 without reversing its replay policy. Update the canonical event/checkpoint contracts, [commands.md](../reference/cli/commands.md), `W7`'s checklist and closing register with the implementation. All bodies below older ADR metadata remain historical records.

## Consequences

### Positive

- An older binary cannot silently strip a bounded authorization into the uncapped or invented-output contract.
- Each new authorization transition survives a crash independently of its companion display event.
- One existing replay policy covers both new event types and this semantic change.

### Negative

- Budget pauses and decisions add one durable state transition and its acknowledgement. They reuse the existing ordered writer rather than adding an attempt-level barrier.
- Downgrading prevents execution of a run containing the new event. Read-only inspection remains available; upgrading is the remedy, as ADR-0075 already decides.
- Companion events duplicate displayed values. The authoritative row and explicit consistency checks prevent conflicting copies from silently changing execution.
- The frozen predecessor harness has a source/manifest maintenance cost. Its baseline stays immutable; a future protocol change adds its own explicit compatibility evidence rather than silently updating this reader to the new semantics.

## Implementation correction — 2026-10-03

The first committed Step 10 review found that the predecessor harness pinned source and
package bytes but did not bind nested CJS/peer/optional dependency edges. A redirected
SQLite `bindings` edge executed while all listed hashes and protocol cases passed. The
parent independently reproduced the same false integrity pass.

The [permanent check](../../tools/budget-replay-compat/README.md) now freezes the complete
installed declared graph proven by the original predecessor lockfile, preserving the
original 93 roots' portable bytes and every archived source byte. Exact installed edges,
missing optionals and duplicate versions are checked before running an owned copied
closure; both CommonJS and ESM runtime loads verify its file inventory. Seven permanent
graph controls and parent causal interventions distinguish edge/byte drift from the
unchanged real predecessor's twelve replay refusals and two legacy positive controls.
Fresh full-Step-10 acceptance remains pending. This repairs the acceptance mechanism;
the replay barrier and downgrade policy decided above are unchanged.
