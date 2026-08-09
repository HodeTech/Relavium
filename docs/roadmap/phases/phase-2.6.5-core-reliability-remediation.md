# Phase 2.6.5 — Core reliability remediation (interlude)

- **Status**: planned
- **Opened**: 2026-08-09
- **Predecessor**: Wave 1 of the 2.5.5 remediation (complete — PR #81)
- **Successor**: Wave 2 of the 2.5.5 remediation (MCP + fs jail), which this phase AMENDS rather than replaces
- **Kind**: interlude, like [phase 2.5.5](phase-2.5.5-hardening-and-remediation.md) — no new product surface, only
  the invariants an existing surface already claims

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

## What must NOT change

Recorded so a remediation pass does not quietly undo a decision that is correct:

- The pure-TypeScript engine with zero platform imports.
- The `LLMProvider` seam and the rule that no vendor SDK type crosses it.
- Deny-by-default tool policy, the approval chain, and the QuickJS sandbox.
- Strict authored YAML with Zod at every boundary.
- Event-sourced checkpoint/resume as the recovery model.
- Keys in the OS keychain only.

## Working discipline for this phase

This phase inherits the discipline Wave 1 arrived at the hard way. It is not optional ceremony; every clause
below exists because its absence produced a real defect during Wave 1.

1. **A decision gets an ADR before it gets code.** Six of the seven P0 items below change what a contract
   *means* — what "exactly once" means, what `system` authority means, what "the stream ended" means. Wave 1
   proved that treating a decision as a task item produces false completion claims. Write the ADR, get it
   accepted, then implement.
2. **Break-verify every regression test, and verify the mutation actually applied.** Wave 1 produced three
   tests that passed with the production code mutated. Each was found only by checking that the mutation had
   landed (e.g. `grep -c` the mutated symbol → 0) before trusting a red.
3. **Never ship a hollow test.** If the honest test cannot be built, leave the gap open, name it, and name the
   mutation that would close it. A test that implies coverage it does not have is worse than none.
4. **Record rather than assert.** Any claim that cannot be demonstrated goes in as a limitation, not as a
   property.
5. **Fix the canonical doc in the same change.** One canonical home per artifact; a fix that leaves the spec
   describing the old behaviour has not landed.
6. **`pnpm run ci` must exit 0.** Check the exit code, not the reporter output.

## How the work is grouped

`CR-##` ids below are this phase's own; they are stable and self-contained. Severity is the consensus of the
three reviews.

- **W0 — finish the halves.** Cheap, already half-done. Leaving them half-done is the exact failure this phase
  is correcting.
- **W1 — the seven P0 blockers.** ADR-first, in dependency order.
- **W2…W9 — P1 themes.** Grouped so each theme is one reviewable PR, not sixty scattered tickets.

---

# W0 — Finish what is already half-done

These are partially closed. Each has a verified open half.

## CR-01 — `session:cancelled` bypasses the session durability latch · High

**Evidence.** The CLI chat persister wraps its cost and turn writes in the `persistDurably` failure latch, and
since Wave 1 the `session:compacted` and `session:trimmed` arms go through it too. The `session:cancelled` arm
still calls `deps.store.writeTurn(...)` directly (`apps/cli/src/chat/persister.ts`).

**Why it matters.** The event bus isolates listener errors from the producer, so a failing DB write lets the
cancel path report success. The durability latch never sets, so nothing gates the next provider egress.

**Fix.** Route the `session:cancelled` write through `persistDurably`, exactly as its two siblings now are.

**Acceptance.** A failing `writeTurn` on cancel sets `durabilityFailure`, and the next egress is refused.
Break-verify by removing the wrapper.

## CR-02 — A failed turn flush leaves the turn counter incremented · Medium

**Evidence.** `packages/core/src/engine/agent-session.ts` increments `#turnCount` before it awaits
`flushBudgetCommitments()`. Wave 1 fixed the transcript half of this (the flush now precedes the assistant
append, so the rollback's one-message `pop()` is correct again). The counter half was not examined.

**Why it matters.** A turn whose durability flush rejects has still consumed a slot against the hard turn cap.

**Fix.** Decide deliberately, then make the code say it: either the counter moves after the flush, or it stays
where it is because an engaged provider call counts regardless — which is what the two catch paths already do
for `engaged` turns. Whichever is chosen, state it in a comment and pin it with a test.

**Acceptance.** A rejecting flush leaves `#turnCount` at the value the chosen rule requires, asserted directly.

## CR-03 — Three `--json` paths still bypass the safe serializer · High

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

# W1 — The seven P0 blockers

Dependency order matters. `CR-10 → CR-11 → CR-12` is a chain: an effect journal is meaningless while two
processes can own the same run, and run ownership rests on the log being an ordered prefix. `CR-13`, `CR-14`
and `CR-15` are independent and can run in parallel.

## CR-10 — The durable event log is not a gap-free ordered prefix · Blocker · needs an ADR

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

## CR-11 — No cross-process run ownership or CAS · Blocker · needs an ADR

**Evidence.** The engine states that its cross-process guarantee rests on store uniqueness, but the only DB
uniqueness is `(run_id, seq)`. `resumeFromCheckpoint` performs an in-memory check, then loads the checkpoint and
builds an independent `RunExecution`. There is no run lease, fencing token, or checkpoint-cursor CAS.

**Failure.** Two CLI or desktop processes read the same paused run at the same time and become two independent
side-effect producers for one run.

**Fix.** A run-level lease with a fencing token, or an atomic CAS on `last_seq`:
`acquireRunLease(runId, ownerId, expectedGeneration, ttl)`. The process that loses the CAS becomes a read-only
observer rather than a second owner.

**Acceptance.** Two concurrent resumes of one paused run: exactly one proceeds, the other degrades to observer
with a typed, actionable error. A lease that expires mid-run is fenced out of further durable writes.

## CR-12 — No durable effect/idempotency journal on the hot path · Blocker · needs an ADR

**Evidence.** `NodeExecContext` carries an attempt number but no run/effect idempotency key.
`ToolDispatchContext` carries a node id but no run correlation or semantic key. The registry calls
`def.dispatch` directly with no durable prepare step. Our own architecture documents state that a stable key
prevents duplicates — that key does not exist in the dispatch context.

**Failure.** `node:started` persists → an `http_request` POST or MCP mutation completes at the target → the
process dies before the tool result or `node:completed` persists → resume re-runs the node → the target sees
the same effect twice.

**Impact.** Duplicate ticket, deploy, payment, message or commit. The *duplicate-free* product claim is false
until this closes, and audit/compensation cannot be built on top of it.

**Fix.** Add `EffectAttemptId = runId + nodeId + nodeAttempt + toolCallId + effectiveArgsHash` to
`ToolDispatchContext`. Side-effectful host ports take it as a required argument. A durable state machine in the
run store: `prepared → dispatched → committed | ambiguous → needs_attention`.

**Acceptance.** Kill the process after the effect completes at the target — resume produces no duplicate. An
ambiguous non-idempotent effect is never auto-retried. The same effect key arriving from two processes commits
once.

**Relationship to the realized-cost ledger.** The accepted cost-ledger ADR explicitly scopes effect duplication
out and names this as the decision that owns it. That ADR's implementation and this item are independent; this
one is the larger of the two.

## CR-13 — Compaction summary is elevated to `system` authority · Blocker (community/untrusted content) · needs an ADR

**Evidence.** The prior conversation is handed to the summarizer as user-role data; the summarizer's model
output is taken as a plain string, becomes the context preamble, and is concatenated directly into the authored
`agent.system_prompt` on the next turn. Resume and model reseat restore the persisted summary into the same
preamble (`packages/core/src/engine/agent-session.ts`).

**Attack.** A user message or a read document contains a closing tag for the summary fence plus "ignore previous
instructions". The summarizer preserves it as a task. On the next tool-capable turn those bytes sit in the
`system` role — and survive a restart, because the summary is persisted. An XML fence is not a trust boundary.

**Conflict.** Our binding security standard treats model output and tool results as untrusted and forbids
concatenating untrusted content into `system`. The compaction ADR fixed exactly that concatenation as its
decision, so this needs an append-only superseding ADR, not a patch.

**Fix.** Carry the summary as untrusted. Dynamic summary bytes must never reach the `system` builder. Supply the
summary as a separate untrusted content part in user-role context. Make `AgentTurnParams.system` accept only a
branded type the authored builder can produce.

**Acceptance.** An injected summary containing a fence-closing sequence plus instructions cannot alter tool
authorization on the following turn, before or after a restart. A type-level test proves a dynamic string cannot
be passed as `system`.

## CR-14 — A stream that ends without a terminal `stop` counts as success · Blocker · needs an ADR

**Evidence.** The fallback chain emits a success attempt when the provider iterator ends cleanly with no usage.
The agent turn starts with a default `stopReason` of `stop` and returns a normal result without ever seeing a
terminal chunk. **An existing test pins this behaviour as success** — so the fix changes that test, deliberately,
rather than deleting it.

**Failure.** A transport, proxy or provider closes after `text_delta: "partial"` with no terminal chunk.
Relavium treats the partial text as a completed assistant answer and passes it downstream as a successful node
output.

**Fix.** Make the stream grammar require exactly one terminal. A clean EOF with no terminal is a `transport` or
`protocol` error. If content was already committed, do not fail over or retry — surface it.

**Acceptance.** A stream ending without a terminal produces a classified error, not a node success. A
content-committed truncation does not trigger failover. The superseded test is rewritten to assert the new rule
and to keep the reasoning for the behaviour it replaces.

## CR-15 — The engine does not enforce the authored input contract · Blocker · needs an ADR

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

**Acceptance.** Defaults are applied by the engine, not the surface. A type/enum violation fails admission with
a typed error before `run:started`. The same workflow and inputs behave identically through the engine API and
through the CLI.

## CR-16 — Stdio MCP spawns a local process before consent · Blocker · needs an ADR · **amends Wave 2**

**Evidence.** The MCP connection is opened while the chat session is being built, before a mode or turn starts;
the agent-run path prepares MCP first and applies mode policy afterwards. An agent or workflow declaration
produces the `command`, `args` and `cwd` spawn spec directly, and the SDK adapter spawns it.

**Failure.** No tool call is required. `ask` mode does not protect the spawn. `shell: false` does not stop the
declaration from naming `sh`, `bash` or `node`. An imported community artifact executes arbitrary local code at
load time.

**Fix.** Consent before the first spawn, showing executable, args, cwd, artifact source and hash. Unknown
fingerprint fails closed. In non-interactive mode, fail closed unless an explicit `--allow-mcp-stdio <digest>`
is supplied. Replace auto-start with lazy connect on first actual MCP tool need.

**Acceptance.** Importing and opening an artifact with a stdio MCP server spawns nothing until consent. A
non-interactive run without the digest flag fails closed with an actionable message. A changed fingerprint
re-prompts.

**Wave 2 note.** Wave 2 already holds the MCP timeout / SSRF / ingress cluster. This item belongs to the same
code area and the same review; it should be folded into that PR sequence rather than opened separately, but it
is a P0 while the rest of that cluster is P1.

---

# W2 — Liveness and deadlines

## CR-20 — Agent-node `timeout_ms` is completely inert · High
The node schema accepts the field, but the runner passes only the run-level signal to the agent turn; no timer,
controller or deadline consumes `node.timeout_ms`. An authored liveness bound is silently ignored.
**Fix + acceptance.** Honour it as a real deadline; a node exceeding it fails with a classified timeout, proven
with a fake clock.

## CR-21 — No Relavium-owned deadline for a normal provider attempt · Medium-High
The chain awaits generate/stream with the caller's signal only; unlike list-models and key validation, it sets
no per-attempt timeout. Without a node or run timeout, the vendor SDK default becomes the product's liveness
semantics — which our security standard forbids for outbound requests.
**Fix + acceptance.** An injected controller/timer factory; merge caller-abort with deadline-abort. A timeout is
`kind: 'timeout'`, a user cancel stays `cancelled`. A pre-content timeout may fail over; a content-committed one
must not. Prove timer cleanup with a fake clock. This is a different timer from CR-20 — both are needed.

## CR-22 — Gate and run deadlines are not preserved across resume · High
The checkpoint's pending gate carries gate/node/budget data but not an absolute deadline, and the whole-run
timeout is re-armed for its full duration on every resume — so a crash extends the cap.
**Fix + acceptance.** Persist absolute deadlines; resume computes the remaining time. A run crashed and resumed
repeatedly still times out at its original absolute deadline.

## CR-23 — Exactly-one-terminal is a safety property, not a liveness one · High
Cancel only fires the abort signal, and the terminal waits for the running-node count to reach zero. The node
executor seam accepts an arbitrary promise; honouring the signal is not guaranteed at the type level. An
executor that ignores abort and never settles leaves the run without a terminal forever.
**Fix + acceptance.** A bounded grace period after cancel/timeout, then a generation token that fences the run
state from late outcomes, plus executor quarantine. Tests: a never-settling executor and a late-success executor
both produce exactly one terminal in bounded time, and the late output is not applied.

---

# W3 — Resource governance and bounds

## CR-30 — The event stream is not really bounded · High
`push()` appends without a capacity check; `whenDrained` is advisory and only awaited at node boundaries, while
token deltas are emitted synchronously. A single provider stream can grow memory without a hard bound. The three
properties "sync producer", "no drop" and "hard bound" cannot all hold — pick two, deliberately.
**Fix + acceptance.** Real backpressure or an explicit, documented drop policy for transient events. A test
drives a fast producer against a slow consumer and asserts a hard ceiling.

## CR-31 — No safe default concurrency and no absolute graph/retry caps · High
An omitted `max_parallel_nodes` means `Infinity`. There is no absolute cap on authored nodes, edges, fan-out
width, fallback-chain length, retry counts, parallel tools or total attempts; the parser's text-size limit does
not stop many small ones.
**Fix + acceptance.** A small capacity-derived default concurrency that an authored value may only narrow, plus
explicit absolute caps enforced at parse/compile admission with typed errors.

## CR-32 — Workflow output, state and durable event size are unbounded · High
**Fix + acceptance.** Bound them at the durable boundary with a typed rejection, the same way tool output is
already bounded.

## CR-33 — Finished runs are retained forever in memory · Medium-High
`WorkflowEngine` keeps completed runs indefinitely.
**Fix + acceptance.** A retention policy with an explicit bound; a long-lived process running many workflows
does not grow without limit.

---

# W4 — MCP hostile boundary *(merge into Wave 2)*

## CR-40 — Cancellation and deadlines never reach the MCP transport · High
The dispatch context can carry a signal, but the manager's `callTool` chain does not forward it, and neither the
connection nor the stdio SDK call accepts an abort or deadline. After a user cancels, the remote or child effect
continues and child processes can survive.

## CR-41 — The MCP SSRF floor does not cover DNS or redirects · High
The network config checks the authored hostname and scheme, then hands the raw opener to the SDK. The code
itself documents the DNS-to-private and redirect-to-private holes. A public-looking domain can resolve to
loopback, RFC1918 or a metadata IP.
**Fix.** Apply the built-in egress mechanism — resolve-all, range-block, pinned IP — to the MCP HTTP, SSE and
WebSocket transports.

## CR-42 — MCP discovery and result ingress are unbounded · High
Page count is capped for `tools/list`, but total tool count, byte size, description and schema size are not, and
a result is fully materialized before core bounding applies. A hostile server can exhaust startup memory, inflate
prompt token cost, or bloat a workflow output.

**Acceptance for W4.** A hostile-server harness: a server that never answers is cancelled within its deadline
and leaves no orphan process; a DNS record pointing at loopback is refused; oversized discovery and results are
rejected with typed errors before they reach the prompt.

---

# W5 — Media correctness

## CR-50 — `read_media` does not work end to end · High
The builtin returns a base64 media part, the registry places generic output into the tool result, and the LLM
message schema explicitly forbids raw media bytes there. The canonical alternative is a handle-only attachment,
but all three adapters deliberately drop that field, and production chat does not wire the media-read scope.
There is no registry → turn → chain → adapter path.
**Fix + acceptance.** Either complete the handle path through the adapters, or remove the tool from the catalog
until it works — an advertised tool that cannot work is worse than an absent one. An end-to-end test proves the
chosen answer.

## CR-51 — Model-level tool/attachment capability is not enforced · High
The catalog carries `toolCall` and `attachment` metadata, but runtime gates on the provider-wide flags and the
adapters attach tools unconditionally. A model the catalog marks as tool-incapable can still be sent tools, and
the chain can treat it as capable instead of pre-skipping it — turning a free skip into a paid 400.

## CR-52 — Gemini reasoning/tool continuation metadata is lost · Medium-High
Part-level thought signatures on function calls are not captured, and replay drops reasoning after a tool
result. Multi-turn thinking-plus-function-calling continuations can 400 or break semantically.

## CR-53 — Large media travels fully buffered and base64-encoded · High
Audio and video responses are read into a full buffer and converted to base64; raw buffer, typed view, base64
string and the store's decoded copy can all exist at once.
**Fix + acceptance.** A bounded stream or download lease from the adapter; the host writes straight to the media
store with a `Content-Length` and streamed-byte ceiling. A large-media test asserts peak memory stays bounded.

## CR-54 — URL media can produce different bytes on resume · High
Remote URL media is resolved again on resume, and the same URL can return different content, a different
redirect or a different DNS answer. The run appears to have the same inputs while the model sees different bytes.
**Fix + acceptance.** Convert to a content-hashed handle at first resolution; resume must not re-fetch.

## CR-55 — Missing media rates can bypass a strict cost cap · Blocker for the strict-cap claim
Where a media rate is absent the estimator can fall to zero, the generated catalog projection produces no media
rate, and the DB's media-rate columns are not carried into the listing/overlay path. The governor can then treat
a missing rate as *priced at zero* rather than *unpriced*, admitting paid image/audio/video generation under a
strict cap and reporting `cost:updated = 0`.
**Fix + acceptance.** Missing media rate ⇒ unpriced, never zero. Under a strict cap an unpriced media generation
is refused. Carry the media rates through the overlay path.

---

# W6 — Authoring correctness

## CR-60 — `merge_strategy: first` is not implemented as specified · High
The canonical table says the first resolved branch wins and the others are ignored. The engine waits for every
branch to settle and the handler takes the first surviving output in declaration order. A slow loser adds
latency and cost; a failing loser can fail the run even when the winner is ready.
**Fix + acceptance.** Either implement race semantics or rename the strategy and correct the canonical table —
but the name and the behaviour must agree. Whichever is chosen, a test pins latency/cost behaviour.

## CR-61 — Schema fields do not deep-validate · Medium
An agent's `output_schema` becomes a response-format hint and is then only `JSON.parse`d; the transform node's
`output_schema` explicitly does not deep-validate; an agent's `input_schema` is not enforced on the runtime
runner path. A prior ADR required deep validation to land with this work, so this is also a decision-governance
drift.
**Fix + acceptance.** Real deep validation with typed failures, or a documented, deliberately narrowed contract
plus a renamed field. Silence is not an option.

## CR-62 — Expression dependencies are invisible, so silent mis-routing is possible · High
The DAG derives edges from template references only and deliberately does not order JS-expression reads of run
outputs. A condition that runs before its producer compares `undefined` and silently takes the false branch — a
test currently pins that silence.
**Fix + acceptance.** Either extract dependencies from expressions, or fail loudly when an expression reads an
unresolved output. Not a silent false.

---

# W7 — Agent product correctness

## CR-70 — Cross-turn tool-call memory does not exist · High (product)
Only the final assistant text enters the cross-turn transcript; within-turn tool call/result pairs are dropped. A
coding agent cannot remember a file it read in the previous turn and calls the tool again.

## CR-71 — Session transcript and export lose tool history · High
The persister stores the same text-only model, so the exporter — written to derive tool names from assistant
tool-call parts — has nothing to read. The canonical session spec promises a full transcript with a tool union.
**Fix + acceptance for CR-70/71.** Persist the tool pairs (bounded), or narrow the spec. A graduated workflow
must represent the flow that actually happened.

## CR-72 — Authored agent `memory` policy is inert · Medium
`none | window | summary` is accepted by the schema and consumed by nothing.
**Fix + acceptance.** Implement it or reject it at parse time with a typed error.

## CR-73 — `invoke_agent` has no production delegate · High (2.6 go/no-go)
The builtin exists in the catalog and errors with tool-unavailable when no delegate is wired; nothing wires one
in production, and the availability filter keeps the delegate-backed tool in the catalog.
**Fix + acceptance.** Wire the delegate, or stop advertising the tool to the model when no delegate exists.

---

# W8 — Provider and conformance

## CR-80 — An invalid custom base URL fails OPEN to the official endpoint · High (security/compliance)
When the custom provider factory rejects a private, malformed or credential-bearing URL, the error is caught and
the default adapter is left standing — and a test pins that fail-open as correct. A user expecting an internal
gateway silently sends prompts and keys to the official API after a config drift.
**Fix + acceptance.** Fail closed with an explicit message. Rewrite the test that pins the old behaviour,
keeping the reasoning it replaces.

## CR-81 — Conformance cassettes do not verify the request wire contract · High
A recorded response carries status, content type and body only; replay checks that the request body is parseable
JSON and matches nothing else — not method, path, headers, or a canonical body. A dropped `response_format`, a
lost tool result on continuation, or a broken system-instruction mapper leaves the suite green.
**Fix + acceptance.** Match the canonical request. Mutating the request lowering must redden the suite.

## CR-82 — Missing or partial usage can be read as zero · High
Carried from our own backlog and re-confirmed by the reviews.
**Fix + acceptance.** Missing usage is *unknown*, never zero, on every path that reaches a cost total.

---

# W9 — Harness honesty and isolation

## CR-90 — Root coverage collects in-repo worktrees · Medium
The root Vitest include patterns have no exclude for repo-local checkout directories, so a stale worktree adds
test files and 0%-covered sources to the run. In one working tree this produced 471 discovered test files and 23
suite failures; excluding the worktree path produced 237 files and a clean run.
**Fix + acceptance.** Exclude repo-local checkout areas from both `test.exclude` and `coverage.exclude`. A
self-test creates a fixture worktree and proves root discovery does not see it.

## CR-91 — The workflow E2E harness is not a crash or durability oracle · Medium
It pins that the live stream reported success; it does not prove durable truth after a restart.
**Fix + acceptance.** An oracle that asserts live result, DB history, resume and reconcile agree on the same
terminal type and payload.

## CR-92 — Terminal persistence failure lets live and durable truth diverge · High
The engine can complete the delivery chain for a terminal event even when its persistence failed, and
reconciliation may later produce a different terminal than the original. Media reclaim can run before the
terminal is durable. A caller can receive a success result and outputs while history shows the run failed.
**Fix + acceptance.** Hold the intended terminal payload in a durable outbox and retry it under the same
identity. If durability is uncertain the API must not say `completed` — it returns a distinct typed result.
Terminal asset cleanup and handle resolution happen only after the terminal is durable. The test proves live,
history, resume and reconcile agree.

## CR-93 — Process-global catalog and parameter-learning state is not tenant-safe · Medium now, High for cloud
Process-global mutable state is fine for a single local user and wrong for the multi-tenant cloud surface.
**Fix + acceptance.** Scope it per run/session/tenant before any multi-tenant surface ships. Record the decision
even if the work is deferred.

## CR-94 — One budget approval opens every redispatch without a numeric limit · High
An approved vertex skips pre-egress admission on redispatch, and one agent turn can make many tool rounds plus a
final generation. The user approves a projection they saw, but the approval means "this vertex is exempt", not
"up to this amount".
**Fix + acceptance.** Make the approval an immutable numeric lease bound to money/token/attempt scope, model and
expiry, consumed atomically by each egress. An approved node that exceeds its lease pauses again.

## CR-95 — A mid-tool-loop budget pause replays the whole loop · High (Blocker while CR-12 is open)
A budget pause becomes a paused outcome; on approval the node is reset to pending and dispatched from the start.
The code already acknowledges that this repeats earlier provider and tool calls.
**Fix + acceptance.** Short term: forbid a mid-loop budget pause (fail closed). Long term: checkpoint the
continuation — provider messages, tool call/result pairs, round index — and resume from that point. A mid-loop
pause plus approval must not repeat a mutation.

---

# Exit criteria

This phase is done when **all** of the following hold:

1. Every `CR-##` above is either closed with a break-verified test, or explicitly deferred in this document with
   a named reason and the mutation that would close it. No silent omissions.
2. Each of the seven W1 items has an accepted ADR, and the ADRs land in dependency order.
3. Every canonical document that promised behaviour listed here says what the code now does — in particular the
   claims about crash-safe resume, duplicate-free effects, bounded streams, first-branch-wins, schema-validated
   input/output, and session-to-workflow graduation.
4. `pnpm run ci` exits 0, checked by exit code.
5. A closing register in this file states, per item, the code that closes it — verified by reading the code, not
   by trusting the mark. Wave 1's completion claim was wrong twice before this discipline was adopted.

## Scope note

Two items already in flight are NOT part of this phase and keep their own tracking: the durable per-attempt
realized-cost ledger (accepted ADR, staged implementation) and the transaction-handle cleanup across the
remaining database stores. They are listed here only so nobody schedules them twice.
