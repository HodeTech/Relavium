# ADR-0103: A paused run hands off its local producers before its host closes

- **Status**: Accepted — maintainer approval recorded 2026-10-08
- **Date**: 2026-10-07
- **Related**: [ADR-0036](0036-run-loop-substrate-event-bus-and-execution-host.md) · [ADR-0042](0042-engine-media-storage-substrate-mediastore-deinline-retention.md) · [ADR-0045](0045-async-media-job-loop-poll-checkpoint-resume-cancel.md) · [ADR-0049](0049-cli-machine-output-contract.md) · [ADR-0076](0076-durable-per-attempt-realized-cost-ledger.md) · [ADR-0077](0077-realized-cost-ledger-uses-the-conservative-commitment-barrier.md) · [ADR-0078](0078-ordered-durable-append-and-the-terminal-outbox.md) · [ADR-0079](0079-cross-process-run-ownership-lease-and-fencing-token.md) · [ADR-0080](0080-durable-effect-journal-and-the-tiered-effect-contract.md) · [ADR-0085](0085-the-node-executor-owes-liveness-and-the-engine-enforces-it.md) · [ADR-0097](0097-a-budget-approval-is-an-allowance-not-an-exemption.md) · [ADR-0100](0100-budget-authorization-is-durable-state-with-a-replay-barrier.md)
- **Scope**: W7's verified voluntary paused-finalization race. Adds one engine-owned graceful local host-departure operation to `RunHandle`, including the real terminal/fenced branches that can win during departure. Covers ordinary/budget gates, submitted media jobs and combinations. Clarifies permitted late-receipt lifetime and preserves the authored deadline of a reattached parked agent. AgentSession, running crash-attempt restart policy, provider-side cancellation and a background daemon are outside this decision.

## Context

Acknowledged `run:paused` is resumable history, not proof that local producers stopped.
Gate/run/node deadlines remain live across a park; media polling may remain live too.
Returning the primary iterator unsubscribes without joining engine work.

The fifth Group 3 review holds actual Ink unmount while an actual authored gate timer rejects
or autoapproves. Native `runCommand` can return exit 3 and a paused summary after this execution's
durable terminal advances. A held terminal append can outlive SQLite closure, fail its later
write and retain a lease. Parent independently repeats this with an earlier unpublished
`node:failed` append; stable pause passes. These are actual engine/SQLite/command paths with
injected waits/callbacks, not real TTY or clock-expiry claims.

An emitted-event selector misses unpublished work; unconditional terminal waiting hangs a real
pause; implicit cancellation changes resumable state. Private pre-admission `abandon()` has no
admitted-run join. Initial independent design review also identifies missing checkpoint-media
API reachability, node-deadline restoration, and an observable terminal host-cleanup join.

ADR-0085 separates bounded run-terminal production from resource termination and permits late
receipts for effects/charges already incurred. We preserve these receipts. Graceful host close
therefore has conditional liveness while an executor still holds such a receipt capability.

The lifecycle home is [shared-core-engine.md](../architecture/shared-core-engine.md).
Durable shapes stay in [sse-event-schema.md](../reference/contracts/sse-event-schema.md);
surface outcomes stay in [commands.md](../reference/cli/commands.md).

## Decision

**The engine acknowledges local host departure. A surface retains its host until the operation
certifies paused detachment or host-safe completion of the actual closed execution.**

Considered CLI buffer inspection, waiting for every pause to become terminal, automatic cancellation
and unref/process exit. Reject them because they miss unpublished work, hang legitimate pauses,
change outcomes or supply no safe-close ACK. Use one platform-free engine operation.

### Public operation and result table

Add `RunHandle.depart(): Promise<RunDeparture>`:

| Result | Engine guarantee | Surface action |
| --- | --- | --- |
| `{ kind: 'detached', moneyDurability: 'durable' \| 'uncertain', effectNeedsAttention: boolean }` | Acknowledged local paused detachment, host-using joins and ownership cleanup complete; required receipt disposition is final. | End this iterator, preserve the acknowledged local pause, classify the final receipt disposition, then close the host. |
| `{ kind: 'continue' }` | Attached execution has real progress to consume, or a running node still owes its existing outcome. | Consume the same primary stream and render its real progress/later pause/terminal. |
| `{ kind: 'closed', moneyDurability: 'durable' \| 'uncertain', effectNeedsAttention: boolean }` | Actual terminal/fenced execution has finished all permitted host-using work; required receipt disposition is final. | Join the independently progressing primary reader, preserve existing terminal durability/error, classify the final receipt disposition, then close. |

No caller-supplied sequence, decision, checkpoint or amount authorizes departure. The engine uses
its acknowledged pause episode and the primary consumer's actual cursor. Unconsumed advancement
beyond that episode returns `continue`; it cannot be hidden by returning the earlier pause.

Verified checkpoint admission may establish a handle-owned pause episode without emitting a new
`run:paused`, including media-only resume whose poll remains pending. That episode belongs to the
new admitted execution, not the previous handle. No event is replayed/invented to call `depart`.
A second resume→pending→departure cycle is supported.

A refused budget preparation or a poll that completes still pending is joined and the same idle
pause is re-evaluated internally. Accepted work is not assumed to owe an event. Re-evaluation waits
for registered completions, avoiding busy-spin, fabricated pauses and a stranded `next()`.
Actual approval, sibling work or terminal retains primary-stream authority.

Concurrent calls share one departure transaction; they never create another primary reader.
Detached/closed completion is idempotent. A detached execution leaves the registry without becoming
terminal; its old `cancel()` is a safe no-op. The final detached claim ends this execution's primary
stream locally, resolving an already pending `next()` with done without inventing a terminal.
It does this only after the cursor has consumed all real advancement. A continued execution keeps
that same reader; do not start a second reader or return its iterator merely to unblock departure.
Later deliberate `resumeFromCheckpoint` uses existing identity/ownership checks, including
same-process resume. Results never replace terminal type, `durability()` or `terminalError()`.
Both host-safe results, `detached` and `closed`, carry the same required receipt disposition:
`moneyDurability` and `effectNeedsAttention`. `continue` has no final receipt verdict. This disposition
does not redefine `durability()`, whose meaning remains whether the terminal write landed, and does
not assert that a locally detached pause is still the latest global state. Successful required-money
persistence (including no required money) reports `durable`; retained refusal/failure reports `uncertain`.
`effectNeedsAttention` is a separate sticky unresolved-effect observation, defined below, not inferred
from money or the terminal. No required receipt error is lost merely because a real pause remains
unchanged instead of progressing to a terminal. No request, quote, receipt body or underlying store
cause enters these fields. Concurrent/idempotent calls share the final disposition; catching/joining
an operation cannot consume and erase it.
The common receipt fields never suppress existing fatal ledger/conservative-failure or abort work.
Such accepted actors and their real writes/outcomes still veto an unchanged paused claim and progress
through the same primary reader. Current required-money faults normally reach `closed`; this proposal
does not assert a new shipping money-only detached schedule or turn fatal work into exit3. Any actual
host-safe detached result still reports its final receipt facts; the unchanged-pause failure acceptance
below specifically requires the independently permitted effect-child case.

Invalid invocation uses the existing engine-state boundary; no new durable ErrorCode.

### Joining work without dropping receipts

Register accepted producers/continuations before their first async handoff. Include scheduler,
outcome handlers, gate preparation/claim/timeout, node/run deadlines, media polling/pin/accounting,
ordered writes/delivery, money/effect receipts, media-reference operations and ownership/heartbeat.
Join transitive work to quiescence, not just an append-tail snapshot, running-node map or settled flag.

New-work continuations recheck captured execution/dispatch retirement **before** entering pin/CAS,
media access, save-to, egress, effect prepare or paid admission. An executor resolving after terminal
cannot newly enter pinning merely because a later save-to guard would refuse it.

ADR-0085 §5's allowed effect settle/proven discard and incurred-charge ledger receipts remain allowed.
Define their observable lifetime through structured receipt work, not retained function reachability:

- Before invoking either `NodeExecutor.execute` or `BudgetDispatchPreparation.execute`, the engine
  synchronously registers an invocation lifetime slot, then adopts the **exact raw returned Promise**.
  A synchronous throw closes the slot through the same error path. Settlement releases only the original
  context's future receipt-entry authority; every already entered operation remains joined. Winning an
  abort/grace race is not settlement of that raw Promise or its lifetime slot.
- Add platform-free `NodeExecContext.continueReceipt(operation)`. It registers a child scope
  synchronously **before** invoking its factory. The factory receives a scoped `NodeReceiptContext`
  with only the existing correlated money record/join port, effect settle/discard methods
  (no effect prepare), the existing cost-update fold capability,
  and the same structured child-registration method. It has no provider/key/media/prepare authority.
  Its Promise resolution/rejection is its positive no-future-entry ACK. Independent registered scopes
  retain their own authority when their enclosing executor has settled.
- A receipt continuation that will outlive execute must be transferred through this factory before
  execute settles. Nested transfer must occur before its current receipt scope settles. Registering
  new receipt work after that boundary refuses through the existing engine-state boundary. Captured
  ports check their scope on each entry; an ended scope cannot start another host call.
- Engine-created media/outcome/ledger/reference continuations use the same registry internally.
  Completing or transferring one scope never implies that other scopes or their entered operations
  completed. Rejection closes its future-entry authority but is retained by the existing appropriate
  money/effect/retention error path; cleanup never hides it. No-receipt executions finish when the raw
  executor and all entered work settle; no garbage-collection or explicit release call is required.

This is a strengthened executor compatibility contract: settling execute acknowledges that its
untransferred receipt-producing work is finished. Detached background work holding the old context
is unsupported, rather than an unobservable exception to host safety. All shipping executors and
custom executor doubles need this contract checked; promise registration cannot prove a dishonest
factory's future intent. Previously incurred receipts must be transferred and completed, never
revoked simply because terminal publication won. A never-settling raw executor or registered receipt
scope retains its original receipt authority and can hold graceful close indefinitely.

Do not drop actual usage/receipts, reopen presented run totals, refund uncertain charges or classify
cleanup as another terminal merely to make departure fast.

Terminal publication retains bounded executor abandonment. It is not changed into an await of
arbitrary executor promises. `depart` after terminal/fenced closure separately joins host use:
media-reference record/reclaim promises, entered pins and permitted late receipt continuations.
Best-effort retention failures stay best-effort rather than becoming money-durability failures.

**Graceful host release can wait beyond terminal publication.** A noncooperative executor that
still holds a permitted receipt capability keeps this join pending. The real terminal remains
observable on time; CLI shows that terminal and pending graceful cleanup while retaining SQLite/MCP.
No invented timeout closes beneath a writer. This explicitly preserves ADR-0085's receipt policy,
rather than claiming bounded resource termination. Existing force-exit/crash is outside graceful
departure and supplies no cleanup certificate.

### Receipt-only ownership after terminal publication

Choose **retained exact-fence ownership while admitted receipt authority remains**. Do not reacquire
an already terminal execution, omit its fence, or add an unfenced money/outbox exception. This refines
ADR-0079's release-on-pause/terminal timing and ADR-0085's late-incurred-receipt promise explicitly.

Outcome settlement and host/receipt settlement are different internal phases. Publishing the real
terminal remains bounded by existing executor abandonment and already-entered money barriers. It
retires all new-work authority and closes the primary stream as today, but it does **not** mark the
ownership `done`, remove the execution's in-process registry entry, stop receipt-only heartbeats or
delete its lease while a registered raw/child receipt scope or entered host operation still owes
work. The same applies at a pause: publish the real pause, but retain its lease while such work is
owed. Once genuinely idle, ordinary no-receipt pauses still release promptly and remain resumable.
Read-only status/log access is unaffected. A competing resume can legitimately remain refused while
this local execution still owns required host use; a pause or terminal notice alone is not release.

The retained claim keeps the existing 60-second TTL, 20-second heartbeat and store-side exact
`(ownerId, generation)` check. Receipt-only heartbeats may run after outcome settlement and during
provisional quiescence; they authorize no provider, polling, prepare, save-to, outcome or new-work
admission. Register and join their entered host calls. Stop admitting further heartbeats only when
all receipt-producing lifetimes have ended and all their entered work is joined; join an already
entered beat before exact-fence release. Generation checks must stop a queued old beat/release from
renewing or deleting a later claim. A never-settling scope deliberately retains this ownership and
graceful host join indefinitely; it does not postpone actual terminal publication.

A scoped, already-incurred `cost:attempt_settled` uses the **same ordered durable writer**, stamped
sequence source and compare-and-append/fence transaction as ordinary money. Its receipt authorization
is separate from retired outcome/new-work authorization and exists only while this execution still
proves that retained claim and the registered scope remains active (or the host call already entered).
The terminal and subsequent receipt asks remain one ordered tail: the **acknowledged successful**
terminal append advances the writer's durable-head expectation before any later guarded money ask.
If that terminal write has no successful persistence ACK, select the refusal boundary below instead;
an ordered tail alone cannot make a failed terminal durable. Accepted post-terminal money rows
update the existing exact attempt ledger and telescoping money projections without
changing terminal status, tokens, its published payload or the primary stream. Do not emit another
`cost:updated`, reopen a displayed total, dispatch work, or mint a conservative admission. Accepted
writes still follow normal persistence-before-delivery; closing the terminal-driven primary means
it receives no later ledger event, while passive ledger observers/history may see the actual append.
No second writer, separate sequence or durable event/schema/migration is introduced.

**An uncertain terminal blocks every subsequent run-event append by this execution.** If terminal T
fails or loses its persistence acknowledgement, preserve its original identity and existing terminal
outbox behavior. Until this execution retires, refuse any later run-event ask, including an incurred
money receipt R greater than T, without writing or advancing the durable head. A recovered store or
retained exact fence does not lift this boundary. Otherwise R could land against the pre-terminal
head and permanently make original T fail the existing not-ahead guard during outbox recovery.

The scoped money port reports the existing `LedgerDurabilityError`, retains the known incurred charge
and required-money failure while joining, and returns final `moneyDurability: 'uncertain'` on the host-safe result.
An existing conservative obligation keeps its commitment error. Scope completion, consumption of a
join error, or the total event writer resolving never turns refusal into a persistence ACK. Previously
acknowledged receipts stay durable and are not charged again. The one real primary terminal and its
uncertain terminal durability remain visible; no replacement terminal or successful receipt is invented.

Do not wait for an outbox drain that needs this execution's retained lease, force an additional terminal
retry inside the receipt path, renumber T, drop its fence/not-ahead guard, or create a second writer or
money outbox. Join all registered scopes and entered work, then release the exact lease normally.
The existing public outbox drain can subsequently recover T under its original sequence and new
legitimate recovery ownership; no later local run-event append has poisoned its ordering. Lost terminal
ACK and failed outbox writes retain ADR-0078's existing uncertainty/recovery limitations, not a new
guarantee of recovery or receipt persistence. Effect settle/discard retains its separate correlated
journal contract. This intentionally trades late-money durability under a terminal-write fault for
preserving fencing and existing terminal recovery; no faulted receipt is silently reported durable.

Retain each required-money failure independently of the consumable `MoneyDurability.join()` error.
Money append must return an internal actual-persist/refusal/failure acknowledgement to its money
caller: the total ordinary event writer resolving, or a scope Promise settling, is insufficient.
The money port observes a refused/faulted append as the existing `LedgerDurabilityError`; a required
conservative write keeps its existing commitment error. At final host-safe completion, `detached` or `closed`
reports `moneyDurability: 'uncertain'` if any required money receipt was not acknowledged persisted,
even if a port caller previously caught/consumed that error or terminal persistence was durable.
Receipt scope rejection retains the same money/effect error categorization; best-effort media
retention does not become a money failure. No raw store cause enters the result or diagnostic.

### Final effect disposition independent of terminal outcomes

Retain a per-execution sticky `effectNeedsAttention` observation at the **scoped effect journal port**,
before tool cancellation precedence, a caller's catch, or settled-node/run outcome suppression can
consume it. The same wrapper observes prepare acknowledgements and owns every allowed settle/discard
operation in raw executor, registered child and engine-created receipt scopes. Registering a generic
child Promise alone is insufficient; raw settlement acknowledges lifetime, not effect resolution.

- A successfully acknowledged, non-replayed `prepare: proceed` establishes a local pending obligation
  for its existing `EffectIdentity`: the engine-bound `effectScope(correlation)`, slot and resolved
  tool id. Record it before returning the acknowledgement to dispatch. Keep only this correlation
  and tier, never args, provider content or the result. No invented occurrence id, new durable row,
  final history query or second effect authority is introduced. A `replay` acknowledgement establishes
  no new pending obligation and must not settle or redispatch the already committed row.
- Pending is not immediately sticky attention. An acknowledged committed settle or proven discard
  for that exact identity resolves its pending obligation; a different scope/slot/tool cannot do so.
  An ambiguous acknowledgement retains attention and is not a proven resolution. Failed operations
  retain the observation below. Removing a pending marker never clears an already sticky failure.
  The existing scoped port and correlated store remain the authority for operation validity and ACK;
  locally matching an identity is not a substitute for a successful store acknowledgement.
- Transfer to a registered child keeps the same obligation alive across raw execute settlement.
  Do not latch attention merely because the parent ended while that child's permitted settle/discard
  or an entered operation is still pending. After **all** raw/child/engine scopes and entered operations
  have joined, every remaining shipping tier-3 obligation retains attention before either host-safe
  result is returned. Observe all successful prepares; interpret unresolved state by the existing tier
  contract. This adds no retry/reconciliation policy for reserved tiers 1/2 and does not claim either
  ships. No new effect prepare is allowed from a receipt child or a retired dispatch.
- This final pending-obligation check covers a successful host dispatch followed by the shipping
  post-dispatch abort guard before settlement, and failures in output mapping/bounding before settle.
  It survives generic/cancelled outcome remapping and ignored late outcomes without depending on a
  settlement operation being entered. A lifetime ACK alone never clears the prepared row. Leave the
  existing journal evidence intact; do not automatically settle it as ambiguous, rerun, discard,
  sweep or query it to make departure finish.
- A settle/discard synchronous throw, refusal or rejected persistence Promise leaves the existing
  correlated journal obligation unresolved. Retain attention before returning the original failure
  to its caller, including `settleCommitted`, `settleQuietly` and `discardQuietly`. Do not inspect a raw
  error string, invoke the store a second time, or convert the failure into a persistence ACK.
- An acknowledged `ambiguous` settlement is itself unresolved attention under the existing effect
  journal contract; a successfully committed settlement or proven discard does not create attention.
  An existing typed `effect_needs_attention` outcome/resume refusal also retains the observation before
  any ignored-outcome boundary. Do not invent an effect from a prepare validation refusal, generic
  executor error, best-effort media retention failure or an unwired journal.
- Once observed, attention is retained through this execution's final join even if the caller caught
  the error or a later local attempt settled. This conservative diagnostic is not a replacement for
  the operator's existing check-target/resolve-row action. No automatic effect retry, resolve, sweep,
  fresh history query or successor write clears it.

Receipt-factory rejection is an end-of-authority ACK, not proof of receipt persistence. If it carries
an existing typed money/effect failure, retain that semantic observation before passing the rejection
to its owner. A rejected generic factory Promise, by itself, proves neither an unresolved external
effect nor missing charged money; it creates no 7/8 flag. Its original rejection remains available
to the factory owner and the existing executor error path. Custom executors must deliver other
failures through their supported NodeOutcome contract rather than treating receipt registration as
a new arbitrary-error/outcome bus. This operation does not promise to reconstruct an unregistered
background failure or change an already published terminal. The concrete scoped-port observations
remain required even when a factory catches or remaps their errors.

This changes the local final-disposition channel, not cancellation or the real terminal. A published
completed/cancelled/failed terminal keeps its type, payload and `terminalError()`; the primary stream
stays terminal-driven and receives no new durable event. A previously consumed terminal can therefore
coexist with final effect attention, including when money is fully durable. `detached` carries the
same flag when registered receipt work settles unsuccessfully without advancing the genuine pause.
No host-safe ACK or final surface verdict is allowed before those receipts and their observations are
joined. All typed producer/port and raw/child paths must be checked; a final DB query or terminal-only
mapper is not the implementation mechanism.

Actual lease loss remains terminal-free/uncertain under ADR-0079. If loss occurs before the terminal
append, never publish a terminal for the successor. If loss occurs after a real durable terminal,
keep that observed terminal; losing receipt authority does not erase it or invent another outcome.
In either case, a previously registered incurred receipt may still enter its scoped local accounting
fold and money port while its scope is live, but the money writer **refuses without any store write**
when this execution is `lost`. Its join surfaces the retained ledger error, final money disposition
is `uncertain`, and the host joins all permitted scopes/entered work before closing. Never reacquire
from the successor, refresh a lost fence, remove the fence, write its ledger, or delete its lease.
Effect settle/discard retains its existing separately correlated effect-journal contract; no effect
prepare is admitted. Required effect receipt observations use the independent final attention channel
above; their original port rejection remains available to its owner. This is not a terminal-error-only
visibility guarantee or a new arbitrary host-error outcome bus.

This is a chosen failure boundary, not a guarantee that a revoked owner can durably record money:
fencing and storage faults can prevent that receipt from landing. Keep the known incurred charge
and its failure while graceful joining is pending, diagnose the missing durability with fixed,
content-free text, and refuse to report persistence. No new crash-recovery money outbox is claimed.
Choose a **new CLI exit 8, `moneyDurabilityUncertain`**, for final
`moneyDurability: 'uncertain'` on either host-safe result. Existing 0–7 meanings stay intact: 5 reports
uncertain terminal persistence, 6 reports terminal-free ownership refusal/loss with its existing retry
guidance, and 7 reports an unresolved external effect. Neither 5 nor 6 implies recovery of a refused money receipt.
This is a CLI compatibility addition requiring the dated ADR-0049 qualification below, not reuse of
an existing uncertainty code or a new shared `ErrorCode`/RunEvent.

Use one final classifier for run/gate/budget resume, including their early ownership/idempotent branches:
first sticky money uncertainty selects 8; otherwise sticky effect attention selects 7; otherwise use
the existing local pause, terminal, terminal-durability and ownership mapping. This explicitly refines
priority when late receipt attention coexists with a previously published completed/cancelled/failed
terminal, uncertain terminal persistence or terminal-free ownership loss. Neither 6's takeover/retry
sentence nor ordinary success/cancellation may hide an unresolved effect. Existing 5/6/7 meanings
are preserved, while attention now wins over 5/6 when money is durable; terminal uncertainty and actual
absence remain disclosed through the diagnostic. Terminal ACK loss alone creates no money/effect failure.
A detached pause with receipt uncertainty remains the acknowledged local pause, but selects 8/7 rather
than ordinary paused exit 3. No warning creates, replaces or duplicates a run outcome. A held scope delays
final receipt disposition and host closure, while the independently progressing primary remains visible.

Exit 8 means **do not automatically re-run paid work to repair its accounting**. Inspect the run log
and recorded money, and verify the external billed/effect state as appropriate. There is no automatic
money recovery, receipt retry, repair command or successor-owner claim. When terminal persistence is
also uncertain, its existing outbox may recover only that terminal; it does not recover refused money.
When an external effect needs attention, retain the existing check-target/resolve-row obligation;
recovering a terminal or inspecting an invoice does not clear that effect.

At final joined host-safe completion with receipt uncertainty/attention emit exactly one fixed-content,
nondurable CLI diagnostic on stderr. Under `--json` its local envelope is
`{type:'diagnostic', code:'money_durability_uncertain'|'effect_needs_attention', message,
terminalDurability:'durable'|'uncertain'|'none', effectNeedsAttention:boolean}`. The final classifier
chooses the code: exit 8 uses fixed money-warning text; exit 7 uses fixed unresolved-effect text.
Combined money/effect failure emits only the money code with `effectNeedsAttention:true`, retaining
both applicable obligations. The fields come from the same final host-safe result and observed primary
terminal, not a fresh database query or frozen terminal error alone; `none` means no terminal was observed,
including honest local paused detachment, and does not assert takeover. Human mode renders the same
fixed warning plus applicable terminal/effect advice. No uncertainty diagnostic is emitted for the
matching successful-receipt controls. Ordinary pre-existing terminal effect failures continue to use
one final classified warning, not duplicate old/new effect warnings.
This stderr-only envelope is distinct from a pre-run CLI `{type:'error'}` and the stdout RunEvent
stream. It carries no raw cause, receipt body, model/provider input, path or credentials; no new durable
schema is created. All workflow run/gate/budget-resume callers consume this one classified result and
must avoid the current exit-6 takeover sentence for exits 7/8. Local ledger/storage causes remain private.

After all scopes, ordered money/host operations and admitted beats settle, release only the exact
retained claim, then retire this execution and resolve the final host-safe result. Existing release
I/O failure retains the bounded TTL fallback; it cannot authorize a successor write or be counted as
a money persistence ACK. A no-receipt terminal may use the same cleanup immediately, independently
of terminal visibility. No asynchronous owned cleanup remains after `detached`/`closed` resolves.

### Departure transaction

| Phase | Allowed activity | Next step |
| --- | --- | --- |
| Attached | Normal producer/timer/decision admission. | Departure requests provisional quiescence. |
| Quiescing | Suppress new ordinary poll scheduling, keep necessary receipt-only heartbeats, and join accepted work; cancellation, genuine decisions and already-due deadlines remain actionable. | Real progress restores attached consumption; unchanged completion retries the idle claim. |
| Ownership cleanup | Join exact-fence park/release and owed cleanup, retaining cancellation/deadline admission. | Recheck accepted work, local state and absolute clock after every await. |
| Final paused claim | One synchronous turn requires acknowledged idle pause, no unconsumed advancement, no actor/host operation/receipt capability and no owed due deadline. Retire future callbacks and remove the execution. | Resolve detached without another async operation. |
| Terminal/fenced close | Preserve actual ordered terminal/outbox or terminal-free ownership loss; retire new work and join permitted receipts/host calls. | Resolve closed after host-safe completion. |

Node/gate/run/poll/grace/heartbeat callbacks carry execution retirement generation and check it
before host entry. Disarming a timer does not certify an already queued callback. Suppressed future
timers are restored against original absolute deadlines if work advances; overdue deadlines execute
their existing actions. Cancellation accepted before final claim wins subject to existing fencing:
ownership loss stays terminal-free/uncertain, not a fabricated cancellation.

An actor accepted during async release abandons provisional departure and reconciles/acquires
ownership before writing; it cannot reuse a released fence. Old generation release cannot delete
its newly acquired generation. A successor's claim is never stolen, released or written beneath.
A fenced execution is never resurrected to satisfy continue. No async cleanup follows successful
final paused claim, so a held post-claim release cannot hide accepted cancellation before fulfilment.

This claim establishes **local** acknowledged departure, not a global history lock. A genuinely idle gate park
relinquishes ownership; a successor may progress it. A park with admitted receipt work retains its
claim until that work completes as specified above. Void release is not proof that the
old host owns the row. Detached certifies this host safely stopped at its local acknowledged pause,
not that the database remains globally paused when the Promise continuation runs. Detected ownership
loss keeps the existing fenced disposition/exit 6 only when final money is durable and no effect
needs attention; the explicit exit-8/exit-7 priorities above win otherwise. CLI identifies local departure and directs to
status/logs for current cross-process state; no new terminal/snapshot authority is created.

### Parked-node timing and media reattachment

For a restored **parked agent** (budget gate or submitted media), derive the current logical
node life by an ordered fold of validated durable events, then preserve that life's first
`node:started.timestamp`. The reset boundary is explicit:

1. The first start without a retry number (or attempt 1) opens a life. A later such start opens a
   **new** life unless it consumes a pending budget-continuation credit for this node.
2. Each distinct genuine approved budget-gate transition grants one credit. Use the canonical
   suspension reducer's gate/node association and approved transition; compatibility companions
   neither mint a second credit nor replace its basis. The next non-retry start consumes that credit
   and keeps the current life start. That credit cannot authorize a still later crash restart.
3. A validated retry start (attempt greater than 1) keeps the life start and obeys its actual preceding
   retry transition. Media submission/pending reattachment emits no new start and keeps the basis.
   A node terminal closes its life and clears pending credits.
4. A later non-retry start with no fresh approved transition is the running-crash restart boundary.
   Therefore start T0, running crash, fresh restart T1, then park at T2 derives T1. Subsequent genuine
   budget approvals and retries preserve T1; a second genuine running crash opens a new life again.
   Missing starts, unresolved/ambiguous gate association, invalid retry order or invalid timestamp
   basis refuse through existing checkpoint admission. Do not guess earliest/latest across all history.

Carry this derived basis in checkpoint state and rearm `agent.timeout_ms` before dispatch/poll.
Advance the derived checkpoint schema version and rebuild old cached derivations from the durable
log; an older cached checkpoint cannot bypass the new fold or silently acquire a fresh basis.
The accepted-budget fold must work with both typed authorization and supported legacy budget
transitions without joining ordinary human-gate companions to a quote. A crash between approval and
its next start still consumes that one continuation credit; no running attempt began in that gap.

This refines ADR-0085's currently missing parked-resume timing. Durable start may count time
awaiting its append before today's in-memory timer arms; choosing this conservative basis is
deliberate. An expired node uses fatal `run_timeout` before new provider submission/paid polling.
Run/gate/job absolute bases and earliest-bound composition remain. Genuinely running crash attempts
retain the documented fresh-attempt restart policy. No new persisted field/event/migration is needed.

Durable run-wide `nodeDispatches` survives; node retry/attempt numbering still resets on checkpoint
resume/budget approval. No new stable retry counter is promised. Frozen allowance, per-attempt charge
and media accepted-cost bases retain their homes; process-local allowance remainder is not restored.

Join an entered bounded media poll and permitted pin/accounting continuation. A pending result can
detach the same pause without another event; advancement is consumed. Retain the provider-bound job
and cost basis: no resubmission, extra charge, refund or lost result as a departure shortcut.
Successful handoff stops local scheduling; explicit resume reattaches the same job and checks the
original node/run/gate/job deadlines. A departed host is not a daemon or background monitor.

### Surface input acknowledgement

Release CLI input without an irreversible summary before final paused departure. Actual Clack
acknowledges release by abort **and settlement of the underlying prompt**, not merely wrapper-race
completion. Where settlement is not the release ACK, the private GatePrompter/renderer contract
must expose a separately awaited release capability. An injected prompter ignoring abort is not
certified released because its wrapper returned.

Ink input release requires successful unmount and `waitUntilExit`; retain its instance/capability
until that ACK. A throw before release is not an ACK. If release completes but a cosmetic follow-up
fails, keep the explicit ACK and diagnose that failure separately. An input-free renderer may ACK
immediately. Unacknowledged release retains resources/SIGINT and a loud diagnostic; it cannot
pretend transfer or skip engine joining. No forceful TTY termination is introduced into core.

The CLI keeps **exactly one primary event reader** progressing independently of input-release
ACKs and the departure Promise. Start/retain that reader before invoking `depart`; do not implement
`await depart(); then drain`. It continues folding real ordered progress, decisions and terminal
while quiescence/receipt joining is pending. The reader's cursor remains the engine's real consumed
cursor. A passive observer may invalidate input, but never chooses the outcome.

Presentation is mode-specific and preserves ADR-0049. **Ink** can show an immediate provisional
human terminal notice with cleanup pending, then its one persistent human summary after joining.
**Plain** renders each actual event once through the existing line renderer; it adds no second terminal
or post-join stdout summary. **NDJSON** immediately serializes each actual primary RunEvent once in
sequence order; the real terminal remains its sole final stdout result line, with no synthetic notice,
wrapper, duplicated terminal or summary. Plain/NDJSON cleanup, ownership and receipt diagnostics belong
on stderr. Pending-cleanup diagnostics under NDJSON use the same local `type:'diagnostic'` channel with
fixed `code:'cleanup_pending'` and fixed `message`, not a RunEvent or final money verdict.

SQLite/MCP and SIGINT remain held until the host-safe ACK. A held input release cannot stop the primary
fold or conceal its real terminal; use the released human renderer when available, otherwise the
specified stderr diagnostic while the one reader progresses. Terminal-free primary closure emits no
terminal or fabricated stdout result; only the truthful local ownership/cleanup diagnostic. The final
exit waits for input and host-safe joins on every mode, even though terminal visibility does not.

A pending primary `next()` is permitted at stable pause: detached ends it locally as above.
Continue reuses/remounts the same view and reader; closed joins that already draining reader and
existing durability/error disposition. Concurrent departure calls share the same transaction and
cannot duplicate consumption, notices or the final summary. This preserves the existing bounded
primary stream; do not add an unbounded second event spool.

SIGINT remains owned until input ACK and final engine departure claim, or real closed outcome
drain/join. Before either barrier it requests existing cooperative cancellation; after successful
local departure the old handle accepts no work. Finalize Ink's one persistent human summary for the actual local outcome; plain/NDJSON do not add a
stdout summary. Cosmetic failure never selects or fabricates an outcome.

## Acceptance and landing

1. Native command controls hold renderer release, node failure, terminal append, decision ACK and
   genuine host sweep separately. No pending writer outlives SQLite. Reject/autoapprove report
   actual terminal; stable human/budget pauses return 3 and remain resumable.
2. Core controls cover fresh pause, media-only checkpoint without a new event, repeated pending
   reattachment/departure and mixed siblings. Deferred refused preparation/pending polls do not
   invent events, spin or leave departure dependent on a nonexistent next event.
3. Hold record/reclaim, entered pin and late permitted money/effect receipts after terminal/fence.
   Host-safe completion waits for settlement; late abandoned execution cannot newly enter CAS/pin/
   egress/prepare. A forever-held receipt keeps only host-safe join pending, with bounded terminal
   publication still observable. Hold a registered receipt **before its first host entry**, settle
   its enclosing execute, publish and consume terminal, assert the retained exact lease and receipt-only
   heartbeat, then release it: the actual native SQLite `cost:attempt_settled`/`run_costs` receipt lands
   before host close and exact lease release. Check ordered guard head includes the terminal, unchanged
   terminal/presented totals and no new work. Fence the same held scope before first entry, including
   successor acquisition then release: no losing store write/reacquire/deletion occurs, join raises the
   ledger refusal, and final `closed.moneyDurability` is uncertain even after that error was consumed.
   Repeat ordinary store failure, conservative failure, multiple/nested scopes and no-receipt completion;
   a resolved event writer or scope alone must never prove persistence.
   Hold a registered receipt before its first host entry, fail only terminal T's store append, confirm
   its existing outbox write, recover the store, then release the receipt. Both native SQLite and
   reference-store controls require ledger refusal, sticky final money uncertainty and no later R row
   or ledger write. After host-safe lease release, invoke the actual public outbox drain and require
   original T's successful persistence/removal with unchanged identity and no stale-order rejection.
   Pair this with the successful-terminal/later-receipt control above. Separately cover lost terminal
   ACK, failed outbox write, multiple late receipts and an earlier acknowledged receipt; no fault path
   may hide the observed terminal, double-charge earlier money or claim invented recovery.
   Check no-receipt execution, completed/rejected receipt, nested transfer, duplicate/reentrant calls,
   and refusal of unregistered post-settlement entry without claiming that refusal preserves a receipt.
   A never-settling raw execute remains separate from the settled abort/grace race.
4. Advance node/run/gate/job clocks during joins and after reconstruction. Node expiry is fatal
   before dispatch/poll. Compose running crash T0 → fresh restart T1 → budget/media park → departure
   → reattachment, and check expiry on both sides of the T1-based deadline. Retry and repeated
   genuine approved budget redispatches preserve T1; consumed companion/credit cannot extend it.
   Include crash after approval but before start, subsequent running crash, legacy association and
   ambiguous-history refusal. Resetting attempt numbering remains separate from logical node life.
5. Genuine decision/cancel/autoapproval and queued callbacks preserve authority. Hold old release
   across a new local generation/successor acquisition and prove no successor deletion/write.
   Cover successor progress, completion/release and takeover; local departure is not global status.
6. Hold underlying Clack release after wrapper abort, throw before Ink ACK, and inject SIGINT before
   input ACK and on both sides of final synchronous claim. No fictional ACK or duplicate summary.
   Real OS signals retain Windows qualifications; synthetic input/callbacks do not prove TTY/expiry.
   Hold a permitted receipt indefinitely and prove actual native CLI terminal/cleanup-pending output
   from the primary reader before departure resolves, both before and after input ACK; host remains
   open and final summary remains unwritten. Repeat terminal-free fencing and stable pause with an
   already pending next(). Release the hold and require one correct Ink summary and one host close.
   Repeat actual native commands in Ink, plain and NDJSON. Held input/receipt joins do not delay or
   duplicate the real terminal; each JSON stdout line validates as its actual RunEvent in sequence
   order and the terminal remains final. No extra plain/JSON stdout summary; specified diagnostics
   stay on stderr, and final exit waits for the same acknowledged host close.
7. Native run/gate/budget-resume controls cover durable completed/cancelled/failed terminals plus late
   required-money failure without a successor; uncertain T plus refused money and later terminal-only
   public drain; terminal-free fencing with and without money failure; and independent **effect-only**
   and **combined effect/money** failures after the real terminal is already consumed. Use the actual
   scoped journal and shipping ToolRegistry paths: reject committed settle, quiet ambiguous settle and
   quiet proven discard; include successful ambiguous settlement, caught errors, cancellation remapping,
   ignored late NodeOutcome, raw execute and nested registered child scopes. Add an actual journaled
   tier-3 `prepare: proceed`, hold a successful host result, cancel through the real grace path and
   consume the genuine terminal, then release the result through the shipping post-dispatch abort
   guard without any settle/discard entry. The admitted row remains prepared, money is durable, and
   joined completion retains attention/exit7 with one fixed diagnostic and unchanged final NDJSON
   terminal. Repeat mapping/bounding failure before settle and combined uncertain money/exit8 cases.
   Transfer an admitted obligation to a held child, end raw execute, then ACK committed/proven discard
   from that child: no premature attention, and no final attention absent another sticky failure.
   A settle for the same slot/tool in a different correlation cannot resolve the obligation; replay
   and known no-row prepare/approval/argument refusals cannot manufacture one. Removing only pending
   admission tracking or its final joined check must break the admitted-no-settlement regression.
   Before release, terminal visibility remains bounded while host-safe result/host close remains
   pending. On release, the final
   effect flag must survive even when `terminalError()` stays unchanged; no second terminal or DB query.
   Pair committed/proven-discard successes, unwired/prepare-only/generic-error/media-retention controls
   and genuine unchanged pause with late receipt failure followed by `detached`. Require exit 8 only for
   sticky money uncertainty, otherwise 7 only for retained unresolved effect, otherwise existing 3/5/6
   and terminal controls. For combined 5/6+effect or money+effect, assert exact diagnostic priorities,
   terminal-durability/attention fields, fixed nonretry advice, actual terminal/pause/absence and no false
   takeover claim. Consume-once joins/caught errors cannot erase either final observation; earlier ACKed
   money is not charged again. Each assertion-removing effect-port observer or final-disposition forwarding
   must break its actual effect-only and combined regression. No automatic rerun or paid call.
8. Removing registration, transitive joins, retirement checks, checkpoint-pause admission, no-progress
   retry, original node basis or exact-fence cleanup separately breaks the matching regression.
   Strict types, engine purity, vendor seam, full CI and coverage pass; no new live/paid call.

Land lifecycle/API in the canonical engine contract, link runner contracts, and update CLI/private
input-owner contracts. Append dated notes to ADR-0036/0042/0045/0049/0076/0077/0078/0079/0080/0085/0097/0100
where their lifetime/derived timing or CLI output/exit interpretation is affected, preserving accepted
bodies. Canonical CLI commands own the new exit-8/remedy/diagnostic contract; link instead of copying
it into unrelated specs. Extend all existing exit-code/machine-output callers and tests explicitly,
preserving 0–7 meanings while explicitly qualifying combined-effect priority, and preserving the stdout
RunEvent schema. Update review/W7/PR
with actual fixes and remaining approvals. Proposed permits drafting/review only; no dependent code
before maintainer approval.

## Consequences

- A new CLI exit 8 and nondurable stderr diagnostic distinguish missing required-money durability
  from terminal-outbox uncertainty, retryable ownership loss and unresolved effects. Existing
  automation clients must handle the additional nonretryable code; stdout event shape/order stays
  unchanged. Ink keeps its one human final summary; plain/NDJSON add none.
- Explicit safe local departure includes reattached media and a separate terminal/fenced host join.
- Receipt and unpublished-writer authority survives teardown. Terminal liveness and graceful host
  release remain distinct; permitted receipt capabilities can hold the latter indefinitely.
- RunHandle gains one method/result with receipt disposition on both host-safe branches, and
  NodeExecContext gains structured receipt registration;
  all implementations/doubles/surfaces need compatibility coverage.
  Derived parked-node timing becomes conservatively stronger.
- Registration, provisional ownership release and input ACK require deterministic held-port/ACK/
  generation controls. Receipt-only retained ownership delays competing resume while required work
  remains; revoked/faulted money receipts remain an explicitly diagnosed uncertainty, never silent success.
  A terminal without persistence ACK refuses later run-event receipts so ordinary terminal-outbox
  recovery retains its ordering; graceful joining does not guarantee those faulted receipts landed.
  No provider cancellation, runtime dependency, platform import or daemon.

## Maintainer-review clarification — 2026-10-08

This dated clarification supplies the missing primary-consumption mechanism and qualifies the
proposal above. **Status remains Proposed; no dependent lifecycle implementation is authorised.**

### The handle owns the observable primary cursor

Implement a private, engine-readable publication/delivery record owned by this execution's
`RunHandle`, wired at construction to its one `BoundedEventStream`. The record observes each real
primary publication before offering it to the queue. A separate delivery marker advances only
when that queue actually returns an event with `done: false`: both a buffered pull and a direct
handoff to an already waiting `next()` update it synchronously before resolving the pull. Calling
`next()` without receiving an event, passive `subscribe` delivery, iterator `return()` and queue
closure do not acknowledge consumption. This records delivery to the primary reader, not completion
of its renderer or arbitrary asynchronous work; surface input/presentation ACKs retain their separate
obligations. No caller-supplied cursor, second iterator, public acknowledgement method or durable
event/field is added. The API details land once in the canonical lifecycle home on implementation.

The acknowledged pause episode binds to that same publication record. A verified checkpoint pause
initialises a new execution's episode without pretending that prior history was delivered to its
primary. Final paused claim requires the real primary delivery to cover all this execution's
published progress, including its pause when one was emitted. Available but undelivered events
return `continue` for that same reader to consume. Accepted actors/registered work still veto the
claim independently of these markers; consumption cannot certify an unpublished writer or an
unfinished receipt. Check the markers and actor/deadline conditions together in the final synchronous
claim, and re-evaluate after every asynchronous join.

Track queue refusal/gaps and early consumer abandonment explicitly. In particular, the existing
never-pulled overflow path can decline an event while `bufferedCount` stays bounded: do not infer
consumption from emitted minus buffered, from a latest delivered sequence alone, or from an empty
queue. A gapped/abandoned primary cannot certify paused detachment; refuse that invocation through
the existing engine-state boundary rather than return `continue` for an event the queue cannot
deliver. Such refusal certifies no safe host close and retains the existing cancellation/join
obligations. Actual terminal/fenced closure keeps its separate host-safe `closed` join. This does not
implement replay, manufacture a resync ACK, add a replacement event spool or close ADR-0087 §1's
separately scheduled never-pulled-stream defect.

Add causal controls for buffered and waiting pulls, passive-only observers, invocation before the
first pull, a never-pulled overflow, early iterator return, verified media-only checkpoint pause,
progress during a held join and stable pause with a pending `next()`. A refusal/gap must never look
consumed; a pending pull without an event must not advance the marker; checkpoint admission must not
invent publication. Removing the delivery observation or gap/abandonment observation independently
must break the corresponding claim/refusal control. These are required implementation tests, not
tests executed by this documentation revision.

### Local detachment is an explicit terminal-invariant qualification

This decision would extend [ADR-0036's exactly-one-terminal and terminal-driven iterable invariant](0036-run-loop-substrate-event-bus-and-execution-host.md),
following [ADR-0079 §5's fenced terminal-free close](0079-cross-process-run-ownership-lease-and-fencing-token.md#5-a-fenced-out-in-flight-run-stops-without-claiming-an-outcome).
Acknowledged `detached` closes only the old execution's local primary stream at its verified pause.
It does not terminate the logical run, publish a durable terminal, or change the terminal invariant
for an actual run outcome; a legitimate successor may resume that paused run. `closed` continues to
describe the actual terminal/fenced branch. Consumer abandonment alone is neither departure nor
this carve-out. On approved implementation, append a dated qualification to ADR-0036 and ADR-0079
and document the distinction in the canonical lifecycle home; the Accepted bodies remain intact.

### One future CLI contract, no second schema owner

The proposed diagnostic envelope above is decision-review detail, not an already active wire
contract. [CLI commands](../reference/cli/commands.md) will own its one normative envelope, exit
priority and remedy definition when the approved implementation lands. The stdout RunEvent union
keeps its existing separate home. Lifecycle and runner contracts link to the CLI definition rather
than reproduce the stderr envelope; this clarification adds no schema copy or new durable event.
The acceptance text's spacing/line-wrap corrections are editorial only and do not change the
specified money-before-effect priority or any 0–7 meaning.


## Maintainer approval — 2026-10-08

The maintainer approves this decision in its latest reviewed form, including the dated
2026-10-08 clarifications, and authorises dependent W7 implementation on `development`.
Earlier Proposed/unauthorised statements above describe the proposal history; this approval
opens the implementation gate. Acceptance still requires the specified implementation,
causal controls and fresh independent review rounds; approval alone does not close W7.

## Scoped append/receipt integration — 2026-10-09

The W7 implementation candidate adds actual per-append acknowledgement, terminal-head
advancement and sticky post-uncertain-terminal refusal. Exact raw executor/prepared-executor
promises, structured receipt children and entered money/effect/media-reference operations retain
their registered lifetimes and the same fence while owed receipts remain. A synchronous native
retention callback keeps its actual synchronous semantics. Lifetime observation does not consume
the money barrier's retained error or certify durability.

The canonical rules land in [shared-core-engine.md](../architecture/shared-core-engine.md#internal-departure-foundations-adr-0103)
and [execution-model.md](../architecture/execution-model.md#per-append-acknowledgement-and-late-incurred-receipts).
The engine always supplies structured receipt registration; its context field remains optional
for standalone context implementations/doubles. This candidate requires full checks and two
fresh independent review rounds. It does not implement public departure, complete actor and
transitive-provider retirement, final effect/money disposition, parked-node clock derivation or
acknowledged CLI input/host teardown, and does not close the lifecycle High or W7.

## Scoped raw provider and native producer lifetime checkpoint — 2026-10-09

This W7 increment transfers execution-local receipt entry from AgentRunner to the fallback
chain and the separate generative-media submission. The exact generate, verifier `next` and
independent timeout/final `return` Promises enter before their bounded races. First stream
construction occurs inside that first entry, so a refusal records no provider invocation.
Retainer refusal
preserves host provenance; synchronous provider faults retain their classification, and one
existing attempt observation remains the money authority. Private identity recognition does
not inspect a throwable's prototype. No callback becomes request or durable data.

The CLI process host checks cancellation at native entry after executable/cwd resolution.
It retains a created child's local lifetime until actual native `close`, including failed spawn,
instead of treating `error` as a closure acknowledgement. Real child controls cover cancelled
resolution, actual failed spawn and fault injection on a running native child. Fault injection
is not an OS-generated kill-failure reproduction.

The normative behaviour is in the [provider seam](../reference/shared-core/llm-provider-seam.md#the-per-attempt-deadline),
[runner contract](../reference/shared-core/agent-runner.md) and
[native host contract](../reference/shared-core/tool-registry.md#native-process-completion).
Permanent controls also include actual installed OpenAI SDK body demand with a held raw read,
inline and separate-endpoint media submission, exact Promise identity, independently held
cleanup and pre-egress host refusal. This increment requires committed checks and two fresh
independent review rounds. It does not certify transitive SDK/HTTP/MCP transport work, complete
engine actor retirement, final receipt health, parked clocks, public departure, acknowledged CLI
input/host teardown, Step 8 or W7.


## Raw stream consumer-return correction — 2026-10-09

The first complete raw-provider review independently reproduces a cleanup-only lifetime-entry
refusal swallowed by explicit public iterator `return()` after text or confirmed stop.
The post-`finally` handler is bypassed by that abrupt generator completion. The correction
handles the refusal inside `finally`, emits exactly one attempt observation with any already
confirmed usage, and propagates the original host cause. Existing provider/deadline failures
retain precedence. Two permanent public-return regressions fail before this correction;
scoped independent acceptance and the full host-departure decision remain separate gates.

## Scoped HTTP producer lifetime checkpoint — 2026-10-09

The next separately reviewable increment supplies execution-only `ToolHostCallOptions`
from actual agent dispatch to the HTTP/search builtins and the CLI text-egress host. A
whole credential/request producer, its raw DNS/connection/body operation and created
native request/response close are independently registered before their bounded waits.
Pre-aborted entry and a cancelled late DNS answer refuse fresh native I/O. A post-entry
host refusal preserves its exact cause and observes the abandoned header Promise while
actual close remains owed. A private tool-local marker carries host refusal through registry
classifiers; exact original identity and observer provenance are restored before model recovery,
without reflected throwables or diagnostic events. Genuine synchronous tool factory errors
remain ordinary tool failures. URL/IP/port/header/redirect policy and the original receipt,
money and effect authorities remain unchanged; no hook becomes durable or model data.

The canonical contract is [HTTP producer completion](../reference/shared-core/tool-registry.md#http-producer-completion).
Permanent controls include real local native headers, finite body and connection failure,
opaque pre/post-entry refusals, exact raw timeout ownership and actual shipped HTTP
agent/registry workflows on reference and SQLite hosts. These are local/native and
synthetic workflow controls, not new live provider captures. The candidate requires its
own committed full checks and two fresh cumulative review rounds. MCP transitive
transport sends/readers, media/poll retirement, all engine actors, final receipt health,
parked clocks, public departure, CLI acknowledgement, Step 8 and whole W7 remain open.

### 2026-10-09 — invocation-local provider and raw-poll integration checkpoint

The next implementation increment transfers the controlled OpenAI-compatible SDK invocation
lifetime before SDK construction and binds it into that client's fetch closure, with no ambient
shared scope. Its optional behavioural provider argument is an additive seam extension; the
[canonical provider seam](../reference/shared-core/llm-provider-seam.md#the-per-attempt-deadline)
owns the shape. Request-data ownership, cap authority, retry policy, SSRF/TLS admission, opaque
job identity and provider-bound media accounting are preserved.

The same invocation owns generate, lazy stream, separate image/speech/video submission and
Sora status plus binary download. Raw SDK operations, body reads/returns and native close
acknowledgements remain independent of bounded public outcomes. Retirement prevents new entry
and parameter learning/retry; call-time lazy-stream authority and per-invocation fetch closures
keep siblings separate. Before-entry host refusal invokes no SDK; a post-transfer refusal keeps
its original identity outside SDK classifiers while completing only the empty admitted scope.

Validated fetch independently transfers normalization/DNS and a body child before eager Web
Streams pull, preserving actual next/return/native completion after public cancellation.
The engine also owns each exact raw poll and its credential resolution, forwarding a poll-local
hook independently of the already-settled submission context. Late poll completion cannot pin
media or settle cost again. This checkpoint does not claim that arbitrary foreign ReadableStream
hidden producers or official Gemini native transport are exposed by the same rail.

Implementation, strictly built causal checks and two NEW complete independent review rounds
must precede scoped acceptance. MCP, all scheduling/accounting actors and generations, sticky
final health, original parked clocks, public departure and acknowledged CLI teardown remain
open. Step 8, Step 12 and all six W7 register items remain open; no whole-wave acceptance follows.

### 2026-10-09 — scoped MCP transport and protocol descendants

The approved lifetime rail now reaches discovered tools and `mcp_call` through the optional
trusted tool-host argument, preserving existing fewer-argument implementations. One initialized
SDK Client/session owns request-local HTTP lanes, identity-bound legacy SSE POSTs, infrastructure
GETs, independent cancellation sends and queued peer handlers/replies. Native Promises and raw
fetch/body/native-close descendants remain independently owed after bounded caller completion.
Retirement vetoes new ordinary entry and reconnects without suppressing already incurred cleanup.
Incoming peer IDs cannot replace a still-pending response or mint outgoing request authority.

Concurrent/reentrant close publishes one exact join before transport callbacks. Partial lane
failure retains cleanup and its opaque first fault. Stdio/WebSocket cleanup requires positive
native-close acknowledgement; acknowledged child PIDs disappear from current reap views instead
of remaining available as stale kill targets. The unchanged SSRF, TLS, redirect, ingress bounds
and fail-loud discovery policies retain their existing owners. No new dependency, durable field
or shared ErrorCode is introduced. [MCP integration](../reference/shared-core/mcp-integration.md#invocation-and-transport-lifetimes)
owns the detailed contract; [tool registry](../reference/shared-core/tool-registry.md#the-toolhost-capability-seam)
owns the platform-free capability shape.

Permanent controls cross installed SDK HTTP/SSE/stdio/WebSocket paths and public Core/reference/
native SQLite workflow paths. Synthetic held tails are distinguished from actual native close.
The implementation still requires its own committed full checks and two NEW complete cumulative
independent review rounds. Complete manager startup/all-actor retirement, sticky final receipt
health, parked clocks, public departure and acknowledged CLI teardown remain open, followed by
Step 8 and final Step 12. This scoped checkpoint does not close W7.

### 2026-10-09 — unused MCP peer reservations are revocable

[Two complete cumulative first-round reviews and fresh Parent runtime evidence](../reviews/2026-10-09T08-33-00-w7-mcp-lifetime-round-1-review.md)
correct the preceding implementation checkpoint. Installed SDK task/schema rejection can bypass
the registered handler while cancellation/close suppresses its reply. An unused queued
reservation must be revocable without inventing an entered producer. Actual handler, send,
body and native-close descendants remain owed; a stale aborted callback cannot claim a later
request reusing its ID. Synchronous abort/entry refusal must observe the deadline guard;
body-disposal refusal must settle the waiting reader. The canonical
[MCP lifetime contract](../reference/shared-core/mcp-integration.md#invocation-and-transport-lifetimes)
records these refinements. Nineteen regressions and stronger existing controls restore the
unchanged mandatory coverage floor. A NEW complete cumulative second round is required;
remaining host obligations, Step 8, Step 12 and W7 stay open.


## 2026-10-09 — Second MCP review: retire even a refused empty start

Both complete cumulative round-2 reviews reproduce a pre-aborted public stdio open that
never enters SDK connect. Client-only cleanup has no attached transport, leaving the unused
PID sampler and child registration retained. Failed-connect cleanup now independently starts
the idempotent native owner close. This applies the existing proved-empty-start rule;
entered resources still require actual native acknowledgement and admitted-work completion.
A new permanent regression and root CI/enforced coverage pass. A NEW complete cumulative
round 3 remains required; this correction does not accept manager startup, all-actor host
retirement, public departure, Step 8 or whole W7. Evidence and native/source distinctions are
in [round 2](../reviews/2026-10-09T09-07-17-w7-mcp-lifetime-round-2-review.md).

## 2026-10-09 — Third MCP review: contain incoming admission refusal

The [complete cumulative third round](../reviews/2026-10-09T10-51-01-w7-mcp-lifetime-round-3-review.md)
verifies that duplicate live peer-ID admission throws from the incoming base/lane callback.
Installed SDK WebSocket delivery does not catch that refusal; legacy SSE instead promotes it
through EventSource to a reader-loop/reconnect failure. Those are source-confirmed boundaries,
not experimentally reproduced native crashes/leaks. The owner now reports its typed refusal
through the normal error channel and suppresses only that delivery, preserving the original
handler/response-send lifetime. The [canonical MCP contract](../reference/shared-core/mcp-integration.md#invocation-and-transport-lifetimes)
records this correction. Two new local controls plus a strengthened installed in-memory SDK
control, root CI and enforced private coverage pass. A NEW complete cumulative round 4 remains
required; complete manager startup/all-actor retirement, final receipt health, parked clocks,
public departure, acknowledged CLI teardown, Step 8 and whole W7 remain open.

## 2026-10-09 — Fourth MCP review: release completed child references

The [complete cumulative fourth round](../reviews/2026-10-09T12-58-01-w7-mcp-lifetime-round-4-review.md) confirms that HTTP control/reply
lanes remain in their parent request's controls set after all child work completes. Sequential
valid replies therefore retain finished transports/scopes until the outer request ends. The
owner now removes each exact lane only on its full work acknowledgement, preserving pending
body/native-close custody. Seven permanent local cardinality regressions include before-fix
and premature-pruning negative controls; root CI and unchanged enforced coverage pass. These
are reference/lifetime controls, not native heap or GC measurements. The [canonical MCP contract](../reference/shared-core/mcp-integration.md#invocation-and-transport-lifetimes)
owns the rule. A NEW complete cumulative round 5 remains required. Complete manager startup,
all-actor/custom-provider retirement, final receipt health, parked clocks, public departure,
acknowledged CLI teardown, Step 8 and whole W7 remain open.

## 2026-10-09 — Fifth MCP review: scoped transport acceptance

[Two fresh complete cumulative reviews](../reviews/2026-10-09T13-37-00-w7-mcp-lifetime-round-5-review.md)
and Parent's full source/artifact audits accept all 38 changed paths/70 literal hunks through
`99c46bbd`. Both independently pass cold builds, strict checks, scoped lint and 268 existing
cases; no new confirmed finding remains. The record preserves separately corrected review
attributions, original capture limits and the qualified shared-tree directory-mtime difference.
The [canonical MCP contract](../reference/shared-core/mcp-integration.md#invocation-and-transport-lifetimes)
remains unchanged. This accepts only transport/protocol/CLI-fetch lifetime integration.
Complete manager startup/all-engine actor ownership, custom-provider descendants, sticky final
receipt health, parked clocks, public departure, acknowledged CLI teardown, Step 8 and whole
W7 remain open. No new policy or dependency is introduced by this acceptance checkpoint.

### Implementation note — fresh startup root staged, 2026-10-09

The next scoped implementation registers the complete fresh-start continuation before its
first workflow-id/store/context call. Terminal delivery stays bounded; retirement retains
entered startup work and releases an already entered acquisition's exact returned fence.
Retirement checks after startup awaits refuse fresh host entry, and cancellation between
interpolation filters refuses a second read after a noncooperative first read completes.
The mechanics live in [shared-core-engine.md](../architecture/shared-core-engine.md#internal-departure-foundations-adr-0103).

This is staged implementation, pending two fresh complete independent review rounds. It does
not close scheduler/dispatch/timer/resume or pre-handle roots, MCP startup, custom-provider
descendants, final semantic receipt health, parked clocks, public departure/CLI teardown,
Step 8 or final Step 12. The accepted decision and public departure requirements are unchanged.

### 2026-10-09 — First startup review: synchronous cancellation boundaries

[Two complete first-round reviews and Parent source/runtime/artifact audits](../reviews/2026-10-09T14-28-09-w7-startup-lifetime-round-1-review.md)
verify that an initial clock, elapsed-clock or timer callback can synchronously cancel the
fresh execution before its first awaited lookup. The original continuation still enters
that lookup and retains a newly armed timer after the terminal sweep. Startup now rechecks
these synchronous returns, and timeout setup disposes a disarm receipt returned after
cancellation. Three permanent reference-host cases and causal removals cover the correction.
The existing decision is unchanged; no runtime dependency or new public contract is added.

A NEW complete cumulative round 2 is required. One-shot clock-fault tests do not establish
recovery from a permanently unavailable clock. The other actor/startup roots, final receipt
health, parked clocks, public departure/CLI teardown, Step 8 and whole W7 remain open.

### 2026-10-09 — Fresh startup/interpolation lifetime acceptance

[Two NEW complete cumulative round-2 reviews and Parent audits](../reviews/2026-10-09T14-55-12-w7-startup-lifetime-round-2-review.md)
accept the ten-path/sixteen-hunk increment through `5d44b13b`, with no new confirmed
findings. Both independently pass the seven prescribed checks and 2,850 core cases.
Parent verifies exact Git/head/hunk/archive and original input identities, all physical
artifacts/link targets and a zero-change 647,041-entry shared-tree comparison before
explicit freeze release. Administrative capture and finite/source-only proof limits
remain in the review record. The accepted decision is unchanged.

This accepts fresh startup and interpolation only. Remaining actor/pre-handle/MCP
startup roots, custom-provider descendants, final receipt health, parked clocks,
public departure/CLI teardown, Step 8 and final whole-wave Step 12 remain open.

### Implementation note — scheduler readiness lifetime staged, 2026-10-09

The node-boundary readiness Promise is registered before its public port is invoked.
The scheduler races its wait against abort while retaining that exact raw Promise for
host retirement. Claims that never entered `node:started` return to pending on batch
exit, allowing cancellation/failure to advance without inventing running executors.
Live readiness throws/rejections become a fixed internal failure. The mechanics live
in [shared-core-engine.md](../architecture/shared-core-engine.md#internal-departure-foundations-adr-0103).

Eight controlled reference-host cases pass; before-fix production fails seven and
reports two original unhandled readiness rejections. Separate removal of raw ownership,
the abort race and claim unwind fails two/two/five cases; exact restoration passes eight.
These are finite public-port controls, not native backpressure/process proof. Two fresh
complete independent review rounds are required. Complete scheduler/dispatch and other
actor roots, public departure and the remaining W7 obligations are unchanged and open.

### 2026-10-09 — Parent pre-review readiness getter correction

Before independent reviewers start, Parent confirms that readiness method acquisition
can synchronously cancel the execution: the returned function is still invoked by
`f4e4b980`. The boundary now captures the method, rechecks stopped state and invokes
only a live method with its original handle receiver. Two additional permanent cases
bring the scoped readiness increment to ten. Expanded before-fix production fails
eight cases with two original unhandled errors; raw-owner/abort-race/claim-unwind/
getter-guard/receiver removals fail two/two/six/one/two, and restoration passes ten.
The earlier eight-case evidence remains historical. Initial review preparation is
superseded before agent dispatch, without claiming completed review or an after-snapshot
audit. Both independent rounds must review the entire corrected cumulative scope.

### Scheduler readiness diagnostic backstop — 2026-10-09

The [first complete cumulative readiness review](../reviews/2026-10-09T15-44-15-w7-scheduler-readiness-round-1-review.md)
verifies a secondary ID/event-clock fault while reporting a readiness rejection.
It escaped the serialized scheduler and stranded its queued reevaluation; a terminal
then depended on grace. The readiness branch now uses the established in-memory
failure backstop when diagnostic publication faults, preserving fixed content-free
error text and cancellation/first-failure precedence before reevaluation.

Two permanent one-shot regressions fail at the frozen reviewed source and pass with
the correction; both require terminal delivery without firing grace, no node execution,
no private error text and eventual exact lease/timer cleanup. The full twelve-case
readiness suite passes, as do 110 private core files / 2,862 cases. Removing the complete
nested fallback reproduces the same original two failures and unhandled rejections;
the individual backstop call is not separately proven load-bearing. Permanently broken
host clocks, native host departure and complete actor closure are outside this proof.
A NEW complete cumulative round 2 remains required; the accepted decision is unchanged.

### 2026-10-09 — Scheduler readiness cumulative acceptance

[Two NEW complete cumulative round-2 reviews and Parent audits](../reviews/2026-10-09T16-14-29-w7-scheduler-readiness-round-2-review.md)
accept all nine paths/ten hunks through `95f3923a`, with zero new scoped findings.
Both independently pass seven prescribed checks and 2,862 core cases. Parent reads
both complete reports/maps, verifies original source/artifact identities and observes
an unchanged 647,245-entry shared tree before explicit freeze release. The first-round
finding and finite/reference-host proof qualifications remain in their dated records.

Two pre-existing dispatch Highs discovered during separate Parent preparation remain
required: cancellation after an entered start append must refuse and settle fresh
node work, and detached dispatch failures must avoid raw cause inspection/coercion.
Both reviewers source-corroborate those defects without accepting the private proposed
corrections. Complete actor integration, final health/clocks/departure, Step 8 and
whole-wave Step 12 remain open. The accepted decision is unchanged.

### Inherited dispatch corrections staged — 2026-10-09

Two inherited dispatch Highs recorded in the
[readiness round-2 review](../reviews/2026-10-09T16-14-29-w7-scheduler-readiness-round-2-review.md)
are corrected. Cancellation after an entered start append refuses fresh deadline/executor
entry and immediately settles that matching node. Unexpected detached dispatch failures
use fixed content-free text; no raw cause property or coercion is evaluated. Readiness,
pre-dispatch cancellation and detached failure share the existing diagnostic backstop.
The [canonical engine architecture](../architecture/shared-core-engine.md#internal-departure-foundations-adr-0103)
describes the mechanics. No public API, dependency or accepted decision changes.

Six permanent cases cover cancelled/live held start appends at widths one/three and
private Error/non-Error coercion faults. Parent's eighteen-case private causal matrix
fails four cases with one unhandled rejection on exact old production and passes the
complete correction. Removing the post-append guard, matching settlement, safe dispatch
handling or diagnostic backstop fails two cases each; restoration passes eighteen.
That matrix includes a broader private actor prototype and is not exact proof of the
narrower final main source: final-source checks/controls must be retained separately.
The hostile non-Error fixture has one explained local lint exception; production has none.
Affected existing cancellation fixtures now witness actual executor/deadline entry.

The broader actor prototype passes private core checks (112 files / 2,868 cases), but
its original actual root CI fails 38 CLI cases across thirteen files. Registering complete
scheduler/dispatch/resume roots exposes host closure and lease handoff before actual
retirement. No red implementation is accepted and no CLI closure assertion is weakened.
Only Parent-owned uncommitted root/retirement-fixture edits are removed from the main
candidate; the complete prototype and original failing CI inputs/logs remain preserved.
Full root ownership must be integrated with shipping host departure within W7.

Actual root CI and two NEW complete independent review rounds are required for the
scoped dispatch corrections. Other actors, MCP startup/custom-provider descendants,
final receipt/writer/money health, parked clocks, public departure/CLI teardown, Step 8
and whole-wave Step 12 remain required; none is deferred by this ordering correction.

### 2026-10-09 — inherited dispatch corrections, round-1 acceptance

[Two complete independent round-1 reviews and Parent audits](../reviews/2026-10-09T17-28-06-w7-dispatch-corrections-round-1-review.md)
accept all eight paths/seventeen hunks through `1918690d`, with zero confirmed findings.
Each passes seven prescribed original checks and 2,868 core cases; Parent verifies all
17,542 reviewer input copies, exact Git/archive/head/hunk identities and protected artifact
inventories. The complete 647,355-entry shared tree remains unchanged before explicit
freeze release. An adjacent grace-fixture coverage hypothesis is not confirmed by Parent's
exact-final removal control; its stronger explicit witnesses remain clarity hardening.

A NEW complete cumulative second round is required before scoped closure. Complete
actor roots must integrate with shipping departure; the broader prototype's original
38 CLI failures remain unaccepted evidence. Final receipt health, parked clocks,
primary/input/host acknowledgement, Step 8 and final Step 12 remain required W7 work.
No accepted decision is changed and no whole-wave acceptance is claimed.

### 2026-10-09 — Retry and synchronous attempt-entry corrections

[Both NEW complete cumulative round-2 reviews](../reviews/2026-10-09T17-58-41-w7-dispatch-corrections-round-2-review.md)
cover ten paths/nineteen hunks through `53cccc38` and independently verify one High:
an entered retry-start append can resume into fresh executor work after cancellation,
sibling abort or grace. The first-start guard does not cover this inherited continuation.
Both reviewers pass seven prescribed checks and 2,868 core cases; those green frozen-head
results do not accept the subsequent correction.

Parent corrects retry refusal and matching attempt settlement, including grace correlation
before the awaited append. After both reports, Parent additionally confirms synchronous
cancellation at actual attempt-entry ports and corrects method/context acquisition ordering
while preserving the receiver and raw Promise. That later discovery is not attributed to
the reviewers. The [canonical engine architecture](../architecture/shared-core-engine.md#internal-departure-foundations-adr-0103)
owns the mechanics; the accepted decision and public API are unchanged.

Ten permanent live/stopped cases pass exact-final controls: old production fails six;
fixed/restored pass ten; independent guard/receiver/correlation/settlement removals
reproduce the relevant failures. Two matching-settlement removals actually time out.
Parent verifies all 13,805 final causal input copies and reads the complete logs; strict
core and scoped lint pass. Earlier fixture/summary/receiver-diagnostic qualifications
remain explicit in the review record. This is controlled reference-host evidence, not
native/public-departure or whole-wave acceptance.

Parent reads all reports/maps and physically verifies fourteen reviewer originals /
17,556 input copies, exact Git/archive/patch identities and protected inventories. The
647,374-entry shared tree is unchanged before explicit release at
`2026-10-09T17:58:41.957529+00:00`; only then are main-source corrections applied.
NEW complete cumulative reviews are required. Complete actor roots must integrate with
shipping departure; the broader prototype's 38 original CLI failures remain unaccepted.
MCP startup/custom-provider descendants, sticky final health, parked clocks, primary/input/
host ACK and CLI teardown, Step 8 and final Step 12 remain required. All six W7 items stay
OPEN (41/51), PR #90 stays draft/unmerged, and no further maintainer action or paid call
is pending. No work is deferred by this correction.

### 2026-10-09 — Retry/deadline terminal idempotence

[Complete cumulative round-3 reviews](../reviews/2026-10-09T18-37-30-w7-dispatch-corrections-round-3-review.md) verify one High:
a retry refusal can publish a second node terminal behind an already pending timeout
terminal. Lifecycle discovers it independently; Authority corroborates after disclosure.
Parent confirms the frozen source and corrects the shared terminal-status guard, with
one new permanent case and passing original/removal/fixed/restored causal controls.
The accepted decision is unchanged. Fresh cumulative review is required before scoped
closure; full actors/departure, final health/clocks/ACKs, Step 8 and Step 12 remain required.
All six W7 items stay OPEN (41/51), and PR #90 remains draft/unmerged.

### 2026-10-09 — Explicit dispatch attempt correlation

[Complete cumulative round-4 reviews](../reviews/2026-10-09T19-10-39-w7-dispatch-corrections-round-4-review.md)
verify one High with two schedules: later-retry detached failure defaults to attempt 1,
and an approved fresh first start can retain the previous retry basis through grace.
Lifecycle discovers both independently; Authority corroborates after disclosure; Parent
owns exact-source runtime confirmation, correction and causal removal controls.

All four failed-helper callers now select an explicit attempt. Detached failure uses the
latest entered attempt; a new first start resets 1 synchronously before its append.
The [canonical engine architecture](../architecture/shared-core-engine.md#internal-departure-foundations-adr-0103)
owns these mechanics. Five permanent cases join the cumulative controls. Final sixteen-case
original/fixed/two-removal/restored results are 3/13, 0/16, 2/14, 1/15 and 0/16 fail/pass;
Parent verifies all 6,290 physical inputs and complete logs, plus private strict/lint/full
core (117 files / 2,884 cases). Fresh complete cumulative review is required.

Both frozen-head reviewers pass seven originals and 2,879 core cases. Parent verifies
reports/maps/originals, 17,626 physical input copies and protected inventories. A pre-seal
historical map attribution error is corrected without changing source or original captures.
The 647,505-entry shared tree is identical before explicit release at
`2026-10-09T19:10:39.474325+00:00`. This note leaves the accepted decision unchanged.
Full actors/public departure/CLI, final health, parked clocks, Step 8 and Step 12 remain
required. The broader prototype's 38 original CLI failures are unaccepted. All six W7
items stay OPEN (41/51); PR #90 remains draft/unmerged. No W7 work is deferred.

### 2026-10-09 — Approved redispatch readiness preserves the entered retry

[Complete cumulative round-5 reviews](../reviews/2026-10-09T19-41-03-w7-dispatch-corrections-round-5-review.md)
verify one High: after an entered retry 2 budget-pauses and is approved, readiness may
reject before a new first start. Literal failure attempt 1 then misattributes the terminal.
Authority independently discovers it; Lifecycle corroborates after disclosure; Parent
owns exact-source runtime and correction. Readiness now forwards the latest entered
attempt; the first-start reset remains at actual start entry. Two permanent paired cases
and identical-fixture original/fixed/removal/restored controls pin that boundary.

The twenty-case matrix gives 1/19, 0/20, 1/19 and 0/20 fail/pass; Parent verifies all
5,036 physical input copies and complete logs. Corrected strict/lint/core pass at
118 files / 2,886 cases. Both frozen-head reviewers pass seven originals and 2,884 cases;
Parent audits exact metadata/artifacts and the shared tree before explicit release.
NEW complete cumulative review is required; no private correction is accepted by this
rejected round. Accepted ADR policy is unchanged. Full actors/public departure/CLI,
final health, parked clocks, Step 8 and Step 12 remain required. All six W7 items stay
OPEN (41/51); PR #90 remains draft/unmerged. No W7 work is deferred.

### 2026-10-09 — Grace distinguishes claims from entered starts

[Complete cumulative round 6](../reviews/2026-10-09T20-08-19-w7-dispatch-corrections-round-6-review.md) finds no new confirmed issue on the twenty-path/
thirty-four-hunk frozen candidate. [The NEW complete round 7](../reviews/2026-10-09T20-29-02-w7-dispatch-corrections-round-7-review.md) rejects the same
candidate for one High: grace walks authored order while scheduler claims follow ready
plan order, allowing a never-started sibling to receive a node failure. Lifecycle
independently discovers it, Authority corroborates after disclosure, and Parent owns
exact-source runtime confirmation and correction. The earlier flat-width hypothesis
remains correctly disproved; the differing-order schedule is materially distinct.

Explicit current unstarted claims now remain excluded from grace until actual first-start
entry, independently of historical attempt numbers or iteration order. Three permanent
live/cancel/grace cases pass fixed/restored controls; original and guard removal each
fail only grace. Parent verifies 5,044 physical inputs and full logs. The canonical
engine architecture owns the mechanics; accepted ADR policy is unchanged. Both reviewer
artifact/Git/shared-tree audits precede correction. NEW complete cumulative reviews are
required; round 7 does not accept the later fix. Complete actors/public departure/CLI,
final health, parked clocks, Step 8 and Step 12 remain required. All six W7 items stay
OPEN (41/51), and PR #90 remains draft/unmerged. No W7 work is deferred.

## 2026-10-10 — Consolidated implementation awaiting independent acceptance

The public local-departure operation, complete run actors and transitive MCP/custom-provider
ownership, final semantic receipt health, parked clocks and acknowledged CLI teardown are
implemented together. The first-start publication High from
[dispatch round 9](../reviews/2026-10-09T21-43-39-w7-dispatch-corrections-round-9-review.md)
is corrected with six permanent paired regressions. Canonical mechanics live in
[shared-core-engine.md](../architecture/shared-core-engine.md#internal-departure-foundations-adr-0103)
and output/remedies in [commands.md](../reference/cli/commands.md#exit-codes).
Two fresh complete cumulative reviews remain required; earlier scoped acceptance is not
broader host-departure acceptance. Step 8 and final Step 12 remain open. Accepted policy
above is unchanged.

## 2026-10-10 — Complete composition review corrections

[Consolidated round 1](../reviews/2026-10-09T23-05-00-w7-host-closure-round-1-review.md)
finds three live lifecycle violations: successful post-pause money publication permanently
blocks detachment, rejected activation returns before entered heartbeat/timer work retires,
and Ink hides a terminal after unmount while receipts remain held. Parent confirms and corrects
all three under the existing accepted policy, with eighteen permanent additions including
the separately required shipping ToolRegistry quiet-failure/mapping/bounding acceptance paths.
The canonical engine and CLI contracts above own these mechanisms. This rejected frozen review
does not accept the later fix; fresh complete independent review remains required. Step 8 and
final Step 12 remain open, with no new provider capture or approval pending.

## 2026-10-10 — Due-action and invocation-entry corrections

[Complete host-closure round 2](../reviews/2026-10-09T23-34-00-w7-host-closure-round-2-review.md)
confirms that asynchronous budget timeout preparation needs a synchronous per-gate in-flight
claim shared with direct departure deadline service, and that provider entry needs a final
cancellation guard after transferring invocation ownership. Parent implements both under the
existing policy, including unused-admission release, with nineteen permanent paired cases.
Refused timeout approval still terminates through the existing `run_timeout` path; no new
approval, timeout or wire policy is introduced. Adjacent canonical references now link the
current final-health priority and public departure. Fresh complete review, Step 8 and final
Step 12 remain required; no provider capture or maintainer decision is pending.

## 2026-10-10 — Retirement preserves response evidence and completion

[Complete host-closure round 3](../reviews/2026-10-09T23-56-41-w7-host-closure-round-3-review.md) identifies two
implementation violations at synchronous invocation retirement. Response data and accountable
usage must be owned before caller cleanup runs; listener-removal failure must still attempt
abort and quiet acknowledgement. Known usage and an established provider diagnosis survive
secondary cleanup faults. Parent corrects text, separate media and poll boundaries under the
accepted policy, with thirty-two permanent cases. The
[provider seam](../reference/shared-core/llm-provider-seam.md#the-per-attempt-deadline) owns
these mechanics; no media request-ownership extension or new wire policy is introduced.
Fresh complete review, Step 8 and final Step 12 remain required.
